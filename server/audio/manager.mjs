import fs from 'node:fs';
import { fork, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { applyEvent } from '../core/events.mjs';
import { captureRuntimeReady } from './capture-runtime.mjs';

const execute = promisify(execFile);
export class LocalAudio {
  constructor(db, { getSubtitle, mode = () => 'fallback', resolvePid } = {}) {
    this.db = db; this.getSubtitle = getSubtitle; this.mode = mode; this.contexts = new Map(); this.pending = new Map(); this.subtitles = new Map();
    this.resolvePid = resolvePid || (async (input) => JSON.parse((await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./player-process.ps1', import.meta.url)), '-Source', input.source === 'desktop' ? 'desktop' : 'browser', '-PlayerProcessId', String(input.source === 'desktop' && Number.isInteger(input.processId) ? input.processId : 0)], { windowsHide: true, timeout: 8000 })).stdout).pid);
    this.state = 'standby'; this.error = null; this.active = null; this.desired = null; this.serial = Promise.resolve(); this.closed = false;
  }
  view() { return { mode: this.mode(), state: this.state, error: this.error, ready: captureRuntimeReady() && ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx'].every(n => fs.existsSync(new URL('../../models/sensevoice/' + n, import.meta.url))), pending: this.pending.size }; }
  observe(input, segment, valid) {
    this.lastSeen = Date.now();
    this.desired = valid && segment && this.mode() !== 'off' ? { input: { ...input }, jobId: segment.id } : null;
    if (this.reconciling) return;
    this.reconciling = true;
    const reconcile = async () => {
      const desired = this.desired;
      if (!desired) { if (this.active) await this.stop(this.active); return; }
      const { input, jobId } = desired;
      if (this.active?.jobId === jobId && this.active.rate === input.rate) return;
      if (this.active) await this.stop(this.active);
      const key = input.url;
      if (this.mode() === 'fallback') {
        if (!this.subtitles.has(key)) this.subtitles.set(key, this.getSubtitle(segment.bvid, segment.page).catch(() => ({ ok: false })));
        if ((await this.subtitles.get(key)).ok) { this.state = 'subtitle-preferred'; this.error = null; return; }
      }
      const pid = await this.resolvePid(input);
      if (this.closed || this.desired !== desired) return;
      if (!this.view().ready) throw new Error('本地音频模型或采集扩展未就绪，请运行Setup-Audio.ps1');
      this.ensureWorkers(); const epoch = randomUUID();
      const context = { epoch, jobId, pid, rate: input.rate, from: input.position, chunks: [], bytes: 0, offset: 0, jobs: new Set() };
      this.contexts.set(epoch, context); this.active = context; this.state = 'recording'; this.error = null;
      this.capture.send({ type: 'start', epoch, pid });
    };
    reconcile().catch(e => {
      const waiting = /Foreground .* changed/.test(e.message);
      this.error = waiting ? '尚未确认前台B站播放器，音频采集暂未开始。' : e.message.split('\n')[0].slice(0, 240);
      this.state = waiting ? 'waiting-player' : 'failed';
    }).finally(() => { this.reconciling = false; });
  }
  ensureWorkers() {
    const options = { windowsHide: true, serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] };
    if (!this.capture) {
      this.capture = fork(fileURLToPath(new URL('./capture-worker.mjs', import.meta.url)), [], options);
      this.capture.on('message', (m) => {
        const c = this.contexts.get(m.epoch); if (!c) return;
        if (m.type === 'pcm') { c.chunks.push(m.pcm); c.bytes += m.pcm.length; if (c.bytes >= 640000) this.flush(c); }
        if (m.type === 'stopped') { this.flush(c, true); c.stopped?.(); }
        if (m.type === 'error') { this.error = m.error; this.state = 'failed'; c.failed = true; c.stopped?.(); }
      });
      this.capture.on('exit', () => { if (!this.closed) { this.error = '应用音频采集进程退出'; this.state = 'failed'; } for (const c of this.contexts.values()) { c.failed = true; c.stopped?.(); } this.capture = null; });
      this.capture.on('error', e => { this.error = e.message; this.state = 'failed'; });
      this.capture.stderr.resume();
    }
    if (!this.asr) {
      this.asr = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], options);
      this.asr.on('message', (m) => { const entry = this.pending.get(m.id); if (!entry) return; this.pending.delete(m.id); m.error ? entry.reject(new Error(m.error)) : entry.resolve(m.result); });
      this.asr.on('exit', () => { for (const entry of this.pending.values()) entry.reject(new Error('本地语音识别进程退出')); this.pending.clear(); this.asr = null; });
      this.asr.on('error', e => { this.error = e.message; this.state = 'failed'; });
      this.asr.stderr.resume();
    }
  }
  flush(c, final = false) {
    if (c.finalSent || (!c.bytes && !final)) return;
    if (final) c.finalSent = true;
    const pcm = Buffer.concat(c.chunks), offset = c.offset; c.offset += pcm.length / 2; c.chunks = []; c.bytes = 0;
    if (this.pending.size >= 8) { c.failed = true; this.error = '本地转写积压过多，当前音频段不可用于出题'; this.asr?.send({ type: 'discard', epoch: c.epoch }); return; }
    const id = randomUUID();
    const task = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('本地转写超时')); this.asr?.kill(); }, 90000);
      this.pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } }); this.asr.send({ id, epoch: c.epoch, pcm, offset, final });
    });
    c.jobs.add(task.then(result => {
      const cues = result.cues.map(cue => ({ ...cue, from: c.from + cue.from * c.rate, to: c.from + cue.to * c.rate }));
      applyEvent(this.db, { type: 'audio.transcribed', payload: { jobId: c.jobId, epoch: c.epoch, engine: 'sensevoice-int8-silero', timing: 'continuous-vad-utterance-estimate', segmentation: 'continuous-vad-v1', final, from: c.from + offset / 16000 * c.rate, duration: result.duration, inferenceSeconds: result.inferenceSeconds, cues } });
    }).catch(e => { c.failed = true; this.error = e.message; this.state = 'failed'; }));
  }
  stop(c) {
    if (c.stopTask) return c.stopTask;
    c.stopTask = this.stopOnce(c); return c.stopTask;
  }
  async stopOnce(c) {
    if (this.active === c) this.active = null;
    if (!this.capture?.connected) { this.flush(c, true); return; }
    await new Promise(resolve => { const timer = setTimeout(() => { c.failed = true; resolve(); }, 10000); c.stopped = () => { clearTimeout(timer); resolve(); }; this.capture.send({ type: 'stop', epoch: c.epoch }); });
    if (!this.active) this.state = 'transcribing';
  }
  close(jobId) {
    if (this.desired?.jobId === jobId) this.desired = null;
    const c = this.active;
    if (c?.jobId === jobId) this.serial = this.serial.then(() => this.stop(c));
  }
  async forJob(jobId) {
    await this.serial;
    const contexts = [...this.contexts.values()].filter(c => c.jobId === jobId);
    await Promise.allSettled(contexts.flatMap(c => [...c.jobs]));
    if (contexts.some(c => c.failed)) throw new Error(this.error || '音频片段不完整');
    const cues = this.db.prepare("SELECT payload_json FROM events WHERE type='audio.transcribed' AND json_extract(payload_json,'$.jobId')=? ORDER BY rowid").all(jobId).flatMap(r => JSON.parse(r.payload_json).cues).sort((a,b) => a.from - b.from);
    if (!cues.length) throw new Error('尚无有效的本地转写，请在开启采集后播放有声音的课程');
    for (const c of contexts) this.contexts.delete(c.epoch);
    this.state = 'ready'; return cues;
  }
  tick() { if (Date.now() - this.lastSeen > 8000) this.desired = null; if (this.active && (!this.desired || this.closed)) this.close(this.active.jobId); }
  shutdown() { this.closed = true; this.capture?.kill(); this.asr?.kill(); }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { UtteranceStream } from '../server/audio/utterances.mjs';
import { LocalAudio } from '../server/audio/manager.mjs';
import { m2Fixture } from './m2-fixture.mjs';
import { patchCapture } from '../server/audio/native/prepare.mjs';
import fs from 'node:fs';

// A deterministic detector lets these tests exercise transport boundaries,
// timestamps, and sample retention without depending on model predictions.
class Detector {
  position = 0; start = null; end = 0; quiet = 0; queue = [];
  acceptWaveform(samples) {
    assert.equal(samples.length, 512);
    if (samples.some(v => v !== 0)) {
      this.start ??= this.position; this.end = this.position + samples.length; this.quiet = 0;
    } else if (this.start !== null && ++this.quiet >= 2) this.flush();
    this.position += samples.length;
  }
  flush() {
    if (this.start !== null) this.queue.push({ start: this.start, samples: { length: this.end - this.start } });
    this.start = null; this.quiet = 0;
  }
  isEmpty() { return this.queue.length === 0; }
  isDetected() { return this.start !== null; }
  reset() { this.position = 0; this.start = null; this.end = 0; this.quiet = 0; this.queue = []; }
  front() { return this.queue[0]; }
  pop() { this.queue.shift(); }
}
const session = () => new UtteranceStream({ vad: new Detector(), decode: samples => `${samples.length}:${samples.filter(v => v !== 0).length}` });
function audio(seconds, from, to) {
  const pcm = Buffer.alloc(seconds * 32000);
  for (let i = from * 16000; i < to * 16000; i++) pcm.writeInt16LE(10000, i * 2);
  return pcm;
}

test('固定版本原生补丁保留静音及低音量PCM，显式静音使用等长零帧；未知源码拒绝猜改', () => {
  const source = fs.readFileSync(new URL('../node_modules/loopback-capture/src/platform/windows/LoopbackCapture.cpp', import.meta.url), 'utf8');
  const patched = patchCapture(source);
  assert.ok(!patched.includes('&& !IsBufferSilent(Data,'));
  assert.match(patched, /dwCaptureFlags & AUDCLNT_BUFFERFLAGS_SILENT/);
  assert.match(patched, /std::vector<BYTE> silence\(byteCount, 0\)/);
  assert.match(patched, /EmitAudioData\(Data, static_cast<UINT32>\(byteCount\)\)/);
  assert.throws(() => patchCapture(patched), /refusing to patch/);
});

test('跨20秒传输边界的同一句只识别一次，与完整输入的内容和时间一致', () => {
  const pcm = audio(24, 19, 22), whole = session().push(pcm, { final: true });
  const stream = session(), first = stream.push(pcm.subarray(0, 640000));
  assert.deepEqual(first.cues, []);
  const second = stream.push(pcm.subarray(640000), { offset: 320000, final: true });
  assert.deepEqual(second.cues, whole.cues);
  assert.equal(second.cues.length, 1);
  assert.ok(second.cues[0].from < 20 && second.cues[0].to > 20);
  assert.throws(() => stream.push(Buffer.alloc(0), { final: true }), /已结束/);
});

test('最后不足一个VAD窗口的语音在停止时排空，补零不增加实际时间', () => {
  const pcm = Buffer.alloc(317 * 2); pcm.fill(1);
  const stream = session(); assert.deepEqual(stream.push(pcm).cues, []);
  const result = stream.push(Buffer.alloc(0), { final: true });
  assert.deepEqual(result.cues, [{ from: 0, to: 317 / 16000, text: '317:317' }]);
  assert.equal(result.duration, 0); assert.equal(stream.samples.length, 0);
});

test('长时间静音的缓存有界；后来的语音保持原始时间，不与其他流混合', () => {
  const a = session(), b = session();
  for (let i = 0; i < 6; i++) {
    assert.deepEqual(a.push(Buffer.alloc(320000)).cues, []);
    assert.ok(a.samples.length <= 26 * 16000 + 511);
  }
  const late = a.push(audio(2, 0, 1), { final: true });
  assert.equal(late.cues.length, 1); assert.ok(late.cues[0].from >= 59.8);
  assert.equal(b.push(audio(2, 0, 1), { final: true }).cues[0].from, 0);
});

test('长时间不间断讲话仍有有界切段，重置检测器后保持全局时间且不漏采样', () => {
  const stream = session(), cues = [];
  for (let i = 0; i < 4; i++) cues.push(...stream.push(audio(20, 0, 20)).cues);
  cues.push(...stream.push(Buffer.alloc(0), { final: true }).cues);
  assert.equal(cues.length, 4); assert.equal(cues[0].from, 0);
  assert.equal(cues.at(-1).to, 80);
  for (let i = 1; i < cues.length; i++) assert.equal(cues[i].from, cues[i - 1].to);
  const recognizedSamples = cues.reduce((sum, c) => sum + Number(c.text.split(':')[1]), 0);
  assert.equal(recognizedSamples, 80 * 16000);
});

test('拒绝缺失、乱序或错误PCM，不把不连续音频拼成一句话', () => {
  const stream = session(); stream.push(Buffer.alloc(1024));
  assert.throws(() => stream.push(Buffer.alloc(1024), { offset: 0 }), /不连续/);
  assert.throws(() => stream.push(Buffer.alloc(3)), /格式或长度/);
  assert.throws(() => stream.push(Buffer.alloc(960002)), /格式或长度/);
  assert.equal(stream.received, 512);
});

test('音频批次恰好发完也发送一次停止排空；跨批语句按整条流和倍速映射', async () => {
  const f = m2Fixture(), manager = new LocalAudio(f.db), sent = [];
  try {
    manager.asr = { send(message) {
      sent.push(message);
      queueMicrotask(() => {
        const entry = manager.pending.get(message.id); manager.pending.delete(message.id);
        entry.resolve({ duration: message.pcm.length / 32000, inferenceSeconds: 0,
          cues: message.final ? [{ from: 19, to: 20, text: '尚未结束的原始术语M帽' }] : [] });
      });
    } };
    const c = { jobId: 'isolated-stream-test', epoch: 'first', from: 100, rate: 2,
      offset: 0, chunks: [Buffer.alloc(640000)], bytes: 640000, jobs: new Set() };
    manager.flush(c); manager.flush(c, true); manager.flush(c, true);
    await Promise.all(c.jobs);
    assert.equal(sent.length, 2); assert.equal(sent[1].pcm.length, 0);
    assert.equal(sent[1].offset, 320000); assert.equal(sent[1].final, true);
    const rows = f.db.prepare("SELECT payload_json FROM events WHERE type='audio.transcribed' ORDER BY rowid").all().map(r => JSON.parse(r.payload_json));
    assert.equal(rows[1].segmentation, 'continuous-vad-v1');
    assert.deepEqual(rows[1].cues, [{ from: 138, to: 140, text: '尚未结束的原始术语M帽' }]);
    assert.equal(manager.pending.size, 0);
  } finally { f.db.close(); }
});

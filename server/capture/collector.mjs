// M3：播放器观测 -> 已观看范围 -> 自动学习段。没有截图、音频或模型调用。
import { randomUUID } from 'node:crypto';
import { applyEvent } from '../core/events.mjs';
import { upsertCourse, saveSource, createSession, buildContent, attachContent, addSegments, planSegments, updateSourceQuality } from '../core/store.mjs';
import { fetchVideo, fetchSubtitle, assessSubtitles } from '../sources/bilibili.mjs';
import { normalizeSubject, suggestSubject } from '../core/subjects.mjs';

const defaults = { enabled: false, autoConfirm: false, allowed: [], blocked: [], titleBlocklist: [], segmentSeconds: 480, minimumSeconds: 30, leaveSeconds: 45, desktopEnabled: false, desktopBinding: null, audioMode: 'fallback', captureMode: 'auto' };
const events = (db, type) => db.prepare('SELECT payload_json,created_at,rowid AS sequence FROM events WHERE type=? ORDER BY rowid DESC').all(type).map((r) => ({ ...JSON.parse(r.payload_json), at: r.created_at, sequence: r.sequence }));
export function videoIdentity(value) {
  if (typeof value !== 'string') return null;
  if (/^BV[a-zA-Z0-9]{10}$/.test(value)) return { bvid: value, page: 1 };
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['www.bilibili.com', 'bilibili.com'].includes(url.hostname)) return null;
    const match = url.pathname.match(/^\/video\/(BV[a-zA-Z0-9]{10})\/?$/);
    const page = Number(url.searchParams.get('p') || 1);
    return match && Number.isInteger(page) && page >= 1 && page <= 10000 ? { bvid: match[1], page } : null;
  } catch { return null; }
}
function config(db) { return { ...defaults, ...(events(db, 'capture.configured')[0]?.config || {}) }; }
export function captureJobs(db) {
  const stages = new Map();
  for (const type of ['capture.imported', 'capture.failed']) for (const row of events(db, type)) {
    const old = stages.get(row.jobId);
    if (!old || row.sequence > old.sequence) stages.set(row.jobId, { ...row, stage: type === 'capture.imported' ? 'prepared' : 'failed' });
  }
  return events(db, 'capture.queued').map((job) => {
    const result = { ...job, stage: 'queued', ...stages.get(job.jobId) };
    result.hasQuestions = !!result.sessionId && !!db.prepare('SELECT k.id FROM cards k JOIN segments g ON g.id=k.segment_id WHERE g.session_id=? AND k.discarded=0 LIMIT 1').get(result.sessionId);
    return result;
  });
}
export function mergeRange(ranges, from, to) {
  const sorted = [...ranges, [from, to]].sort((a, b) => a[0]-b[0]), merged = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + .25) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}
export function watchedCues(cues, ranges) {
  return cues.filter((c) => Number.isFinite(c.from) && Number.isFinite(c.to) && c.to > c.from && ranges.some(([a,b]) => c.from >= a && c.to <= b));
}
export class Collector {
  constructor(db, { now = Date.now, getVideo = fetchVideo, getSubtitle = fetchSubtitle, audio = null } = {}) {
    this.audio = audio;
    this.db = db; this.now = now; this.getVideo = getVideo; this.getSubtitle = getSubtitle;
    this.settings = config(db); this.active = null; this.previous = null; this.candidate = null; this.lastSeen = null; this.state = this.settings.enabled ? 'disconnected' : 'disabled'; this.inflight = new Set();
    this.diagnostics = events(db, 'capture.control-stopped')[0]?.diagnostics || { observations: 0, valid: 0, reasons: {}, lastIssue: null };
    // 构造和读取接口不写库。重启时只恢复自己的最后检查点，缺失时间不计入观看。
    const saved = events(db, 'capture.checkpoint')[0];
    if (saved && !db.prepare('SELECT id FROM events WHERE dedupe_key=?').get('capture-close:'+saved.segment.id)) this.active = saved.segment;
    this.lastSource = this.active?.source || null;
  }
  view() {
    return { config: this.settings, state: this.state, source: this.lastSource, lastSeen: this.lastSeen, candidate: this.candidate, diagnostics: this.diagnostics,
      active: this.active ? { bvid: this.active.bvid, page: this.active.page, source: this.active.source || 'browser', seconds: this.active.seconds, ranges: this.active.ranges } : null,
      jobs: captureJobs(this.db).slice(0, 30),
      knownCourses: this.db.prepare("SELECT external_id AS bvid,title,axis FROM courses WHERE platform='bilibili'").all() };
  }
  configure(patch) {
    const next = { ...this.settings };
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'enabled' && typeof value === 'boolean') next.enabled = value;
      else if(key==='captureMode'&&['auto','video','reading','chatgpt','codex'].includes(value)){
        if(this.settings.enabled&&value!==this.settings.captureMode)throw new Error('请先结束采集，再切换采集场景');next.captureMode=value;
      }
      else if (key === 'audioMode' && ['fallback', 'force', 'off'].includes(value)) {
        if (this.settings.enabled && value !== this.settings.audioMode) throw new Error('请先结束采集，再更改内容来源');
        next.audioMode = value;
      }
      else if (key === 'autoConfirm' && typeof value === 'boolean') next.autoConfirm = value;
      else if (key === 'desktopEnabled' && typeof value === 'boolean') next.desktopEnabled = value;
      else if (key === 'desktopBinding' && (value === null || value && /^[a-f0-9]{64}$/.test(value.signature) && videoIdentity(value.bvid)?.bvid === value.bvid && Number.isInteger(value.page) && value.page >= 1 && value.page <= 10000)) next.desktopBinding = value === null ? null : { signature: value.signature, bvid: value.bvid, page: value.page };
      else if (key === 'allowed' && Array.isArray(value) && value.length <= 200) {
        next.allowed = value.map((entry) => {
          const axis = normalizeSubject(entry?.axis);
          if (!entry?.bvid || videoIdentity(entry.bvid)?.bvid !== entry.bvid || !axis) throw new Error('请输入有效的课程BV号和学科名称（最多32字）');
          return { bvid: entry.bvid, axis };
        });
      } else if (key === 'blocked' && Array.isArray(value) && value.length <= 200 && value.every((v) => videoIdentity(v)?.bvid === v)) next.blocked = [...new Set(value)];
      else if (key === 'titleBlocklist' && Array.isArray(value) && value.length <= 50 && value.every((v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 60)) next.titleBlocklist = value.map((v) => v.trim());
      else throw new Error('不支持的采集设置');
    }
    if (JSON.stringify(next) === JSON.stringify(this.settings)) return this.view();
    if (!this.settings.enabled && next.enabled) this.diagnostics = { observations: 0, valid: 0, reasons: {}, lastIssue: null };
    if (this.active) this.close('settings-changed');
    this.previous = null; this.candidate = null; this.lastSource = null; this.settings = next;
    applyEvent(this.db, { type: 'capture.configured', payload: { config: next }, at: this.now() });
    this.state = next.enabled ? 'waiting' : 'disabled';
    return this.view();
  }
  observe(input) {
    if(this.settings.enabled&&this.reading?.selectedForRun)return this.view();
    const source = input.source === 'desktop' ? 'desktop' : 'browser';
    if (input.focused !== true && this.lastSource && source !== this.lastSource) return this.view();
    const now = this.now(); this.lastSeen = now;
    if (!this.settings.enabled) { this.state = 'disabled'; this.audio?.observe(input, null, false); return this.view(); }
    if (input.focused === true) {
      if (this.lastSource && this.lastSource !== source) { this.close('source-changed'); this.previous = null; }
      this.lastSource = source;
    }
    const identity = videoIdentity(input.url);
    const title = typeof input.title === 'string' ? input.title.slice(0,300) : '';
    const blocked = identity && (this.settings.blocked.includes(identity.bvid) || this.settings.titleBlocklist.some((s) => title.toLowerCase().includes(s.toLowerCase())));
    const allowed = identity && (this.settings.allowed.find((a) => a.bvid === identity.bvid) || (this.settings.autoConfirm ? { axis: '待识别' } : null));
    this.candidate = identity && !allowed && !blocked ? { ...identity, title, suggestedSubject: suggestSubject(title) } : null;
    const valid = identity && !blocked && allowed && input.focused === true && input.visible === true && (input.playing === true || input.ended === true) && input.idleState !== 'locked' && Number.isFinite(input.position) && input.position >= 0 && Number.isFinite(input.rate) && input.rate >= .25 && input.rate <= 4;
    const issue = blocked ? '当前视频已排除' : !identity ? '未识别到课程' : !allowed ? '课程尚未确认' : input.idleState === 'locked' ? '系统已锁屏' : input.focused !== true ? '播放器不在前台' : input.visible !== true ? '播放器页面报告不可见' : !(input.playing || input.ended) ? '播放器暂停或播放状态未识别' : !Number.isFinite(input.position) ? '播放进度未读到' : !valid ? '播放倍速或进度无效' : null;
    this.diagnostics.observations++; if (valid) this.diagnostics.valid++;
    this.diagnostics.lastIssue = issue;
    if (issue) this.diagnostics.reasons[issue] = (this.diagnostics.reasons[issue] || 0) + 1;
    this.state = blocked ? 'blocked' : !identity ? 'outside' : !allowed ? 'needs-confirmation' : valid ? 'watching' : 'paused';
    if (!valid) { this.audio?.observe(input, this.active, false); this.previous = null; if (this.active && identity && this.active.bvid+':'+this.active.page !== identity.bvid+':'+identity.page) this.close('course-changed'); this.tick(); return this.view(); }
    const key = identity.bvid+':'+identity.page;
    if (this.active && (this.active.bvid+':'+this.active.page !== key)) this.close('course-changed');
    const old = this.previous;
    this.previous = { key, position: input.position, at: now, rate: input.rate };
    if (old && old.key === key) {
      const elapsed = (now-old.at)/1000, media = input.position-old.position;
      if (elapsed > 0 && elapsed <= 15 && media > 0 && media <= elapsed*Math.max(input.rate,old.rate)+2) {
        if (!this.active) this.active = { id: randomUUID(), ...identity, title, source, axis: allowed.axis, audioMode: this.settings.audioMode, startedAt: old.at, lastAt: now, checkpointAt: 0, seconds: 0, ranges: [] };
        this.active.ranges = mergeRange(this.active.ranges, old.position, input.position);
        this.active.seconds += Math.min(elapsed, media / Math.max(.25, Math.min(input.rate,old.rate)));
        this.active.lastAt = now;
        if (now-this.active.checkpointAt >= 30000) {
          this.active.checkpointAt = now;
          applyEvent(this.db, { type: 'capture.checkpoint', payload: { segment: this.active }, at: now });
        }
        if (this.active.seconds >= this.settings.segmentSeconds) this.close('segment-limit');
      } else if (elapsed > 15 || media < 0 || media > elapsed*Math.max(input.rate,old.rate)+2) this.close('seek-or-gap');
    }
    if (input.ended === true) { this.close('video-ended'); this.previous = null; }
    this.audio?.observe(input, this.active, true);
    return this.view();
  }
  tick() {
    this.audio?.tick();
    if (this.active && this.now()-this.active.lastAt >= this.settings.leaveSeconds*1000) { this.close('away'); this.previous = null; }
    if (this.settings.enabled && this.lastSeen && this.now()-this.lastSeen > 20000) { this.state = 'disconnected'; this.diagnostics.lastIssue = '播放信号已断开'; }
  }
  close(reason) {
    const segment = this.active; if (!segment) return;
    this.active = null;
    this.audio?.close(segment.id);
    applyEvent(this.db, { type: segment.seconds >= this.settings.minimumSeconds ? 'capture.queued' : 'capture.skipped',
      payload: { ...segment, jobId: segment.id, reason, endedAt: segment.lastAt }, at: this.now(), dedupeKey: 'capture-close:'+segment.id });
  }
  async prepare(jobId, retry = false) {
    const job = captureJobs(this.db).find((j) => j.jobId === jobId);
    if (!job) throw new Error('采集段不存在');
    if (job.stage === 'prepared' || this.inflight.has(jobId) || job.stage === 'failed' && !retry) return job;
    this.inflight.add(jobId);
    try {
      const video = await this.getVideo(job.bvid);
      const page = video.pages.find((p) => p.page === job.page);
      if (!page) throw new Error('page not found');
      let subtitle = null, sourceKind = 'bilibili-cc'; const audioMode = job.audioMode || 'fallback';
      if (audioMode !== 'force') { try { subtitle = await this.getSubtitle(job.bvid, job.page); } catch { /* Captured local audio may provide the fallback. */ } }
      let captured = subtitle?.cues;
      if (!subtitle?.ok || audioMode === 'force') {
        if (!this.audio || audioMode === 'off') throw new Error('subtitle unavailable');
        captured = await this.audio.forJob(jobId); sourceKind = 'bilibili-local-asr';
      }
      const cues = watchedCues(captured, job.ranges);
      if (!cues.length) throw new Error('no fully watched cues');
      const quality = assessSubtitles(cues);
      if (sourceKind === 'bilibili-local-asr' && quality.verdict !== 'ok') throw new Error('本地转写质量不足：' + quality.verdict);
      this.db.exec('BEGIN IMMEDIATE');
      let sessionId;
      try {
        const existing = captureJobs(this.db).find((j) => j.jobId === jobId && j.stage === 'prepared');
        if (existing) { this.db.exec('COMMIT'); return existing; }
        const course = upsertCourse(this.db, { platform: 'bilibili', externalId: job.bvid, title: video.title, axis: job.axis });
        const sourceId = saveSource(this.db, { courseId: course.id, kind: sourceKind, status: 'ok', quality: { overall: quality }, detail: JSON.stringify({ captureJob: jobId, page: job.page, ranges: job.ranges, ...(sourceKind === 'bilibili-local-asr' ? { engine: 'sensevoice-int8-silero', timing: 'vad-utterance-estimate', needsReview: true } : {}) }) });
        sessionId = createSession(this.db, { courseId: course.id, sourceId, startedAt: job.startedAt });
        const content = buildContent({ sessionId, sourceKind, parts: cues.map((c) => ({ ts: c.from, text: c.text })) });
        attachContent(this.db, sessionId, content); addSegments(this.db, sessionId, content);
        updateSourceQuality(this.db, sourceId, { overall: quality, segments: planSegments(content).map((g) => assessSubtitles(cues.slice(g.cueStart,g.cueEnd))) });
        applyEvent(this.db, { type: 'capture.imported', payload: { jobId, sessionId, courseId: course.id, bvid: job.bvid, page: job.page, partTitle: page.part || null, duration: page.duration ?? null, cueCount: cues.length, sourceKind }, dedupeKey: 'capture-import:'+jobId, at: this.now() });
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      return captureJobs(this.db).find((j) => j.jobId === jobId);
    } catch (error) {
      applyEvent(this.db, { type: 'capture.failed', payload: { jobId, message: '课程材料未能准备：' + String(error.message).slice(0, 220) + '。仅使用已采集的字幕或音频，可检查后重试。' }, at: this.now() });
      return captureJobs(this.db).find((j) => j.jobId === jobId);
    } finally { this.inflight.delete(jobId); }
  }
  async drain() {
    if (this.drainTask) return this.drainTask;
    this.drainTask = (async () => {
      let queued = captureJobs(this.db).filter((j) => j.stage === 'queued').reverse();
      while (queued.length) {
        for (const job of queued) await this.prepare(job.jobId);
        queued = captureJobs(this.db).filter((j) => j.stage === 'queued' && !this.inflight.has(j.jobId)).reverse();
      }
    })();
    try { await this.drainTask; }
    finally { this.drainTask = null; }
  }
}

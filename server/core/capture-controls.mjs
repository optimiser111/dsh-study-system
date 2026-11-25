import { randomUUID } from 'node:crypto';
import { applyEvent } from './events.mjs';
import { captureJobs } from '../capture/collector.mjs';
import { createSession, saveSource, attachContent, loadContent } from './store.mjs';

const QUEUE_TIMEOUT = 300000;
const EXECUTION_TIMEOUT = 240000;
const events = (db, type) => db.prepare('SELECT payload_json,created_at,rowid sequence FROM events WHERE type=? ORDER BY rowid DESC')
  .all(type).map((r) => ({ ...JSON.parse(r.payload_json), at: r.created_at, sequence: r.sequence }));

function legacyAbstention(db, request, result) {
  const segments = db.prepare('SELECT id FROM segments WHERE session_id=?').all(request.sessionId);
  const declined = events(db, 'abstained').filter(r => r.sessionId === request.sessionId && r.sequence > request.sequence && r.sequence < result.sequence);
  if (!segments.length || !segments.every(s => declined.some(r => r.segmentId === s.id))) return null;
  return [...new Set(declined.map(r => r.reason).filter(Boolean))].join('；').slice(0, 800);
}
function taskState(db, request, now) {
  const result = events(db, 'generation.finished').find((r) => r.id === request.id);
  const hasCards = db.prepare('SELECT 1 FROM cards k JOIN segments g ON g.id=k.segment_id WHERE g.session_id=? AND k.discarded=0 LIMIT 1').get(request.sessionId);
  if (result) {
    const declined = !hasCards && (result.outcome === 'abstained' ? result.reason : !result.outcome ? legacyAbstention(db, request, result) : null);
    if (declined) return { ...request, state: 'no-questions', reason: declined };
    return { ...request, state: result.failed ? 'failed' : 'completed', ...(result.reason ? { reason: result.reason } : {}) };
  }
  if (hasCards) return { ...request, state: 'completed' };
  const claim = events(db, 'generation.claimed').find((r) => r.id === request.id);
  if (claim) {
    return now - claim.at >= EXECUTION_TIMEOUT
      ? { ...request, state: 'failed', reason: '出题执行已超时或被中断，可重新出题。' }
      : { ...request, state: 'processing', startedAt: claim.at };
  }
  return now - request.at >= QUEUE_TIMEOUT
    ? { ...request, state: 'failed', reason: 'DSH未在5分钟内接单，请重开DSH后重试。' }
    : { ...request, state: 'queued', reason: '等待DSH接单' };
}
export function generationQueue(db, now = Date.now()) {
  return events(db, 'generation.requested').filter((r) => taskState(db, r, now).state === 'queued').reverse();
}
export function generationState(db, now = Date.now()) {
  const request = events(db, 'generation.requested')[0];
  if (!request) return null;
  const state = taskState(db, request, now);
  const start = events(db, 'capture.control-started')[0];
  if (start && start.sequence > request.sequence && ['failed', 'completed', 'no-questions'].includes(state.state)) return null;
  return state;
}
export function claimGeneration(db, id, now = Date.now()) {
  const request = events(db, 'generation.requested').find((r) => r.id === id);
  if (!request) throw new Error('出题任务不存在');
  if (taskState(db, request, now).state !== 'queued') return { claimed: false };
  const token = randomUUID();
  const saved = applyEvent(db, { type: 'generation.claimed', payload: { id, token }, at: now, dedupeKey: 'generation-claim:' + id });
  return saved.deduped ? { claimed: false } : { claimed: true, token };
}
export function finishGeneration(db, id, failed, token = null, details = {}) {
  const request = events(db, 'generation.requested').find((r) => r.id === id);
  if (!request || typeof failed !== 'boolean') throw new Error('出题任务无效');
  const finished = events(db, 'generation.finished').find((r) => r.id === id);
  if (finished) return { ok: true, failed: finished.failed };
  const claim = events(db, 'generation.claimed').find((r) => r.id === id);
  if (claim && claim.token !== token) throw new Error('出题任务已由其他执行器领取');
  if (taskState(db, request, Date.now()).state === 'failed') throw new Error('出题任务已过期');
  if (details.outcome && (!['completed', 'abstained', 'failed'].includes(details.outcome) || failed !== (details.outcome === 'failed'))) throw new Error('出题任务结果无效');
  if (details.outcome === 'abstained' && !(typeof details.reason === 'string' && details.reason.trim())) throw new Error('暂不出题须保留原因');
  applyEvent(db, { type: 'generation.finished', payload: { id, failed,
    ...(details.outcome ? { outcome: details.outcome } : {}),
    ...(typeof details.reason === 'string' && details.reason.trim() ? { reason: details.reason.trim().slice(0, 800) } : {}),
  }, dedupeKey: 'generation-result:' + id });
  return { ok: true, failed: events(db, 'generation.finished').find((r) => r.id === id).failed };
}
export function captureReadiness(db, collector) {
  const start = events(db, 'capture.control-started')[0];
  const stop = events(db, 'capture.control-stopped')[0];
  const jobs = captureJobs(db);
  if(start?.kind==='reading'){
    const reading=collector.reading?.view(),finished=events(db,'reading.finished').find(r=>r.runId===start.runId),job=jobs.find(j=>j.jobId===finished?.jobId);
    const recording=collector.settings.enabled;
    return {kind:'reading',seconds:reading?.seconds||job?.seconds||0,characters:reading?.characters||finished?.characters||0,segments:reading?.frames||0,
      canGenerate:!recording&&stop?.runId===start.runId&&job?.stage==='prepared',phase:recording?'recording':job?.stage==='prepared'?'ready':finished?'insufficient':'idle',
      reason:finished?.reason||null,jobId:job?.jobId||null,jobIds:job?[job.jobId]:[]};
  }
  const currentJobs = start ? jobs.filter((j) => !start.previousJobIds.includes(j.jobId)) : [];
  const skipped = start ? events(db, 'capture.skipped').filter(j => j.sequence > start.sequence) : [];
  const seconds = currentJobs.reduce((total, job) => total + job.seconds, collector.active?.seconds || 0) + skipped.reduce((total,j) => total + j.seconds, 0);
  const summary = { seconds, skippedSeconds: skipped.reduce((total,j) => total+j.seconds,0), segments: currentJobs.length + skipped.length + (collector.active ? 1 : 0) };
  if (collector.settings.enabled || !stop || (start && stop.runId !== start.runId)) return { ...summary, canGenerate: false, phase: collector.settings.enabled ? 'recording' : 'idle' };
  const stopped = jobs.filter((j) => stop.jobIds.includes(j.jobId));
  const job = stopped[0];
  const group = job ? stopped.filter((j) => j.bvid === job.bvid && j.page === job.page) : [];
  const phase = !job ? 'insufficient' : group.some((j) => j.stage === 'failed') ? 'failed' : group.every((j) => j.stage === 'prepared') ? 'ready' : 'preparing';
  const diagnostic = collector.diagnostics || stop?.diagnostics;
  const reason = phase === 'insufficient' ? '本轮仅确认 ' + seconds.toFixed(1) + ' 秒有效播放，尚无达到30秒的连续采集段。' + (diagnostic?.lastIssue ? '未计入原因：' + diagnostic.lastIssue + '。' : '') : null;
  return { ...summary, canGenerate: phase === 'ready', phase, reason, jobId: job?.jobId || null, jobIds: group.map((j) => j.jobId) };
}

function batchSession(db, jobs) {
  if (jobs.length === 1) return jobs[0].sessionId;
  const key = 'capture-batch:' + jobs.map((j) => j.jobId).sort().join(',');
  const previous = db.prepare('SELECT payload_json FROM events WHERE dedupe_key=?').get(key);
  if (previous) return JSON.parse(previous.payload_json).sessionId;
  jobs.sort((a, b) => a.startedAt - b.startedAt);
  db.exec('BEGIN IMMEDIATE');
  try {
    const quality = [], chunks = [];
    let text = '', normalizerVersion;
    for (const job of jobs) {
      const content = loadContent(db, job.sessionId);
      if (!content) throw new Error('采集字幕缺失');
      normalizerVersion = content.normalizerVersion;
      if (text) text += '\n';
      const offset = text.length;
      text += content.text;
      const source = db.prepare('SELECT r.quality_json FROM sessions s JOIN sources r ON r.id=s.source_id WHERE s.id=?').get(job.sessionId);
      const originalQuality = JSON.parse(source.quality_json);
      for (const segment of db.prepare('SELECT * FROM segments WHERE session_id=? ORDER BY seq').all(job.sessionId)) {
        chunks.push({ ...segment, span_start: offset + segment.span_start, span_end: offset + segment.span_end });
        quality.push(originalQuality.segments?.[segment.seq] || { verdict: 'unknown' });
      }
    }
    const kinds = [...new Set(chunks.map((c) => c.source_kind))];
    const sourceId = saveSource(db, { courseId: jobs[0].courseId, kind: kinds.length === 1 ? kinds[0] : 'bilibili-capture-mixed', status: 'ok',
      quality: { segments: quality }, detail: JSON.stringify({ captureJobIds: jobs.map((j) => j.jobId) }) });
    const sessionId = createSession(db, { courseId: jobs[0].courseId, sourceId, startedAt: jobs[0].startedAt });
    attachContent(db, sessionId, { text, normalizerVersion });
    for (const [seq, segment] of chunks.entries()) db.prepare('INSERT INTO segments (id,session_id,seq,source_kind,text,span_start,span_end) VALUES (?,?,?,?,?,?,?)')
      .run(randomUUID(), sessionId, seq, segment.source_kind, segment.text, segment.span_start, segment.span_end);
    applyEvent(db, { type: 'capture.batch-prepared', dedupeKey: key, payload: {
      sessionId, jobIds: jobs.map((j) => j.jobId), bvid: jobs[0].bvid, page: jobs[0].page,
    } });
    db.exec('COMMIT');
    return sessionId;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export async function captureAction(db, collector, action, desktop = null) {
  if (action === 'start') {
    if (collector.settings.enabled) return collector.view();
    desktop?.resetPreparation();
    const previousJobIds = captureJobs(db).map((j) => j.jobId);
    const runId=randomUUID(),mode=collector.settings.captureMode||'auto';
    let reading=false;
    if(mode!=='video'&&collector.reading){
      try{reading=await collector.reading.start(runId,mode);}catch(error){if(mode!=='auto')throw error;}
    }
    if(mode==='reading'&&!reading)throw new Error('本机阅读OCR不可用。');
    if(mode==='chatgpt'&&!reading)throw new Error('ChatGPT 对话采集不可用。');
    if(mode==='codex'&&!reading)throw new Error('Codex 对话采集不可用。');
    const view = collector.configure({ enabled: true, desktopEnabled: !reading, autoConfirm: !reading });
    applyEvent(db, { type: 'capture.control-started', payload: { runId, previousJobIds,kind:reading?'reading':'video' } });
    return view;
  }
  if (action === 'stop') {
    if (!collector.settings.enabled&&!collector.reading?.selectedForRun) return collector.view();
    const start = events(db, 'capture.control-started')[0];
    if(start?.kind==='reading')await collector.reading?.stop();
    collector.configure({ enabled: false, desktopEnabled: false, autoConfirm: false });
    await collector.drain();
    const previousIds = new Set(start?.previousJobIds || []);
    const jobIds = captureJobs(db).filter((j) => !previousIds.has(j.jobId)).map((j) => j.jobId);
    applyEvent(db, { type: 'capture.control-stopped', payload: { runId: start?.runId || null, jobIds, diagnostics: collector.diagnostics } });
    return collector.view();
  }
  if (action !== 'questions') throw new Error('采集操作无效');
  if (collector.settings.enabled) throw new Error('请先结束采集，再出题。');
  const ready = captureReadiness(db, collector);
  if (!ready.canGenerate) throw new Error(ready.kind==='reading'?'请先结束阅读采集，至少积累200字正文。':'请先开始采集并结束，至少积累30秒有效播放，等待字幕准备完成。');
  const jobs = captureJobs(db).filter((j) => ready.jobIds.includes(j.jobId));
  const job = jobs[0];
  const sessionId = batchSession(db, jobs);
  const hasQuestions = !!db.prepare('SELECT 1 FROM cards k JOIN segments g ON g.id=k.segment_id WHERE g.session_id=? AND k.discarded=0 LIMIT 1').get(sessionId);
  const lastRequest = events(db, 'generation.requested').find(r => r.sessionId === sessionId);
  const lastState = lastRequest && taskState(db, lastRequest, Date.now());
  if (!hasQuestions && lastState?.state === 'no-questions') return { sessionId, courseId: job.courseId, hasQuestions: false, noQuestions: true, reason: lastState.reason };
  const outstanding = events(db, 'generation.requested').find((r) =>
    r.sessionId === sessionId && ['queued', 'processing'].includes(taskState(db, r, Date.now()).state));
  if (!hasQuestions && !outstanding) {
    applyEvent(db, { type: 'generation.requested', payload: { id: randomUUID(), sessionId, courseId: job.courseId } });
  }
  return { sessionId, courseId: job.courseId, hasQuestions };
}

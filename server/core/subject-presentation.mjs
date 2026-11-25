import { randomUUID } from 'node:crypto';
import { validatePresentation } from '../../plugin/subject-presentation.js';
import { applyEvent } from './events.mjs';
import { studyProgress } from './progress.mjs';
import { normalizeSubject } from './subjects.mjs';

const QUEUED_MS = 300000;
const RUNNING_MS = 120000;
const events = (db, type) => db.prepare('SELECT payload_json,created_at FROM events WHERE type=? ORDER BY rowid DESC').all(type)
  .map(row => ({ ...JSON.parse(row.payload_json), at: row.created_at }));

export function subjectPresentationStatus(db, now = Date.now()) {
  const result = new Map();
  const automatic = db.prepare(`SELECT json_extract(payload_json,'$.subject') subject,
      json_extract(payload_json,'$.presentation') presentation
    FROM events AS research WHERE type='research.completed' AND json_type(payload_json,'$.presentation')='object'
    AND (NOT coalesce(json_extract(payload_json,'$.needsConfirmation'),0) OR EXISTS(
      SELECT 1 FROM events AS confirmation WHERE confirmation.type='research.confirmed'
        AND confirmation.dedupe_key='research-confirm:' || json_extract(research.payload_json,'$.key')))
    ORDER BY rowid`).all();
  for (const item of automatic) {
    if (result.has(item.subject)) continue;
    const presentation = validatePresentation(JSON.parse(item.presentation));
    if (presentation) result.set(item.subject, { presentation });
  }
  const completed = events(db, 'subject-presentation.finished');
  for (const finish of completed.slice().reverse()) {
    if (finish.presentation) result.set(finish.subject, { presentation: finish.presentation });
  }
  const claims = new Map(events(db, 'subject-presentation.claimed').map(claim => [claim.id, claim]));
  const byId = new Map(completed.map(finish => [finish.id, finish]));
  const seen = new Set();
  for (const request of events(db, 'subject-presentation.requested')) {
    if (seen.has(request.subject)) continue;
    seen.add(request.subject);
    const claim = claims.get(request.id);
    const finish = byId.get(request.id);
    const timedOut = now - (claim?.at ?? request.at) >= (claim ? RUNNING_MS : QUEUED_MS);
    const state = finish ? (finish.presentation ? 'completed' : 'failed') : timedOut ? 'failed' : claim ? 'processing' : 'queued';
    const reason = finish?.reason || (timedOut ? '起名任务超时，可以重试。' : undefined);
    result.set(request.subject, { ...result.get(request.subject), id: request.id, state, reason });
  }
  return result;
}

export function requestSubjectPresentation(db, value) {
  const subject = normalizeSubject(value);
  const progress = studyProgress(db).find(item => item.axis === subject);
  if (!progress) throw new Error('请先学习这门学科中的一门课程。');
  const previous = subjectPresentationStatus(db).get(subject);
  if (['queued', 'processing'].includes(previous?.state)) return { id: previous.id, state: previous.state };
  const id = randomUUID();
  applyEvent(db, {type:'subject-presentation.requested', payload:{ id, subject }});
  return { id, state: 'queued' };
}

export function subjectPresentationQueue(db) {
  return [...subjectPresentationStatus(db)].filter(([, item]) => item.state === 'queued').map(([, item]) => ({id:item.id})).reverse();
}

export function claimSubjectPresentation(db, id) {
  const entry = [...subjectPresentationStatus(db)].find(([, item]) => item.id === id && item.state === 'queued');
  if (!entry) return { claimed: false };
  const [subject] = entry;
  const progress = studyProgress(db).find(item => item.axis === subject);
  if (!progress) throw new Error('学科已不存在。');
  const token = randomUUID();
  const claim = applyEvent(db, {type:'subject-presentation.claimed', payload:{id,token}, dedupeKey:'subject-presentation-claim:'+id});
  if (claim.deduped) return { claimed: false };
  const concepts = [...new Set(progress.courses.flatMap(course => course.concepts.map(concept => concept.title)))].slice(0, 10);
  return { claimed: true, token, input: { subject: progress.name, concepts, courses: progress.courses.slice(0,4).map(course => course.title.slice(0,160)) } };
}

export function finishSubjectPresentation(db, id, body) {
  const request = events(db, 'subject-presentation.requested').find(item => item.id === id);
  const claim = events(db, 'subject-presentation.claimed').find(item => item.id === id);
  if (!request || !claim || body.token !== claim.token) throw new Error('起名任务凭据无效。');
  const previous = events(db, 'subject-presentation.finished').find(item => item.id === id);
  if (previous) return { ok: true, saved: !!previous.presentation };
  const current = subjectPresentationStatus(db).get(request.subject);
  if (current?.id !== id || current.state !== 'processing') throw new Error('起名任务已过期。');
  const presentation = validatePresentation(body.presentation, { newCopy: true });
  const reason = body.failed ? '模型暂未返回文案，可以重试。' : '文案格式不完整，可以重试。';
  applyEvent(db, {type:'subject-presentation.finished', payload:{id, subject:request.subject,
    ...(presentation ? {presentation} : {reason})}, dedupeKey:'subject-presentation-finish:'+id});
  return { ok: true, saved: !!presentation };
}

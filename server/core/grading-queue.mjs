import { randomUUID } from 'node:crypto';
import { applyEvent } from './events.mjs';
import { pendingSubjective } from './store.mjs';

const records = (db, type) => db.prepare('SELECT payload_json,created_at FROM events WHERE type=? ORDER BY rowid DESC').all(type)
  .map((r) => ({ ...JSON.parse(r.payload_json), at: r.created_at }));
function pending(db, answerId) {
  const row = db.prepare('SELECT session_id FROM answers WHERE id=?').get(answerId);
  return row && pendingSubjective(db, row.session_id).find((a) => a.answerId === answerId);
}
function state(db, request) {
  const current = pending(db, request.answerId);
  if (!current || (current.dialogue?.turn || 0) !== request.turn) return 'completed';
  const result = records(db, 'grading.finished').find((r) => r.id === request.id);
  if (result) return result.failed ? 'failed' : 'completed';
  const claim = records(db, 'grading.claimed').find((r) => r.id === request.id);
  if (Date.now() - (claim?.at || request.at) > (claim ? 120000 : 300000)) return 'failed';
  return claim ? 'processing' : 'queued';
}
export function gradingStatus(db, answerId) {
  const current = pending(db, answerId);
  if (!current) return null;
  const request = records(db, 'grading.requested').find((r) => r.answerId === answerId && r.turn === (current.dialogue?.turn || 0));
  return request ? { state: state(db, request), turn: request.turn } : null;
}
export function requestGrading(db, answerId) {
  const current = pending(db, answerId);
  if (!current) return { state: 'completed' };
  const turn = current.dialogue?.turn || 0;
  const previous = records(db, 'grading.requested').find((r) => r.answerId === answerId && r.turn === turn);
  if (previous && state(db, previous) !== 'failed') return { state: state(db, previous) };
  const sessionId = db.prepare('SELECT session_id FROM answers WHERE id=?').get(answerId).session_id;
  applyEvent(db, { type: 'grading.requested', payload: { id: randomUUID(), answerId, sessionId, turn } });
  return { state: 'queued' };
}
export function gradingQueue(db) {
  return records(db, 'grading.requested').filter((r) => state(db, r) === 'queued').reverse();
}
export function claimGrading(db, id) {
  const request = records(db, 'grading.requested').find((r) => r.id === id);
  if (!request || state(db, request) !== 'queued') return { claimed: false };
  const token = randomUUID();
  const saved = applyEvent(db, { type: 'grading.claimed', payload: { id, token }, dedupeKey: 'grading-claim:' + id });
  return saved.deduped ? { claimed: false } : { claimed: true, token };
}
export function finishGrading(db, id, { token, failed }) {
  const claim = records(db, 'grading.claimed').find((r) => r.id === id);
  if (!claim || claim.token !== token || typeof failed !== 'boolean') throw new Error('判卷任务凭据无效');
  applyEvent(db, { type: 'grading.finished', payload: { id, failed }, dedupeKey: 'grading-result:' + id });
  return { ok: true };
}

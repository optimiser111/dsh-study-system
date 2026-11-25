import { applyEvent } from './events.mjs';
import { evaluateGrade } from '../../plugin/grading.js';
import { validateJudgment, MAX_FOLLOWUPS, DIALOGUE_VERSION } from '../../plugin/dialogue.js';

export function dialogueState(db, answerId) {
  const row = db.prepare(`SELECT a.*,k.question,k.rubric_json AS card_rubric,k.kind,k.prompt_version
    FROM answers a JOIN cards k ON k.id=a.card_id WHERE a.id=?`).get(answerId);
  if (!row || row.kind !== 'subjective' || row.prompt_version !== 'm1-cards-v7') throw new Error('answer is not enabled for followup');
  const judgments = db.prepare("SELECT payload_json FROM events WHERE type='dialogue.judged' AND json_extract(payload_json,'$.answerId')=? ORDER BY json_extract(payload_json,'$.turn')").all(answerId).map((r) => JSON.parse(r.payload_json));
  const replies = db.prepare("SELECT payload_json FROM events WHERE type='dialogue.replied' AND json_extract(payload_json,'$.answerId')=? ORDER BY json_extract(payload_json,'$.turn')").all(answerId).map((r) => JSON.parse(r.payload_json));
  const last = judgments.at(-1);
  const pending = !last || (last.status === 'awaiting-followup' && replies.some((r) => r.turn === last.turn + 1));
  return { answerId, sessionId: row.session_id, question: row.question, raw: row.raw, rubric: JSON.parse(row.card_rubric),
    turn: replies.length, replies, judgments, status: pending ? 'pending-model' : last.status,
    passed: pending || last?.status === 'awaiting-followup' ? null : last.passed,
    nextTurn: last?.status === 'awaiting-followup' ? last.turn + 1 : null,
    followup: last?.status === 'awaiting-followup' ? last.followup : '',
    recognized: last?.recognized || '', gap: last?.gap || '', points: last?.points || [], note: last?.note || '',
    independent: last?.independent ?? false, version: DIALOGUE_VERSION };
}

export function replyToFollowup(db, answerId, { turn, raw }) {
  if (!Number.isInteger(turn) || typeof raw !== 'string' || !raw.trim()) throw new Error('nonempty reply and integer turn required');
  db.exec('BEGIN IMMEDIATE');
  try {
    const state = dialogueState(db, answerId);
    const existing = state.replies.find((r) => r.turn === turn);
    if (existing) {
      if (existing.raw !== raw) throw new Error('reply already recorded; cannot replace it');
    } else {
      if (state.status !== 'awaiting-followup' || state.nextTurn !== turn || turn > MAX_FOLLOWUPS) throw new Error('no matching open followup');
      applyEvent(db, { type: 'dialogue.replied', dedupeKey: `dialogue-reply:${answerId}:${turn}`,
        payload: { answerId, turn, question: state.followup, raw } });
    }
    const result = dialogueState(db, answerId); db.exec('COMMIT'); return result;
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

export function saveDialogueGrade(db, answerId, input) {
  validateJudgment(input);
  if (!String(input.by || '').startsWith('model:') || !Number.isInteger(input.turn)) throw new Error('model provenance and turn required');
  db.exec('BEGIN IMMEDIATE');
  try {
    const state = dialogueState(db, answerId);
    if (state.judgments.some((j) => j.turn === input.turn)) { db.exec('COMMIT'); return state; }
    const answer = db.prepare('SELECT * FROM answers WHERE id=?').get(answerId);
    if (answer.graded_by.startsWith('model:')) throw new Error('stored model grade already exists; audit required');
    if (state.status !== 'pending-model' || input.turn !== state.turn) throw new Error('stale dialogue turn');
    const evaluated = evaluateGrade(input.hit, state.rubric);
    if ((input.assessment === 'sufficient') !== evaluated.passed) throw new Error('assessment and complete rubric evidence disagree');
    const ask = input.assessment === 'partial' && state.turn < MAX_FOLLOWUPS;
    const status = ask ? 'awaiting-followup' : evaluated.passed ? 'passed' : input.assessment === 'partial' ? 'insufficient-evidence' : 'failed';
    const judgment = { answerId, turn: state.turn, assessment: input.assessment, recognized: input.recognized, points: evaluated.hit,
      gap: input.gap, followup: ask ? input.followup : '', note: input.note, status,
      passed: ask ? null : evaluated.passed, independent: evaluated.passed && state.turn === 0, by: input.by, version: DIALOGUE_VERSION };
    applyEvent(db, { type: 'dialogue.judged', dedupeKey: `dialogue-grade:${answerId}:${state.turn}`, payload: judgment });
    if (!ask) {
      const result = { hit: evaluated.hit.length, total: state.rubric.length, points: evaluated.hit, passed: evaluated.passed,
        coverage: evaluated.coverage, missingRequired: evaluated.missingRequired, gradingRule: evaluated.gradingRule,
        note: input.note, method: 'blind-model', advisory: false, dialogueVersion: DIALOGUE_VERSION,
        status, independent: judgment.independent, followupCount: state.turn, basis: state.turn ? 'original-and-followup' : 'original' };
      db.prepare('UPDATE answers SET rubric_json=?,graded_by=? WHERE id=?').run(JSON.stringify(result), input.by, answerId);
      const event = applyEvent(db, { type: 'answer.regraded', dedupeKey: `regrade:${answerId}`, payload: {
        answerId, cardId: answer.card_id, sessionId: answer.session_id, hit: result.hit, total: result.total,
        passed: result.passed, points: result.points, gradingRule: result.gradingRule, by: input.by,
        dialogueVersion: DIALOGUE_VERSION, independent: result.independent, followupCount: state.turn,
      } });
      if (event.deduped) throw new Error('existing final event; audit required');
    }
    const result = dialogueState(db, answerId); db.exec('COMMIT'); return result;
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

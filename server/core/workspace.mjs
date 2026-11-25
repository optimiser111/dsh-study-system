// 面板使用的业务视图。复习队列以事件保存，页面关闭/服务重启不丢失成员。
import { createSession, dueCards, recordAnswer, settle } from './store.mjs';
import { dialogueState } from './dialogue.mjs';
import { applyEvent, xpByAxis, levelByAxis } from './events.mjs';
import { studyProgress } from './progress.mjs';
import { gradingStatus } from './grading-queue.mjs';
import { subjectPresentationStatus } from './subject-presentation.mjs';

const json = (value, fallback = null) => { try { return JSON.parse(value); } catch { return fallback; } };
const runEvent = (db, sessionId) => db.prepare("SELECT payload_json FROM events WHERE type='review.started' AND json_extract(payload_json,'$.sessionId')=?").get(sessionId);
export function sessionMembers(db, sessionId) {
  const run = runEvent(db, sessionId);
  if (run) return json(run.payload_json).cardIds;
  const own = db.prepare('SELECT k.id FROM cards k JOIN segments g ON g.id=k.segment_id WHERE g.session_id=? ORDER BY g.seq,k.created_at,k.id').all(sessionId).map((r) => r.id);
  // 旧CLI复习没有队列快照，只能恢复实际保存过的作答，不能猜测其未答题。
  return own.length ? own : db.prepare('SELECT DISTINCT card_id AS id FROM answers WHERE session_id=? ORDER BY card_id').all(sessionId).map((r) => r.id);
}
export function publicAnswer(db, row) {
  if (!row) return null;
  const card = db.prepare('SELECT * FROM cards WHERE id=?').get(row.card_id);
  const result = { id: row.id, raw: row.raw, at: row.created_at, by: row.graded_by, status: 'pending-model', passed: null };
  if (card.kind === 'objective') return { ...result, status: row.correct ? 'correct' : 'wrong', passed: !!row.correct, correctAnswer: card.answer };
  result.grading = gradingStatus(db, row.id);
  if (card.prompt_version === 'm1-cards-v7') {
    const d = dialogueState(db, row.id);
    return { ...result, status: d.status, passed: d.passed, independent: d.independent,
      followup: d.followup, nextTurn: d.nextTurn, recognized: d.recognized, gap: d.gap, note: d.note,
      replies: d.replies.map(({ turn, question, raw }) => ({ turn, question, raw })) };
  }
  if (row.graded_by.startsWith('model:')) {
    const grade = json(row.rubric_json);
    if (!grade || grade.method !== 'blind-model' || typeof grade.passed !== 'boolean') return { ...result, status: 'audit-required' };
    return { ...result, status: grade.passed ? 'passed' : 'failed', passed: grade.passed, note: grade.note || '' };
  }
  return result;
}

export function sessionView(db, sessionId) {
  const session = db.prepare('SELECT s.*,c.title,c.axis FROM sessions s JOIN courses c ON c.id=s.course_id WHERE s.id=?').get(sessionId);
  if (!session) throw new Error('学习会话不存在');
  const run = runEvent(db, sessionId);
  const cards = sessionMembers(db, sessionId).map((id) => {
    const card = db.prepare('SELECT * FROM cards WHERE id=? AND discarded=0').get(id);
    if (!card) return null;
    const row = db.prepare('SELECT * FROM answers WHERE session_id=? AND card_id=? ORDER BY created_at LIMIT 1').get(sessionId, id);
    return { id, kind: card.kind, question: card.question, options: json(card.options_json, []), answer: publicAnswer(db, row) };
  }).filter(Boolean);
  const answered = cards.filter((c) => c.answer).length;
  const pending = cards.filter((c) => c.answer && ['pending-model', 'awaiting-followup', 'audit-required'].includes(c.answer.status)).length;
  return { id: session.id, courseId: session.course_id, title: session.title, axis: session.axis,
    kind: run || !session.content_id ? 'review' : 'lesson', legacyReview: !run && !session.content_id, startedAt: session.started_at, endedAt: session.ended_at,
    total: cards.length, answered, pending, complete: (cards.length > 0 || !!run) && answered === cards.length,
    nextCardId: cards.find((c) => !c.answer)?.id || cards.find((c) => ['awaiting-followup', 'pending-model', 'audit-required'].includes(c.answer?.status))?.id || cards[0]?.id || null,
    cards };
}

export function startReview(db, courseId = null, now = Date.now()) {
  if (courseId && !db.prepare('SELECT id FROM courses WHERE id=?').get(courseId)) throw new Error('课程不存在');
  db.exec('BEGIN IMMEDIATE');
  try {
    // 双击/多窗口加入尚未结束的同一复习，不重新创建会话发经验。
    const open = db.prepare("SELECT s.id,s.course_id FROM sessions s JOIN events e ON e.type='review.started' AND json_extract(e.payload_json,'$.sessionId')=s.id WHERE s.ended_at IS NULL ORDER BY s.started_at").all();
    const existing = open.find((s) => !courseId || courseId === s.course_id);
    if (existing) { const result = sessionView(db, existing.id); db.exec('COMMIT'); return { resumed: true, session: result }; }
    const due = dueCards(db, now).map((c) => ({ ...c, courseId: db.prepare('SELECT s.course_id FROM segments g JOIN sessions s ON s.id=g.session_id WHERE g.id=?').get(c.segment_id).course_id }));
    const selectedCourse = courseId || due[0]?.courseId;
    const selected = due.filter((c) => c.courseId === selectedCourse).slice(0, 20);
    if (!selected.length) { db.exec('COMMIT'); return { resumed: false, session: null }; }
    const sessionId = createSession(db, { courseId: selectedCourse, startedAt: now });
    applyEvent(db, { type: 'review.started', dedupeKey: `review-start:${sessionId}`, at: now,
      payload: { sessionId, courseId: selectedCourse, cardIds: selected.map((c) => c.id) } });
    const result = sessionView(db, sessionId); db.exec('COMMIT'); return { resumed: false, session: result };
  } catch (err) { db.exec('ROLLBACK'); throw err; }
}

export function answerFromPanel(db, sessionId, { cardId, raw }) {
  const view = sessionView(db, sessionId);
  const card = view.cards.find((c) => c.id === cardId);
  if (!card) throw new Error('这道题不在当前会话中');
  if (view.endedAt && !card.answer) throw new Error('当前会话已结束');
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('请先作答');
  if (card.kind === 'objective' && !['A', 'B', 'C', 'D'].includes(raw.trim())) throw new Error('请选择有效选项');
  recordAnswer(db, { sessionId, cardId, raw: card.kind === 'objective' ? raw.trim() : raw });
  return sessionView(db, sessionId);
}
export function finishFromPanel(db, sessionId) {
  const view = sessionView(db, sessionId);
  if (!view.complete) throw new Error('请完成当前会话的题目，再结束');
  settle(db, sessionId);
  return sessionView(db, sessionId);
}

export function cardHistory(db, cardId) {
  const card = db.prepare(`SELECT k.*,c.title FROM cards k JOIN segments g ON g.id=k.segment_id
    JOIN sessions s ON s.id=g.session_id JOIN courses c ON c.id=s.course_id WHERE k.id=?`).get(cardId);
  if (!card) throw new Error('题目不存在');
  return { cardId, question: card.question, kind: card.kind, title: card.title, discarded: !!card.discarded,
    options: json(card.options_json, []),
    attempts: db.prepare('SELECT * FROM answers WHERE card_id=? ORDER BY created_at DESC,id').all(cardId).map((row) => ({ sessionId: row.session_id, ...publicAnswer(db, row) })),
    review: db.prepare('SELECT due_at AS dueAt,reps,lapses FROM reviews WHERE card_id=?').get(cardId) || null };
}

export function workspaceView(db, now = Date.now()) {
  const generationSessions = new Set(db.prepare("SELECT json_extract(payload_json,'$.sessionId') AS sessionId FROM events WHERE type='generation.requested'").all().map(r => r.sessionId));
  const sessions = db.prepare('SELECT id FROM sessions ORDER BY started_at DESC,id').all().map(({ id }) => {
    const { cards, ...view } = sessionView(db, id); return view;
  }).filter((s) => s.total > 0 || s.kind === 'review' || generationSessions.has(s.id));
  const due = dueCards(db, now).map((c) => ({ id: c.id, question: c.question, dueAt: c.due_at,
    courseId: db.prepare('SELECT s.course_id FROM segments g JOIN sessions s ON s.id=g.session_id WHERE g.id=?').get(c.segment_id).course_id }));
  const wrong = db.prepare(`SELECT k.id,k.question,c.title,s.course_id AS courseId FROM cards k JOIN segments g ON g.id=k.segment_id
    JOIN sessions s ON s.id=g.session_id JOIN courses c ON c.id=s.course_id WHERE k.discarded=0
    AND EXISTS(SELECT 1 FROM answers a WHERE a.card_id=k.id AND (a.correct=0 OR (a.graded_by LIKE 'model:%' AND CASE WHEN json_valid(a.rubric_json) THEN json_extract(a.rubric_json,'$.passed') END=0)))
    ORDER BY k.created_at DESC,k.id`).all().map((c) => ({ ...c, attempts: db.prepare('SELECT COUNT(*) n FROM answers WHERE card_id=?').get(c.id).n }));
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(now + 8 * 3600000 - (6 - i) * 86400000).toISOString().slice(0, 10);
    const start = Date.parse(date + 'T00:00:00+08:00'), end = start + 86400000;
    return { date, xp: db.prepare('SELECT COALESCE(SUM(x.delta),0) n FROM xp_ledger x JOIN events e ON e.id=x.event_id WHERE e.created_at>=? AND e.created_at<?').get(start, end).n,
      answers: db.prepare('SELECT COUNT(*) n FROM answers WHERE created_at>=? AND created_at<?').get(start, end).n };
  });
  const presentations = subjectPresentationStatus(db);
  const progress = studyProgress(db).map(item => {
    const copy = presentations.get(item.axis);
    return copy ? { ...item, presentation: copy.presentation, presentationState: copy.state, presentationReason: copy.reason } : item;
  });
  return { sessions, due, wrong, xp: xpByAxis(db), levels: levelByAxis(db), days, progress,
    courses: db.prepare('SELECT id,title,axis FROM courses ORDER BY created_at').all(),
    openReviewId: sessions.find((s) => s.kind === 'review' && !s.legacyReview && !s.endedAt)?.id || null };
}

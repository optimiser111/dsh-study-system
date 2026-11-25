// 必须显式指定同一套隔离服务与数据库。先核对 /health.database，再进行任何写操作。
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { GRADING_RULE } from '../plugin/grading.js';

const probe = fileURLToPath(new URL('../.probe/', import.meta.url));
const samePath = (a, b) => fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase();

export async function validateTarget(base, dbFile) {
  const url = new URL(base);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'validation requires a local HTTP service');
  const relative = path.relative(fs.realpathSync(probe), fs.realpathSync(dbFile));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'validation DB must be inside project .probe');
  const response = await fetch(new URL('/health', url));
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.ok(health.database && samePath(health.database, dbFile), 'HTTP service and readback database do not match; refusing writes');
  assert.equal(health.gradingRule, GRADING_RULE, 'service is running an older grading rule');
  return health;
}

export async function runValidation({ base, dbFile, sessionId, grade, evidence = 'no-model-call' }) {
  assert.equal(typeof grade, 'function', 'provide an explicit grading transport; no automatic model spending');
  assert.ok(['stub-transport', 'recorded-transport', 'live-model'].includes(evidence), 'grade evidence must be labeled');
  const health = await validateTarget(base, dbFile);
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const checks = [];
  const check = (name, condition, detail) => { assert.ok(condition, name); checks.push({ name, pass: true, detail }); };
  const request = async (route, body) => {
    const res = await fetch(base + route, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const data = await res.json();
    assert.ok(res.ok, `${route}: ${JSON.stringify(data)}`);
    return data;
  };
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
    assert.ok(session, 'validation session is missing');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM answers').get().n, 0, 'use a fresh validation DB; existing answers would hide repeat-run bugs');
    const cards = db.prepare(`SELECT k.* FROM cards k JOIN segments g ON g.id=k.segment_id
      WHERE g.session_id=? AND k.discarded=0 ORDER BY g.seq,k.created_at,k.id`).all(sessionId);
    const objective = cards.filter((c) => c.kind === 'objective');
    const subjective = cards.find((c) => c.kind === 'subjective');
    assert.ok(objective.length >= 3 && subjective, 'need at least 3 objective and 1 subjective cards');
    const now = Date.now();
    const before = await request('/xp');
    for (let i = 0; i < 3; i++) {
      const raw = i < 2 ? objective[i].answer : ['A', 'B', 'C', 'D'].find((s) => s !== objective[i].answer);
      const answer = await request('/answer', { cardId: objective[i].id, sessionId, raw });
      check(`objective-${i + 1}`, answer.correct === (i < 2));
    }
    const xp = await request('/xp');
    check('XP adds exactly 23', xp.xp.math === (before.xp.math || 0) + 23, xp);
    const dup = await request('/answer', { cardId: objective[0].id, sessionId, raw: objective[0].answer });
    check('duplicate changes neither answers nor XP', dup.duplicate && db.prepare('SELECT COUNT(*) n FROM answers').get().n === 3 && JSON.stringify(await request('/xp')) === JSON.stringify(xp));
    const wrong = db.prepare('SELECT due_at FROM reviews WHERE card_id=?').get(objective[2].id);
    check('wrong card is due in one day in the SAME DB', wrong && wrong.due_at >= now + 86400000 - 1000 && wrong.due_at < Date.now() + 86400000 + 1000);

    const positive = await request('/answer', { cardId: subjective.id, sessionId, raw: subjective.answer });
    check('subjective starts pending', positive.passed === null && positive.status === 'pending-model');
    await grade({ sessionId, expectation: 'positive', reference: subjective.answer, rubric: JSON.parse(subjective.rubric_json) });
    const positiveRow = db.prepare('SELECT * FROM answers WHERE id=?').get(positive.answerId);
    check('matching reference answer is graded passed', positiveRow.graded_by.startsWith('model:') && JSON.parse(positiveRow.rubric_json).passed === true);
    const newSession = await request('/sessions', { courseId: session.course_id });
    const negative = await request('/answer', { cardId: subjective.id, sessionId: newSession.sessionId, raw: '今天只是打招呼，和这道题的概念无关。' });
    await grade({ sessionId: newSession.sessionId, expectation: 'negative', rubric: JSON.parse(subjective.rubric_json) });
    const negativeRow = db.prepare('SELECT * FROM answers WHERE id=?').get(negative.answerId);
    check('unrelated answer is graded failed', negativeRow.graded_by.startsWith('model:') && JSON.parse(negativeRow.rubric_json).passed === false);
    for (const id of [positive.answerId, negative.answerId]) {
      const row = db.prepare('SELECT rubric_json FROM answers WHERE id=?').get(id);
      const event = db.prepare('SELECT payload_json FROM events WHERE dedupe_key=?').get(`regrade:${id}`);
      check('grade event matches answer ' + id, event && JSON.parse(event.payload_json).passed === JSON.parse(row.rubric_json).passed);
    }
    await request('/settle', { sessionId }); await request('/settle', { sessionId });
    check('subjective grading and repeated settlement do not change XP', JSON.stringify(await request('/xp')) === JSON.stringify(xp));
    return { evidence, base, database: health.database, revision: health.revision, gradingRule: health.gradingRule, checks };
  } finally { db.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (key) => args[args.indexOf(key) + 1];
  assert.ok(args.includes('--base') && args.includes('--db'), 'usage: node test/validation-flow.mjs --base http://127.0.0.1:PORT --db .probe/DB/study.db (read-only target check)');
  console.log(JSON.stringify(await validateTarget(option('--base'), option('--db')), null, 2));
  console.log('Target verified only; run test/m1-acceptance.mjs for the complete quota-free acceptance.');
}

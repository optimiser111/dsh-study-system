import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { upsertCourse, saveSource, createSession, attachContent, materializeForSession, recordAnswer, pendingSubjective } from '../server/core/store.mjs';
import { dialogueState, replyToFollowup, saveDialogueGrade } from '../server/core/dialogue.mjs';
import { apply } from '../plugin/worker.js';
import { startServer } from '../server/http/server.mjs';
import { auditDb } from '../server/core/audit.mjs';
import { panelHarness } from './panel-harness.mjs';
import { gradingQueue, requestGrading, claimGrading, finishGrading, gradingStatus } from '../server/core/grading-queue.mjs';
const text = fs.readFileSync(new URL('../fixtures/lecture-p2.txt', import.meta.url), 'utf8');
const card = JSON.parse(fs.readFileSync(new URL('../fixtures/m1-understanding.json', import.meta.url), 'utf8')).cards[3];
function fixture(version = 'm1-cards-v7') {
  const db = new DatabaseSync(':memory:'); db.exec(fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
  const c = upsertCourse(db, { platform: 'fixture', externalId: 'dialogue', title: 'P2', axis: 'math' });
  const src = saveSource(db, { courseId: c.id, kind: 'bilibili-cc', status: 'ok' });
  const sessionId = createSession(db, { courseId: c.id, sourceId: src });
  const content = { text, normalizerVersion: 1 }; attachContent(db, sessionId, content);
  db.prepare('INSERT INTO segments VALUES (?,?,?,?,?,?,?)').run('s', sessionId, 0, 'bilibili-cc', text, 0, text.length);
  const { kept } = materializeForSession(db, { sessionId, content, rawCards: [card], model: 'manual:fixture', promptVersion: version });
  const { answerId } = recordAnswer(db, { cardId: kept[0], sessionId, raw: '横着走的可以合起来，上下还不明白。' });
  return { db, sessionId, answerId };
}
const partial = { assessment: 'partial', hit: [], recognized: '理解横向移动能合成', gap: '未解释不同方向如何处理', followup: '怎样确定两次移动后最终的上下位置？', note: '需要补充一个关系', by: 'model:test', turn: 0 };
const enough = { assessment: 'sufficient', hit: card.rubric.map((r) => r.text), recognized: '解释了各方向分别累加', gap: '', followup: '', note: '口语解释成立', by: 'model:test', turn: 0 };

test('局部理解即使整体评分点未命中也能追问；补充后通过、保留原答且XP不变', () => {
  const { db, sessionId, answerId } = fixture();
  try {
    const first = saveDialogueGrade(db, answerId, partial);
    assert.equal(first.status, 'awaiting-followup'); assert.equal(first.passed, null);
    const cardId = db.prepare('SELECT card_id FROM answers WHERE id=?').get(answerId).card_id;
    assert.equal(recordAnswer(db, { cardId, sessionId, raw: '重复提交不可覆盖' }).status, 'awaiting-followup');
    assert.equal(pendingSubjective(db, sessionId).length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type='answer.regraded'").get().n, 0);
    const reply = { turn: 1, raw: '上下走的也合在一起，左右单独合，合起来就是最后的位置。' };
    replyToFollowup(db, answerId, reply); replyToFollowup(db, answerId, reply);
    assert.equal(pendingSubjective(db, sessionId).length, 1);
    const result = saveDialogueGrade(db, answerId, { ...enough, turn: 1 });
    assert.equal(result.passed, true); assert.equal(result.independent, false);
    assert.equal(result.replies.length, 1); assert.equal(result.judgments.length, 2);
    assert.equal(db.prepare('SELECT raw FROM answers').get().raw, '横着走的可以合起来，上下还不明白。');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM xp_ledger').get().n, 0);
    assert.ok(auditDb(db).ok);
    assert.deepEqual(saveDialogueGrade(db, answerId, { ...partial, turn: 1 }), result);
  } finally { db.close(); }
});

test('充分则独立通过；错误与无关立即结束，不给追问', () => {
  for (const assessment of ['sufficient', 'incorrect', 'irrelevant']) {
    const { db, answerId } = fixture();
    try {
      const result = saveDialogueGrade(db, answerId, { ...enough, assessment, hit: assessment === 'sufficient' ? enough.hit : [] });
      assert.equal(result.followup, ''); assert.equal(result.passed, assessment === 'sufficient');
      assert.equal(result.independent, assessment === 'sufficient');
      assert.throws(() => replyToFollowup(db, answerId, { turn: 1, raw: '不该再问' }));
    } finally { db.close(); }
  }
});

test('一轮上限、拒绝覆盖回复/跳轮/空答；模型失败不制造结果；事务失败可重试', () => {
  const { db, answerId } = fixture();
  try {
    assert.throws(() => saveDialogueGrade(db, answerId, { ...partial, recognized: '' }));
    saveDialogueGrade(db, answerId, partial);
    assert.throws(() => replyToFollowup(db, answerId, { turn: 2, raw: '跳轮' }));
    assert.throws(() => replyToFollowup(db, answerId, { turn: 1, raw: ' ' }));
    replyToFollowup(db, answerId, { turn: 1, raw: '仍只重复横着走' });
    assert.throws(() => replyToFollowup(db, answerId, { turn: 1, raw: '覆盖旧答' }));
    db.exec("CREATE TRIGGER fail_final BEFORE INSERT ON events WHEN NEW.type='answer.regraded' BEGIN SELECT RAISE(ABORT,'test rollback'); END");
    assert.throws(() => saveDialogueGrade(db, answerId, { ...partial, turn: 1 }));
    assert.equal(dialogueState(db, answerId).judgments.length, 1);
    db.exec('DROP TRIGGER fail_final');
    const result = saveDialogueGrade(db, answerId, { ...partial, turn: 1 });
    assert.equal(result.status, 'insufficient-evidence'); assert.equal(result.followup, '');
    assert.equal(result.passed, false);
  } finally { db.close(); }
  const old = fixture('m1-cards-v6');
  try { assert.throws(() => saveDialogueGrade(old.db, old.answerId, partial), /not enabled/); } finally { old.db.close(); }
});

test('面板提交自动盲判，追问与补答留在面板，重复提交只判一次且不发XP', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { db, sessionId, answerId } = fixture();
  const { server, port } = await startServer({ db, port: 0 });
  const previous = process.env.STUDY_SERVICE_URL;
  process.env.STUDY_SERVICE_URL = 'http://127.0.0.1:' + port;
  let calls = 0;
  apply({ effect(setup) { const cleanup = setup(); if (typeof cleanup === 'function') t.after(cleanup); },
    tools: { register() {} }, llm: { stream(args) {
      calls++;
      assert.ok(!args.messages[0].content[0].text.includes(card.answer));
      return (async function* () { yield { type: 'text-delta', text: JSON.stringify(calls === 1 ? partial : enough) }; })();
    } } });
  const ui = panelHarness({ base: process.env.STUDY_SERVICE_URL });
  try {
    const original = db.prepare('SELECT card_id,raw FROM answers WHERE id=?').get(answerId);
    await fetch(process.env.STUDY_SERVICE_URL + '/panel/sessions/' + sessionId + '/answer', { method: 'POST', body: JSON.stringify({ cardId: original.card_id, raw: original.raw }) });
    t.mock.timers.tick(5000);
    for (let i = 0; i < 100 && dialogueState(db, answerId).status === 'pending-model'; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(dialogueState(db, answerId).status, 'awaiting-followup');
    await ui.settle(); await ui.click('学习');
    assert.ok(ui.text().includes(partial.followup));
    ui.all((n) => n.props['aria-label'] === '补充回答')[0].props.onChange({ target: { value: '左右各算左右的总量，上下也分别累加。' } });
    await ui.settle(); await ui.click('提交补答');
    t.mock.timers.tick(5000);
    for (let i = 0; i < 100 && dialogueState(db, answerId).status === 'pending-model'; i++) await new Promise((r) => setTimeout(r, 5));
    await ui.click('刷新');
    assert.equal(dialogueState(db, answerId).status, 'passed');
    assert.equal(calls, 2);
    assert.equal(ui.sent.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM xp_ledger').get().n, 0);
    assert.equal(gradingQueue(db).length, 0);
    assert.equal(db.prepare('SELECT raw FROM answers WHERE id=?').get(answerId).raw, original.raw);
  } finally {
    ui.dispose(); server.closeAllConnections(); await new Promise((r) => server.close(r)); db.close();
    if (previous === undefined) delete process.env.STUDY_SERVICE_URL; else process.env.STUDY_SERVICE_URL = previous;
  }
});

test('自动判卷任务失败保留未判状态，重复排队幂等，人工重试后可恢复', () => {
  const { db, answerId } = fixture();
  try {
    requestGrading(db, answerId); requestGrading(db, answerId);
    assert.equal(gradingQueue(db).length, 1);
    const task = gradingQueue(db)[0], claim = claimGrading(db, task.id);
    assert.equal(claim.claimed, true);
    assert.equal(claimGrading(db, task.id).claimed, false);
    finishGrading(db, task.id, { token: claim.token, failed: true });
    assert.equal(gradingStatus(db, answerId).state, 'failed');
    assert.equal(dialogueState(db, answerId).status, 'pending-model');
    assert.equal(gradingQueue(db).length, 0);
    requestGrading(db, answerId);
    assert.equal(gradingQueue(db).length, 1);
    assert.notEqual(gradingQueue(db)[0].id, task.id);
    saveDialogueGrade(db, answerId, enough);
    assert.equal(gradingQueue(db).length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM xp_ledger').get().n, 0);
  } finally { db.close(); }
});

test('真实HTTP和插件：等待期间不重复调用模型，补答工具接通后再判，工具JSON无损', async () => {
  const { db, sessionId, answerId } = fixture();
  const { server, port } = await startServer({ db, port: 0 });
  const previous = process.env.STUDY_SERVICE_URL; process.env.STUDY_SERVICE_URL = `http://127.0.0.1:${port}`;
  let calls = 0; const defs = [];
  apply({ tools: { register: (d) => defs.push(d) }, llm: { stream(args) { return (async function* () {
    calls++; assert.ok(!args.messages[0].content[0].text.includes(card.answer));
    yield { type: 'text-delta', text: JSON.stringify(calls === 1 ? partial : enough) };
  })(); } } });
  const tool = async (name, args) => {
    const result = await defs.find((d) => d.name === name).execute(args, { signal: new AbortController().signal });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result); return result;
  };
  try {
    const first = await tool('study_grade_subjective', { sessionId }); assert.equal(first.items[0].passed, null);
    await tool('study_grade_subjective', { sessionId }); assert.equal(calls, 1);
    await tool('study_answer_followup', { answerId, turn: 1, raw: '左右各算左右的总量，上下也分别累加。' });
    const last = await tool('study_grade_subjective', { sessionId }); assert.equal(last.items[0].passed, true);
    assert.equal(calls, 2);
    const res = await fetch(`${process.env.STUDY_SERVICE_URL}/subjective/${answerId}/grade`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 409);
  } finally {
    server.closeAllConnections(); await new Promise((r) => server.close(r)); db.close();
    if (previous === undefined) delete process.env.STUDY_SERVICE_URL; else process.env.STUDY_SERVICE_URL = previous;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { validateLessonSummary, assessmentError } from '../plugin/lesson-core.js';
import { buildGradePrompt, PROMPT_VERSION } from '../plugin/generate-core.js';
import { upsertCourse, saveSource, createSession, buildContent, attachContent, addSegments, pendingSubjective, recordAnswer } from '../server/core/store.mjs';
import { startServer } from '../server/http/server.mjs';
import { apply } from '../plugin/worker.js';
import { testDialogue } from './lesson-fixture.mjs';
const sample = JSON.parse(fs.readFileSync(new URL('../fixtures/m1-understanding.json', import.meta.url), 'utf8'));
const source = fs.readFileSync(new URL('../fixtures/lecture-p2.txt', import.meta.url), 'utf8');

async function pipeline(replies, work) {
  const db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys=ON');
  db.exec(fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
  const course = upsertCourse(db, { platform: 'fixture', externalId: 'p2', title: 'P2', axis: 'math' });
  const sourceId = saveSource(db, { courseId: course.id, kind: 'bilibili-cc', status: 'ok' });
  const sessionId = createSession(db, { courseId: course.id, sourceId });
  const content = buildContent({ sessionId, sourceKind: 'bilibili-cc', parts: source.split('\n').map((text, i) => ({ text, ts: i * 3 })) });
  attachContent(db, sessionId, content); addSegments(db, sessionId, content);
  const { server, port } = await startServer({ db, port: 0 });
  const previous = process.env.STUDY_SERVICE_URL;
  const base = `http://127.0.0.1:${port}`; process.env.STUDY_SERVICE_URL = base;
  const calls = []; const defs = [];
  apply({ tools: { register: (def) => defs.push(def) }, llm: { stream(args) {
    const stage = args.system.startsWith('先为整讲课程整理提要') ? 'summary' : /^(你在按 rubric 判|按原题)/.test(args.system) ? 'grade' : 'questions';
    calls.push({ stage, prompt: args.messages[0].content[0].text });
    const original = replies(stage, calls);
    const reply = stage === 'grade' ? testDialogue(original) : original;
    return (async function* () { yield { type: 'text-delta', text: JSON.stringify(reply) }; })();
  } } });
  const generate = () => defs.find((d) => d.name === 'study_generate_cards').execute({ sessionId }, { signal: new AbortController().signal });
  try { await work({ db, base, sessionId, calls, generate, tool: (name, args = {}) => defs.find((d) => d.name === name).execute(args, { signal: new AbortController().signal }) }); }
  finally {
    server.closeAllConnections(); await new Promise((r) => server.close(r)); db.close();
    if (previous === undefined) delete process.env.STUDY_SERVICE_URL; else process.env.STUDY_SERVICE_URL = previous;
  }
}

test('单P2固定题先有主线与三个核心目标，四题覆盖应用/纠错/解释，每题证据真实存在', () => {
  validateLessonSummary(sample.summary, source);
  assert.equal(sample.source.page, 2);
  assert.equal(sample.cards.length, 4);
  assert.equal(new Set(sample.cards.map((c) => c.targetId)).size, 3);
  assert.equal(sample.cards.filter((c) => c.kind === 'subjective').length, 1);
  for (const card of sample.cards) { assert.equal(assessmentError(card, sample.summary), null); assert.ok(source.includes(card.quote)); }
  assert.ok(sample.gradingExamples.some((e) => e.expected === 'accept' && !e.raw.includes('坐标')));
  assert.ok(sample.gradingExamples.some((e) => e.expected === 'reject'));
});

test('无来源的课程提要、重复概念ID与悬空概念关系均不能通过', () => {
  assert.throws(() => validateLessonSummary({ ...sample.summary, coreIdeas: [{ ...sample.summary.coreIdeas[0], evidence: '不存在的课程原文' }] }, source), /evidence/);
  assert.throws(() => validateLessonSummary({ ...sample.summary, coreIdeas: [sample.summary.coreIdeas[0], sample.summary.coreIdeas[0]] }, source), /duplicate/);
  assert.throws(() => validateLessonSummary({ ...sample.summary, connections: [{ from: 'coordinates', to: 'unknown', relation: '关系' }] }, source), /connection/);
  assert.equal(assessmentError({ ...sample.cards[0], skill: 'recall' }, sample.summary), 'invalid-assessment-skill');
});

test('多段课程只总结一次并出一组四题；每题关联提要，重复调用不再花模型调用', async () => {
  // 所有引用故意放在同一个技术段，另一个段没有题也不能再次出一组。
  const cards = sample.cards.map((c) => ({ ...c, quote: sample.cards[0].quote }));
  await pipeline((stage) => stage === 'summary' ? sample.summary : { cards }, async ({ db, calls, generate, sessionId, base }) => {
    const result = await generate();
    assert.deepEqual(calls.map((c) => c.stage), ['summary', 'questions']);
    assert.ok(calls[1].prompt.includes(sample.summary.overview));
    assert.equal(result.totals.kept, 4); assert.equal(result.lessonSummary.coreIdeas.length, 3);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type='lesson.summarized'").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type='card.assessed'").get().n, 4);
    await generate(); assert.equal(calls.length, 2);
    const summaryId = result.lessonSummary.summaryId;
    const repeated = await fetch(base + '/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, summaryId, cards, promptVersion: PROMPT_VERSION }) });
    assert.equal((await repeated.json()).skipped, 'lesson-already-assessed');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM cards').get().n, 4);
    const sub = db.prepare("SELECT * FROM cards WHERE kind='subjective'").get();
    recordAnswer(db, { cardId: sub.id, sessionId, raw: '横向走的合起来，上下走的另算，就到最后的位置。' });
    assert.equal(pendingSubjective(db, sessionId)[0].question, sub.question);
  });
});

test('无法校验的提要会停止出题，不能生成无目标的题', async () => {
  await pipeline(() => ({ overview: '缺少核心目标' }), async ({ db, calls, generate }) => {
    const result = await generate(); assert.equal(result.totals.failed, 1); assert.equal(result.totals.kept, 0);
    assert.equal(calls.length, 1); assert.equal(db.prepare('SELECT COUNT(*) n FROM cards').get().n, 0);
  });
});

test('已有提要可复用；偏离核心目标的题被丢弃，重试只调用出题阶段', async () => {
  let questionCalls = 0;
  await pipeline((stage) => stage === 'summary' ? sample.summary : { cards: ++questionCalls === 1 ? [{ ...sample.cards[0], targetId: 'trivia' }] : sample.cards }, async ({ db, calls, generate }) => {
    const first = await generate(); assert.equal(first.totals.discarded, 1); assert.equal(first.totals.kept, 0);
    assert.equal(db.prepare('SELECT discard_reason FROM cards').get().discard_reason, 'unknown-learning-target');
    const second = await generate(); assert.equal(second.totals.kept, 4);
    assert.deepEqual(calls.map((c) => c.stage), ['summary', 'questions', 'questions']);
  });
});

test('服务拒绝绕过课程提要直接提交题目；盲判只见题目、语义要点和作答', async () => {
  await pipeline(() => sample.summary, async ({ base, sessionId, db }) => {
    const stale = await fetch(`${base}/sessions/${sessionId}/lesson?promptVersion=m1-cards-v5`);
    assert.equal(stale.status, 409);
    assert.match((await stale.json()).error, /reload m1-cards-v7/);
    const res = await fetch(base + '/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, cards: sample.cards, promptVersion: PROMPT_VERSION }) });
    assert.equal(res.status, 409); assert.equal(db.prepare('SELECT COUNT(*) n FROM cards').get().n, 0);
  });
  const prompt = buildGradePrompt({ question: '解释位移合成', rubric: sample.cards[3].rubric, raw: '换一种说法', answer: '不能给判卷看的标准答案', assessmentReason: '隐藏的出题理由' });
  assert.ok(prompt.includes('解释位移合成'));
  assert.ok(!prompt.includes('不能给判卷看的标准答案')); assert.ok(!prompt.includes('隐藏的出题理由'));
});

test('v6短主观题不能把三种观点捆成三个得分点；被丢弃的题仍保留原rubric', async () => {
  const rubric = [
    { text: '箭头和数字列表通过坐标对应', required: true },
    { text: '数学家抽取加法和数乘的共同结构', required: true },
    { text: '补充两种运算的几何和分量对应', required: false },
  ];
  const card = { ...sample.cards[3], rubric };
  assert.equal(assessmentError(card, sample.summary, { singleTask: true }), 'subjective-not-single-task');
  // 不把新规则追溯应用到旧题。
  assert.equal(assessmentError(card, sample.summary), null);
  await pipeline((stage) => stage === 'summary' ? sample.summary : { cards: [card] }, async ({ db, generate }) => {
    const result = await generate();
    assert.equal(result.totals.kept, 0); assert.equal(result.totals.discarded, 1);
    const row = db.prepare('SELECT discarded,discard_reason,rubric_json FROM cards').get();
    assert.equal(row.discard_reason, 'subjective-not-single-task');
    assert.deepEqual(JSON.parse(row.rubric_json), rubric);
  });
});

test('工具报告必须能无损往返JSON：成功、跳过、判卷、状态均不含undefined', async () => {
  const roundtrip = (value) => assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  await pipeline((stage) => stage === 'summary' ? sample.summary : stage === 'grade'
    ? { hit: sample.cards[3].rubric.map((p) => p.text), passed: true, note: '模拟语义命中，只测传输' }
    : { cards: sample.cards }, async ({ db, generate, tool, sessionId }) => {
    roundtrip(await tool('study_status'));
    const generated = await generate(); roundtrip(generated);
    assert.equal(Object.hasOwn(generated.segments[0], 'skipped'), false);
    roundtrip(await generate());
    const sub = db.prepare("SELECT id FROM cards WHERE kind='subjective'").get();
    recordAnswer(db, { cardId: sub.id, sessionId, raw: '左右走的分别合起来，上下走的分别合起来。' });
    roundtrip(await tool('study_grade_subjective', { sessionId }));
    roundtrip(await tool('study_grade_subjective', { sessionId }));
  });
  await pipeline(() => ({ overview: '损坏的提要' }), async ({ generate }) => roundtrip(await generate()));
  await pipeline(() => ({ abstain: '本段信息不足' }), async ({ generate }) => roundtrip(await generate()));
});

import { testLesson, testAssessment, testDialogue } from './lesson-fixture.mjs';
// 出题链路集成测试：真实服务 + 真实落库 + 打桩的模型传输层。
// 只验证"接线"（取段→prompt→解析→span 校验→落库→弃权），不声称验证了模型质量。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db/open.mjs';
import { buildContent, addSegments, attachContent, createSession, upsertCourse, saveSource, planSegments, recordAnswer } from '../server/core/store.mjs';
import { loadTextParts } from '../server/sources/fixture.mjs';
import { startServer } from '../server/http/server.mjs';
import { apply } from '../plugin/worker.js';
import { saveModelSettings } from '../server/core/model-settings.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const dir = path.join(ROOT, 'data');
fs.mkdirSync(dir, { recursive: true });
const { db } = openDb(path.join(dir, `itg-${Date.now()}.db`));

const course = upsertCourse(db, { platform: 'fixture', externalId: 'itg', title: 'itg', axis: 'math' });
const sourceId = saveSource(db, { courseId: course.id, kind: 'pdf', status: 'ok' });
const sessionId = createSession(db, { courseId: course.id, sourceId });
const content = buildContent({ sessionId, sourceKind: 'pdf', parts: loadTextParts(path.join(ROOT, 'fixtures/lecture-01.txt')) });
attachContent(db, sessionId, content);
addSegments(db, sessionId, content);

const { server, port } = await startServer({ db, port: 0 });
process.env.STUDY_SERVICE_URL = `http://127.0.0.1:${port}`;
const CALL = JSON.stringify({
  cards: [
    {
      kind: 'objective',
      question: '计算机视角下向量是什么？',
      options: ['空间箭头', '有序数字列表', '线性变换', '特征值'],
      answer: 'B',
      quote: '选定坐标轴后,程序可以用按轴顺序排列的数组存储向量。',
      topic: '三种视角',
      difficulty: 1,
    },
    {
      kind: 'objective',
      question: '编出来的题',
      options: ['a', 'b', 'c', 'd'],
      answer: 'A',
      quote: '这句话原文里根本不存在',
      topic: 'x',
      difficulty: 1,
    },
    {
      kind: 'subjective',
      question: '为什么线性代数要把向量放在原点？',
      answer: '物理上向量可以任意平移，只关心长度和方向；线性代数用坐标表示向量，以原点为起点才能用一组数唯一确定它。',
      rubric: ['原点', '坐标', '唯一'],
      quote: '表示位移的箭头可以平移到原点,移动的大小与方向保持不变。',
      topic: '坐标系',
      difficulty: 3,
    },
  ],
});

const modelCalls = [];
function fakeLlm(reply) {
  return {
    stream({ system, provider, model }) {
      modelCalls.push({ provider, model });
      return (async function* () {
        const payload = JSON.parse(reply);
        const output = system.startsWith('先为整讲课程整理提要') && payload.cards
          ? testLesson(content.text) : payload.cards ? { cards: testAssessment(payload.cards) } : payload;
        yield { type: 'text-delta', text: JSON.stringify(system.startsWith('按原题') ? testDialogue(output) : output) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

const registered = [];
const ctx = {
  llm: fakeLlm(CALL),
  tools: { register: (def) => registered.push(def) },
  effect: () => () => {},
};
apply(ctx, {});

const generate = registered.find((d) => d.name === 'study_generate_cards');
const gradeTool = registered.find((d) => d.name === 'study_grade_subjective');

const out = [];
const check = (name, cond, detail) => {
  out.push({ name, pass: Boolean(cond), detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${JSON.stringify(detail)})` : ''}`);
};

check('注册了两个工具', Boolean(generate && gradeTool), registered.map((d) => d.name));

saveModelSettings(db, { tasks: { generation: { provider: 'chatgpt', model: 'fixture-generation' }, grading: { provider: 'chatgpt', model: 'fixture-grading' } }, autoResearch: false });
const report = await generate.execute({ sessionId }, { signal: new AbortController().signal });
check('出题使用设置中的提供方与模型', modelCalls.length === 2 && modelCalls.every((c) => c.provider === 'chatgpt' && c.model === 'fixture-generation'), modelCalls);
check('出题链路：kept=2 discarded=1', report.totals.kept === 2 && report.totals.discarded === 1, report.totals);

const cards = db.prepare('SELECT discarded, discard_reason, span_text FROM cards').all();
check('span 不存在的题被丢', cards.some((c) => c.discarded === 1 && c.discard_reason === 'span-not-found'), cards);
check('有效题带原文 span', cards.some((c) => c.discarded === 0 && c.span_text.includes('按轴顺序排列的数组')));
check(
  '主观题带完整答案与 rubric 才入库',
  cards.some((c) => c.discarded === 0 && c.span_text.includes('平移到原点')),
);

// 主观题闭环：作答 → 待判 → 模型盲判 → 事件
const subCard = db.prepare("SELECT * FROM cards WHERE kind = 'subjective' AND discarded = 0").get();
const answer = recordAnswer(db, { cardId: subCard.id, sessionId, raw: '因为原点，所以坐标唯一' });
check('作答后是待判，不是通过', answer.passed === null && answer.status === 'pending-model', { passed: answer.passed, status: answer.status });

const gradeRegistered = [];
apply(
  {
    llm: fakeLlm(JSON.stringify({ hit: JSON.parse(subCard.rubric_json).map((p) => p.text), passed: true, note: '覆盖本题理解任务' })),
    tools: { register: (d) => gradeRegistered.push(d) },
    effect: () => () => {},
  },
  {},
);
const gradeFn = gradeRegistered.find((d) => d.name === 'study_grade_subjective');
const graded = await gradeFn.execute({ sessionId }, { signal: new AbortController().signal });
const regradedEvents = Number(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'answer.regraded'").get().n);
check('盲判执行并留下可追溯事件', graded.graded === 1 && regradedEvents === 1, { graded: graded.graded, regradedEvents });
const subAnswer = db.prepare('SELECT graded_by, rubric_json FROM answers WHERE card_id = ?').get(subCard.id);
check('判卷使用独立设置且判定归属实际模型', subAnswer.graded_by === 'model:fixture-grading' && modelCalls.at(-1).provider === 'chatgpt' && modelCalls.at(-1).model === 'fixture-grading', subAnswer.graded_by);

// 两个工具同时取得待判项、模型给出相反结果：数据库/事件/两份工具报告必须一致。
const concurrentSession = createSession(db, { courseId: course.id });
const concurrentAnswer = recordAnswer(db, { cardId: subCard.id, sessionId: concurrentSession, raw: '原点 坐标 唯一' });
let arrivals = 0;
let release;
const bothReady = new Promise((resolve) => { release = resolve; });
const concurrentTools = [true, false].map((passed) => {
  const defs = [];
  apply({
    llm: { stream() { return (async function* () {
      arrivals++;
      if (arrivals === 2) release();
      await bothReady;
      yield { type: 'text-delta', text: JSON.stringify(testDialogue({ hit: passed ? JSON.parse(subCard.rubric_json).map((p) => p.text) : [], passed, note: passed ? 'pass result' : 'fail result' })) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })(); } },
    tools: { register: (def) => defs.push(def) },
  }, {});
  return defs.find((def) => def.name === 'study_grade_subjective');
});
const concurrentReports = await Promise.all(concurrentTools.map((tool) =>
  tool.execute({ sessionId: concurrentSession }, { signal: new AbortController().signal }),
));
const accepted = JSON.parse(db.prepare('SELECT rubric_json FROM answers WHERE id = ?').get(concurrentAnswer.answerId).rubric_json);
check('并发相反判卷：两份工具报告均返回落库结果', concurrentReports.every((r) =>
  r.graded === 1 && r.items[0].passed === accepted.passed &&
  JSON.stringify(r.items[0].hit) === JSON.stringify(accepted.points) && r.items[0].note === accepted.note), concurrentReports);
const acceptedEvents = db.prepare('SELECT payload_json FROM events WHERE dedupe_key = ?').all(`regrade:${concurrentAnswer.answerId}`);
check('并发判卷只记一条事件且与答案一致', acceptedEvents.length === 1 &&
  JSON.parse(acceptedEvents[0].payload_json).passed === accepted.passed);

// 再跑一次：已出过题的段应被跳过，不重复生成
const again = await generate.execute({ sessionId }, { signal: new AbortController().signal });
check('重复调用不重复出题', again.totals.kept === 0 && again.totals.skipped === report.totals.kept + report.totals.discarded - (report.totals.abstained || 0) || again.totals.skipped >= 1, again.totals);

// 弃权：模型返回 abstain → 不落题、留弃权痕
const courseB = upsertCourse(db, { platform: 'fixture', externalId: 'itg-chat', title: 'chat', axis: 'math' });
const sourceB = saveSource(db, { courseId: courseB.id, kind: 'pdf', status: 'ok' });
const sessionB = createSession(db, { courseId: courseB.id, sourceId: sourceB });
const contentB = buildContent({ sessionId: sessionB, sourceKind: 'pdf', parts: loadTextParts(path.join(ROOT, 'fixtures/lecture-chat.txt')) });
attachContent(db, sessionB, contentB);
addSegments(db, sessionB, contentB);

const abstainRegistered = [];
apply({ llm: fakeLlm('{"abstain":"这段是闲聊，信息不足"}'), tools: { register: (d) => abstainRegistered.push(d) }, effect: () => () => {} }, {});
const abstainGenerate = abstainRegistered.find((d) => d.name === 'study_generate_cards');
const abstainReport = await abstainGenerate.execute({ sessionId: sessionB }, { signal: new AbortController().signal });
check('模型弃权 → 不落题', abstainReport.totals.abstained === 1 && abstainReport.totals.kept === 0, abstainReport.totals);
const abstained = db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'abstained'").get().n;
const cardsB = db.prepare('SELECT COUNT(*) n FROM cards WHERE segment_id IN (SELECT id FROM segments WHERE session_id = ?)').get(sessionB).n;
check('弃权事件已落痕且该段无题', Number(abstained) >= 1 && Number(cardsB) === 0, { abstained, cardsB });

server.close();
db.close();

const failed = out.filter((c) => !c.pass);
console.log(`\n${out.length - failed.length}/${out.length} PASS`);
if (failed.length) process.exitCode = 1;

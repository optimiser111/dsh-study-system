import { testLesson, testAssessment, testDialogue } from './lesson-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db/open.mjs';
import { upsertCourse, saveSource, createSession, buildContent, attachContent, addSegments, materializeForSession, recordAnswer, applyModelGrade } from '../server/core/store.mjs';
import { evaluateGrade, rubricPoints, GRADING_RULE } from '../plugin/grading.js';
import { startServer } from '../server/http/server.mjs';
import { apply } from '../plugin/worker.js';
import { loadTextParts } from '../server/sources/fixture.mjs';
import { validateTarget, runValidation } from './validation-flow.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
function fixture() {
  fs.mkdirSync(path.join(root, '.probe'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, '.probe', 'm1-acceptance-'));
  const { db, file } = openDb(path.join(dir, 'study.db'));
  const course = upsertCourse(db, { platform: 'fixture', externalId: 'm1', title: 'M1', axis: 'math' });
  const sourceId = saveSource(db, { courseId: course.id, kind: 'pdf', status: 'ok' });
  const sessionId = createSession(db, { courseId: course.id, sourceId });
  const content = buildContent({ sessionId, sourceKind: 'pdf', parts: loadTextParts(path.join(root, 'fixtures/lecture-01.txt')) });
  attachContent(db, sessionId, content); addSegments(db, sessionId, content);
  const payload = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/cards-lecture-01.json'), 'utf8'));
  return { db, file, dir, sessionId, content, payload };
}
async function stop(server) {
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}

test('核心点必须命中且总覆盖至少75%；旧字符串要点不机械全中；重复命中不能刷覆盖率', () => {
  const rubric = [{ text: '核心', required: true }, { text: '补充一', required: false }, { text: '补充二', required: false }, { text: '补充三', required: false }];
  assert.equal(evaluateGrade(['核心', '补充一', '补充二'], rubric).passed, true);
  assert.equal(evaluateGrade(['补充一', '补充二', '补充三'], rubric).passed, false);
  assert.equal(evaluateGrade(['核心', '补充一'], rubric).passed, false);
  assert.equal(evaluateGrade(['a', 'b', 'c'], ['a', 'b', 'c', 'd']).passed, true);
  assert.equal(evaluateGrade(['核心', '核心', '未知'], rubric).coverage, 0.25);
  assert.throws(() => rubricPoints([{ text: '核心' }]));
});

test('服务端重新计算正式结果，忽略客户端 passed，事件保留规则版本', () => {
  const f = fixture();
  try {
    const rubric = [{ text: '核心', required: true }, { text: '一', required: false }, { text: '二', required: false }, { text: '三', required: false }];
    const raw = { ...f.payload.cards.find((c) => c.kind === 'subjective'), rubric };
    const { kept } = materializeForSession(f.db, { ...f, rawCards: [raw], model: 'fixture', promptVersion: 'test' });
    const answer = recordAnswer(f.db, { cardId: kept[0], sessionId: f.sessionId, raw: '测试' });
    const grade = applyModelGrade(f.db, answer.answerId, { hit: ['一', '二', '三'], passed: true, by: 'model:fixture' });
    assert.equal(grade.passed, false);
    assert.deepEqual(grade.missingRequired, ['核心']);
    assert.equal(grade.gradingRule, GRADING_RULE);
    const event = JSON.parse(f.db.prepare('SELECT payload_json FROM events WHERE dedupe_key=?').get(`regrade:${answer.answerId}`).payload_json);
    assert.equal(event.passed, false); assert.equal(event.gradingRule, GRADING_RULE);
  } finally { f.db.close(); }
});

test('验收地址与数据库不一致时拒绝执行；错误库中的旧 due 不能使检查通过', async () => {
  const a = fixture(); const b = fixture();
  const { server, port } = await startServer({ db: a.db, port: 0 });
  try {
    await assert.rejects(() => validateTarget(`http://127.0.0.1:${port}`, b.file), /do not match/);
    assert.equal(a.db.prepare('SELECT COUNT(*) n FROM answers').get().n, 0);
    assert.equal(b.db.prepare('SELECT COUNT(*) n FROM answers').get().n, 0);
  } finally { await stop(server); a.db.close(); b.db.close(); }
});

test('无额度验收：同一服务/数据库完成出题、23XP、错题、正反主观判卷、事件和重复结算', async () => {
  const f = fixture();
  const { server, port } = await startServer({ db: f.db, port: 0 });
  const previous = process.env.STUDY_SERVICE_URL;
  process.env.STUDY_SERVICE_URL = `http://127.0.0.1:${port}`;
  let reply = JSON.stringify({ cards: testAssessment([...f.payload.cards.filter((c) => c.kind === 'objective').slice(0, 3), f.payload.cards.find((c) => c.kind === 'subjective')]) });
  const defs = [];
  apply({ tools: { register: (def) => defs.push(def) }, llm: { stream({ system }) { return (async function* () {
    yield { type: 'text-delta', text: system.startsWith('先为整讲课程整理提要') ? JSON.stringify(testLesson(f.content.text)) : system.startsWith('按原题') ? JSON.stringify(testDialogue(JSON.parse(reply))) : reply };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })(); } } });
  const exec = { signal: new AbortController().signal };
  try {
    const generated = await defs.find((d) => d.name === 'study_generate_cards').execute({ sessionId: f.sessionId, maxSegments: 1 }, exec);
    assert.equal(generated.totals.kept, 4); assert.equal(generated.totals.discarded, 0);
    const report = await runValidation({ base: process.env.STUDY_SERVICE_URL, dbFile: f.file, sessionId: f.sessionId, evidence: 'stub-transport',
      grade: async ({ sessionId, expectation, rubric }) => {
        // 这是已知正反样例的传输替身，仅验证管道，不冒充新模型语义判断。
        reply = JSON.stringify({ hit: expectation === 'positive' ? rubricPoints(rubric).map((p) => p.text) : [], passed: expectation === 'positive', note: 'controlled fixture response' });
        const result = await defs.find((d) => d.name === 'study_grade_subjective').execute({ sessionId }, exec);
        assert.equal(result.graded, 1); assert.equal(result.failed, 0);
      },
    });
    assert.ok(report.checks.every((c) => c.pass));
    assert.equal(report.evidence, 'stub-transport');
    const evidenceDir = path.join(root, '.probe/m1-evidence'); fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'closure.json'), JSON.stringify(report, null, 2));
    await assert.rejects(() => runValidation({ base: process.env.STUDY_SERVICE_URL, dbFile: f.file, sessionId: f.sessionId, evidence: 'stub-transport', grade: async () => {} }), /fresh validation DB/);
  } finally {
    await stop(server); f.db.close();
    if (previous === undefined) delete process.env.STUDY_SERVICE_URL; else process.env.STUDY_SERVICE_URL = previous;
  }
});

test('主面板移除来源提示，使用高度受限的独立滚动容器', () => {
  const warning = { from: 10, to: 12, excerpt: '在这个变换里m保持不变' };
  const states = [{ data: { xp: {}, level: {} } }, { data: { due: [] } }, { data: { wrong: [] } }, { data: {} }, { data: { cards: [
    { id: 'a', segment_id: 's', course: '课程', seq: 0, question: '问题一', warnings: [warning] },
    { id: 'b', segment_id: 's', course: '课程', seq: 0, question: '问题二', warnings: [warning] },
  ] } }];
  let index = 0; let Panel;
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }), useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}], useEffect() {}, useRef: (value) => ({ current: value }) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'plugin/client.js'), 'utf8'), { window: { __ModuleLoader__: { load(def) {
    const plugin = def.factory(() => React);
    plugin.apply({ slots: { inject: (name, fn) => fn(), register: (slot, component) => { if (slot.name === 'main') Panel = component; } } });
  } } } });
  const tree = Panel(); const details = [];
  function visit(node) { if (!node || typeof node !== 'object') return; if (node.type === 'details') details.push(node); for (const child of node.children || []) visit(child); }
  visit(tree);
  assert.equal(details.length, 0);
  assert.equal(tree.props.style.height, '100%');
  assert.equal(tree.props.style.overflowY, 'auto');
  assert.equal(tree.props.style.minHeight, 0);
  const text = JSON.stringify(tree);
  assert.ok(!text.includes(warning.excerpt));
  assert.ok(!text.includes('字幕来源提示'));
});

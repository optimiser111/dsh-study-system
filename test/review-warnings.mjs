import { testLesson, testAssessment } from './lesson-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { subtitleWarnings } from '../server/sources/warnings.mjs';
import { assessSubtitles } from '../server/sources/bilibili.mjs';
import { upsertCourse, saveSource, createSession, buildContent, attachContent, addSegments,
  materializeForSession, reviewCards, recordAnswer, applyModelGrade } from '../server/core/store.mjs';
import { renderReviewTable } from '../server/review/table.mjs';
import { startServer } from '../server/http/server.mjs';
import { apply } from '../plugin/worker.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(fs.readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8'));
  const course = upsertCourse(db, { platform: 'fixture', externalId: 'warnings', title: 'test', axis: 'math' });
  const sourceId = saveSource(db, { courseId: course.id, kind: 'bilibili-cc', status: 'ok' });
  const sessionId = createSession(db, { courseId: course.id, sourceId });
  const content = buildContent({ sessionId, sourceKind: 'bilibili-cc', parts: [{ ts: 60, text: '在变换里m保持不变。向量可以自由落脚。' + '课程正文用于测试来源提示。'.repeat(25) }] });
  attachContent(db, sessionId, content); addSegments(db, sessionId, content);
  const card = { kind: 'subjective', question: '解释向量', answer: '自由落脚', rubric: ['自由落脚'], quote: '向量可以自由落脚' };
  return { db, sessionId, content, card };
}

test('只提示可疑模式：支持 m/g/e2，正常数学变量也可能命中，纯中文语义错误仍可能漏检', () => {
  const text = '在变换里m保持不变，变换后的g码，以e2为列';
  const found = subtitleWarnings(text, { offset: 100, coordinate: 'normalized-content' });
  assert.deepEqual(found.map((w) => w.token), ['m', 'g', 'e2']);
  for (const w of found) assert.equal(text.slice(w.start - 100, w.end - 100), w.token);
  assert.equal(subtitleWarnings('变量 x 表示横坐标').length, 1);
  assert.equal(subtitleWarnings('这是 API 接口与 DeepSeek 模型').length, 0);
  assert.equal(subtitleWarnings('这个变换叫做简介').length, 0);
});

test('提示保存原字幕时间，不改变统计 verdict 或原文', () => {
  const cues = Array.from({ length: 5 }, (_, i) => ({ from: 60 + i * 3, to: 63 + i * 3, text: `第${i}段里m保持不变说明向量的变化` }));
  const before = JSON.stringify(cues);
  const quality = assessSubtitles(cues);
  assert.equal(quality.verdict, 'ok');
  assert.equal(quality.warnings.length, 5);
  assert.equal(quality.warnings[0].from, 60);
  assert.equal(quality.warnings[0].to, 63);
  assert.equal(quality.warnings[0].coordinate, 'subtitle-cue-text');
  assert.equal(JSON.stringify(cues), before);
});

test('旧数据按来源段关联提示；复核列表和 Markdown 保留稳定 ID 与停用原因', () => {
  const f = fixture();
  try {
    const result = materializeForSession(f.db, { ...f, rawCards: [f.card, { ...f.card, question: '停用题' }], model: 'test', promptVersion: 'test' });
    f.db.prepare("UPDATE cards SET discarded=1, discard_reason='source-garbled' WHERE id=?").run(result.kept[1]);
    const cards = reviewCards(f.db);
    assert.equal(cards.length, 2);
    assert.ok(cards.every((c) => c.warnings.length && c.warnings[0].from === null));
    assert.equal(cards.filter((c) => !c.discarded).length, 1);
    const md = renderReviewTable(cards);
    for (const id of result.kept) assert.ok(md.includes(id));
    assert.ok(md.includes('source-garbled'));
    assert.ok(md.includes('已停用题目'));
    assert.equal(f.db.prepare('SELECT text FROM contents').get().text, f.content.text);
  } finally { f.db.close(); }
});

test('历史模型判卷为空、JSON损坏、冒充模型时，明确报数据异常且保持原记录', () => {
  const f = fixture();
  try {
    const { kept } = materializeForSession(f.db, { ...f, rawCards: [f.card], model: 'test', promptVersion: 'test' });
    const answer = recordAnswer(f.db, { cardId: kept[0], sessionId: f.sessionId, raw: '自由落脚' });
    for (const bad of [null, '{broken', JSON.stringify({ passed: true, points: [] })]) {
      f.db.prepare("UPDATE answers SET graded_by='model:legacy',rubric_json=? WHERE id=?").run(bad, answer.answerId);
      assert.throws(() => applyModelGrade(f.db, answer.answerId, { passed: false, hit: [], by: 'model:test' }), { code: 'INVALID_STORED_GRADE' });
      assert.equal(f.db.prepare('SELECT rubric_json FROM answers WHERE id=?').get(answer.answerId).rubric_json, bad);
    }
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='answer.regraded'").get().n, 0);
  } finally { f.db.close(); }
});

test('HTTP、自动出题报告传递来源提示；判卷途中遇到历史空结果时逐项失败，不抛 TypeError', async () => {
  const f = fixture();
  const { server, port } = await startServer({ db: f.db, port: 0 });
  const previous = process.env.STUDY_SERVICE_URL;
  process.env.STUDY_SERVICE_URL = `http://127.0.0.1:${port}`;
  try {
    const defs = [];
    let answerId;
    const llm = { stream({ system }) { return (async function* () {
      if (system.startsWith('先为整讲课程整理提要')) {
        yield { type: 'text-delta', text: JSON.stringify(testLesson(f.content.text)) };
      } else if (answerId) {
        f.db.prepare("UPDATE answers SET graded_by='model:legacy',rubric_json=NULL WHERE id=?").run(answerId);
        yield { type: 'text-delta', text: JSON.stringify({ hit: [], assessment: 'incorrect', recognized: '', gap: '', followup: '', note: '' }) };
      } else yield { type: 'text-delta', text: JSON.stringify({ cards: testAssessment([f.card]) }) };
    })(); } };
    apply({ llm, tools: { register: (def) => defs.push(def) } });
    const report = await defs.find((d) => d.name === 'study_generate_cards').execute({ sessionId: f.sessionId }, { signal: new AbortController().signal });
    assert.equal(report.totals.kept, 1);
    assert.equal(report.sourceNoticeCount, 1);
    const review = await (await fetch(`${process.env.STUDY_SERVICE_URL}/review`)).json();
    assert.equal(review.cards[0].reviewPriority, 'check-source');
    assert.equal(review.cards[0].discarded, 0);
    answerId = recordAnswer(f.db, { cardId: review.cards[0].id, sessionId: f.sessionId, raw: '自由落脚' }).answerId;
    const graded = await defs.find((d) => d.name === 'study_grade_subjective').execute({ sessionId: f.sessionId }, { signal: new AbortController().signal });
    assert.equal(graded.failed, 1);
    assert.equal(graded.graded, 0);
    assert.match(graded.items[0].reason, /audit required/);
  } finally {
    if (previous === undefined) delete process.env.STUDY_SERVICE_URL; else process.env.STUDY_SERVICE_URL = previous;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    f.db.close();
  }
});

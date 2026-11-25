import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generationResult } from '../plugin/generation-result.js';
import { apply } from '../plugin/worker.js';
import { buildSummaryPrompt, SUMMARY_PROMPT } from '../plugin/lesson-core.js';
import { applyEvent } from '../server/core/events.mjs';
import { createSession, attachContent } from '../server/core/store.mjs';
import { saveModelSettings } from '../server/core/model-settings.mjs';
import { captureAction, generationState, generationQueue, claimGeneration, finishGeneration } from '../server/core/capture-controls.mjs';
import { startServer } from '../server/http/server.mjs';
import { m2Fixture } from './m2-fixture.mjs';
import { panelHarness } from './panel-harness.mjs';
import { openDb } from '../server/db/open.mjs';

test('正常不出题、模型故障及题目被质量检查丢弃分别处理，不把部分失败藏成跳过', () => {
  const report = { totals: { kept: 0, skipped: 0, failed: 0, discarded: 0, abstained: 1 }, segments: [{ abstained: true, reason: '仅开场介绍，尚未展开论证' }] };
  assert.deepEqual(generationResult(report), { failed: false, outcome: 'abstained', reason: '仅开场介绍，尚未展开论证' });
  assert.equal(generationResult({ ...report, totals: { ...report.totals, failed: 1 } }).outcome, 'failed');
  assert.equal(generationResult({ ...report, totals: { ...report.totals, discarded: 2 } }).outcome, 'failed');
  assert.equal(generationResult({ ...report, totals: { ...report.totals, kept: 1 } }).outcome, 'completed');
  assert.equal(generationResult({ ...report, totals: { ...report.totals, skipped: 1 } }).outcome, 'completed');
  assert.match(buildSummaryPrompt([{ text: '开场' }]), /可能只是整讲的一部分/);
  assert.match(SUMMARY_PROMPT, /不以有公式或操作步骤为门槛/);
});

function emptySession(db, courseId, count = 1) {
  const sessionId = createSession(db, { courseId });
  const text = '欢迎同学们，本节课先介绍一本书的作者和接下来准备讨论的问题。';
  attachContent(db, sessionId, { text, normalizerVersion: 1 });
  const ids = Array.from({ length: count }, () => randomUUID());
  ids.forEach((id, seq) => db.prepare('INSERT INTO segments VALUES (?,?,?,?,?,?,?)').run(id, sessionId, seq, 'fixture', text, 0, text.length));
  return { sessionId, ids };
}

test('旧失败记录能只读恢复完整弃权原因；部分弃权不掩盖真失败，重开库不丢状态', () => {
  const f = m2Fixture(); let db = f.db;
  try {
    const { sessionId, ids } = emptySession(db, f.course.id);
    applyEvent(db, { type: 'generation.requested', payload: { id: 'old', sessionId } });
    const claim = claimGeneration(db, 'old');
    applyEvent(db, { type: 'abstained', payload: { sessionId, segmentId: ids[0], reason: '开场与作者简介，尚无展开的观点' } });
    finishGeneration(db, 'old', true, claim.token);
    const before = db.prepare('SELECT COUNT(*) n FROM events').get().n;
    assert.equal(generationState(db).state, 'no-questions');
    assert.match(generationState(db).reason, /作者简介/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, before);
    db.close(); db = openDb(f.file).db;
    assert.equal(generationState(db).state, 'no-questions');
    const partial = emptySession(db, f.course.id, 2);
    applyEvent(db, { type: 'generation.requested', payload: { id: 'partial', sessionId: partial.sessionId } });
    const next = claimGeneration(db, 'partial');
    applyEvent(db, { type: 'abstained', payload: { sessionId: partial.sessionId, segmentId: partial.ids[0], reason: '首段不足' } });
    finishGeneration(db, 'partial', true, next.token);
    assert.equal(generationState(db).state, 'failed');
  } finally { db.close(); }
});

test('真实HTTP和面板串通正常弃权、原因展示、重复出题零额外调用，后续采集仍可出题', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = m2Fixture(); saveModelSettings(f.db, { tasks: {}, autoResearch: false });
  let now = Date.now(), calls = 0;
  const lines = ['今天先向大家问好，感谢各位来到这次讲座。', '正式展开内容前，我想介绍接下来会讨论的几个问题。',
    '路过商场时我拍了一张照片，同学们可以先看一看。', '为什么会出现这样的现象呢，我们后面的讲解再讨论。',
    '这本书是今天想向大家介绍的作品，先看它的封面。', '下面简单介绍一下作者的个人经历，方便大家认识他。',
    '作者在不同的学校读书和任教，这些是课程的背景。', '这部分开场即将结束，接下来准备进入具体讲解。'];
  const { server, port, collector } = await startServer({ db: f.db, port: 0, collectorOptions: { now: () => now,
    getVideo: async () => ({ title: '讲座开场隔离测试', pages: [{ page: 1 }] }),
    getSubtitle: async () => ({ ok: true, cues: lines.map((text, i) => ({ from: i * 7, to: i * 7 + 6, text: text + '这部分用于交代讲座背景，还没有开始分析前面提到的现象。' })) }),
  } });
  const base = 'http://127.0.0.1:' + port, previous = process.env.STUDY_SERVICE_URL;
  process.env.STUDY_SERVICE_URL = base;
  const reason = '这部分仅为开场提问和作者简介，尚未展开知识或论证。';
  apply({ tools: { register() {} }, effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') t.after(cleanup); },
    llm: { stream() { calls++; return (async function* () { yield { type: 'text-delta', text: JSON.stringify({ abstain: reason }) }; })(); } },
  });
  let ui;
  const play = () => { for (let i = 0; i <= 12; i++) { now += 5000; collector.observe({ url: 'https://www.bilibili.com/video/BV1ib411t7YR/', position: i * 5, rate: 1, visible: true, focused: true, playing: true, idleState: 'active' }); } };
  try {
    const answers = f.db.prepare('SELECT COUNT(*) n FROM answers').get().n;
    await captureAction(f.db, collector, 'start'); play(); await captureAction(f.db, collector, 'stop');
    const target = await captureAction(f.db, collector, 'questions'); t.mock.timers.tick(30000);
    for (let i = 0; i < 200 && ['queued', 'processing'].includes(generationState(f.db)?.state); i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(generationState(f.db).state, 'no-questions'); assert.equal(generationState(f.db).reason, reason);
    assert.equal(calls, 1);
    const outcome = JSON.parse(f.db.prepare("SELECT payload_json FROM events WHERE type='generation.finished' ORDER BY rowid DESC LIMIT 1").get().payload_json);
    assert.equal(outcome.failed, false); assert.equal(outcome.outcome, 'abstained');
    const repeated = await (await fetch(base + '/panel/capture/questions', { method: 'POST', body: '{}' })).json();
    assert.equal(repeated.noQuestions, true); assert.equal(generationQueue(f.db).length, 0);
    t.mock.timers.tick(30000); await new Promise(r => setTimeout(r, 30)); assert.equal(calls, 1);
    ui = panelHarness({ base, storage: new Map([['study.m2.7788.view', 'study'], ['study.m2.7788.session', target.sessionId], ['study.m2.7788.course', target.courseId]]) });
    await ui.settle(); assert.match(ui.text(), /本段暂不出题/); assert.ok(ui.text().includes(reason));
    assert.ok(!ui.text().includes('出题未完成'));
    await ui.click('返回总览继续采集'); assert.ok(!ui.all(n => n.type === 'button' && ui.text(n) === '出题').length);
    await ui.click('开始采集'); assert.equal(generationState(f.db), null);
    play(); await captureAction(f.db, collector, 'stop');
    const next = await captureAction(f.db, collector, 'questions');
    assert.notEqual(next.sessionId, target.sessionId); assert.equal(generationState(f.db).state, 'queued');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM answers').get().n, answers);
  } finally {
    ui?.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.db.close();
    if (previous === undefined) delete process.env.STUDY_SERVICE_URL; else process.env.STUDY_SERVICE_URL = previous;
  }
});

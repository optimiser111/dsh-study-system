import test from 'node:test';
import assert from 'node:assert/strict';
import { m2Fixture } from './m2-fixture.mjs';
import { startServer } from '../server/http/server.mjs';
import { panelHarness } from './panel-harness.mjs';
import { modelSettings, saveModelSettings } from '../server/core/model-settings.mjs';
import { researchQueue, requestResearch } from '../server/core/research.mjs';
import { applyEvent } from '../server/core/events.mjs';
import { readModelCatalog } from '../plugin/index.js';
import { createSession, attachContent } from '../server/core/store.mjs';

test('其他提供方目录卡住不阻止已登录ChatGPT目录返回，故障恢复后重新读取', async () => {
  let slow = true;
  const llm = { listProviders: () => [{ id: 'chatgpt', name: 'ChatGPT' }, { id: 'slow', name: 'Slow' }],
    listModels: (provider) => provider === 'slow' && slow ? new Promise(() => {}) : Promise.resolve([{ id: 'model', name: 'Model' }]) };
  const first = await readModelCatalog(llm, 10);
  assert.equal(first[0].models.length, 1);
  assert.match(first[1].error, /超时/);
  slow = false;
  assert.equal((await readModelCatalog(llm, 10))[1].models.length, 1);
});

test('模型设置持久化、拒绝无效输入，自动导航关闭后仍可明确提交', () => {
  const f = m2Fixture();
  try {
    assert.deepEqual(modelSettings(f.db), { tasks: {}, autoResearch: true });
    applyEvent(f.db, { type: 'capture.imported', payload: { sessionId: f.sessionId } });
    assert.equal(researchQueue(f.db).length, 1);
    const settings = { tasks: { navigation: { provider: 'chatgpt', model: 'test-model' } }, autoResearch: false };
    saveModelSettings(f.db, settings);
    assert.deepEqual(modelSettings(f.db), settings);
    assert.equal(researchQueue(f.db).length, 0);
    assert.throws(() => saveModelSettings(f.db, { ...settings, tasks: { grading: { provider: '', model: 'x' } } }), /标识/);
    assert.deepEqual(modelSettings(f.db), settings);
    requestResearch(f.db, f.sessionId);
    assert.equal(researchQueue(f.db).length, 1);
  } finally { f.db.close(); }
});

test('重新开启只自动处理之后的新采集，旧材料可显式补建，开关状态在总览可见', async () => {
  const f = m2Fixture();
  const { server, port } = await startServer({ db: f.db, port: 0 });
  const ui = panelHarness({ base: 'http://127.0.0.1:' + port });
  try {
    applyEvent(f.db, { type: 'capture.imported', payload: { sessionId: f.sessionId } });
    saveModelSettings(f.db, { tasks: {}, autoResearch: false });
    await ui.settle(); assert.match(ui.text(), /自动知识导航已关闭/);
    saveModelSettings(f.db, { tasks: {}, autoResearch: true });
    assert.equal(researchQueue(f.db).length, 0);
    const next = createSession(f.db, { courseId: f.course.id });
    attachContent(f.db, next, { text: '新采集的课程材料', normalizerVersion: 1 });
    applyEvent(f.db, { type: 'capture.imported', payload: { sessionId: next } });
    assert.equal(researchQueue(f.db)[0].sessionId, next);
    saveModelSettings(f.db, { tasks: {}, autoResearch: true });
    assert.equal(researchQueue(f.db)[0].sessionId, next);
    requestResearch(f.db, f.sessionId);
    assert.equal(researchQueue(f.db)[0].sessionId, f.sessionId);
  } finally { ui.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.db.close(); }
});

test('面板使用宿主目录，三个任务独立保存', async () => {
  const f = m2Fixture();
  const { server, port } = await startServer({ db: f.db, port: 0 });
  await fetch('http://127.0.0.1:' + port + '/panel/models/catalog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providers: [{ id: 'chatgpt', name: 'ChatGPT', models: [{ id: 'fixture', name: 'Fixture GPT' }] }] }) });
  const ui = panelHarness({ base: 'http://127.0.0.1:' + port, connection: { online: true, catalog: [{ id: 'chatgpt', name: 'ChatGPT', models: [{ id: 'fixture', name: 'Fixture GPT' }] }] } });
  try {
    await ui.settle(); await ui.click('设置');
    assert.ok(ui.text().includes('Fixture GPT'));
    for (const label of ['课程提要与出题模型', '主观判卷与追问模型', '联网知识导航模型']) {
      ui.all((n) => n.type === 'select' && n.props['aria-label'] === label)[0].props.onChange({ target: { value: JSON.stringify(['chatgpt', 'fixture']) } });
      await ui.settle();
    }
    ui.all((n) => n.type === 'input' && n.props.type === 'checkbox')[0].props.onChange({ target: { checked: false } });
    await ui.settle();
    ui.all((n) => n.type === 'select' && n.props['aria-label'] === '知识导航搜索来源')[0].props.onChange({ target: { value: 'chatgpt' } });
    await ui.settle(); await ui.click('保存模型设置');
    const saved = await (await fetch('http://127.0.0.1:' + port + '/panel/models/settings')).json();
    assert.equal(saved.autoResearch, false);
    assert.equal(saved.searchProvider, 'chatgpt');
    assert.deepEqual(Object.values(saved.tasks), Array(3).fill({ provider: 'chatgpt', model: 'fixture' }));
    assert.ok(ui.text().includes('已保存'));
  } finally { ui.dispose(); server.closeAllConnections(); await new Promise((r) => server.close(r)); f.db.close(); }
});

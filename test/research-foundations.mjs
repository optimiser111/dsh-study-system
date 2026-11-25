import test from 'node:test';
import assert from 'node:assert/strict';
import { m2Fixture } from './m2-fixture.mjs';
import { researchInput, saveResearch, researchView, assessResearchKnowledge, checkResearchKnowledge } from '../server/core/research.mjs';
import { startServer } from '../server/http/server.mjs';
import { panelHarness } from './panel-harness.mjs';

function seed(f, subject = 'math') {
  const input = researchInput(f.db, f.sessionId), support = [{ sourceId: 's', quote: 'Test fixture source for prerequisite relationships.' }];
  return saveResearch(f.db, f.sessionId, { key: input.key, subject, confidence: .99, reason: '测试前置补全',
    sources: [{ id: 's', url: 'https://ocw.mit.edu/fixture', title: '测试资料', publisher: 'MIT', authority: '测试来源', content: support[0].quote, fetchedAt: new Date().toISOString() }],
    nodes: [{ id: 'advanced', subject, title: subject === 'math' ? '二重积分' : '谐振子', courseQuote: input.text.slice(0, 30), description: '测试高级课程', support },
      { id: 'parent', subject, title: subject === 'math' ? '导数' : '牛顿定律', description: '测试前置', support }],
    edges: [{ from: 'parent', to: 'advanced', kind: 'prerequisite', reason: '测试先修关系', support }] });
}

test('联网图自动递归补数学前置、复用同义概念；未虚构课程涉及或掌握，不修改原图和XP', () => {
  const f = m2Fixture();
  try {
    const saved = seed(f), xp = f.db.prepare('SELECT SUM(delta) n FROM xp_ledger').get().n;
    const map = researchView(f.db, 'math');
    for (const title of ['函数与图像', '极限与连续', '积分与累积', '偏导数', '数与代数运算']) {
      const n = map.nodes.find((n) => n.title === title);
      assert.equal(n.status, 'assumed'); assert.equal(n.origin, 'catalog-prerequisite'); assert.equal(n.courseQuote, null);
    }
    assert.equal(map.nodes.filter((n) => n.catalogId === 'derivatives').length, 1);
    assert.equal(map.nodes.find((n) => n.title === '二重积分').status, 'encountered');
    assert.ok(!map.nodes.some((n) => n.title.includes('矩阵')));
    assert.equal(JSON.parse(f.db.prepare("SELECT payload_json FROM events WHERE type='research.completed'").get().payload_json).nodes.length, saved.nodes.length);
    assert.equal(f.db.prepare('SELECT SUM(delta) n FROM xp_ledger').get().n, xp);
  } finally { f.db.close(); }
});

test('前置可自评、撤销及自检，沿用原数学记录，不发XP；其他学科也可确认前置', () => {
  for (const subject of ['math', '物理']) {
    const f = m2Fixture();
    try {
      seed(f, subject); const map = researchView(f.db, subject), parent = map.nodes.find((n) => n.title === (subject === 'math' ? '导数' : '牛顿定律'));
      assert.equal(parent.status, 'assumed');
      assessResearchKnowledge(f.db, parent.id, { state: 'self-known' });
      assert.equal(researchView(f.db, subject).nodes.find((n) => n.id === parent.id).status, 'self-confirmed');
      assessResearchKnowledge(f.db, parent.id, { state: 'needs-review' });
      assert.equal(researchView(f.db, subject).nodes.find((n) => n.id === parent.id).status, 'needs-review');
      assessResearchKnowledge(f.db, parent.id, { state: 'clear' });
      assert.equal(researchView(f.db, subject).nodes.find((n) => n.id === parent.id).status, 'assumed');
      if (subject === 'math') {
        checkResearchKnowledge(f.db, parent.id, { answer: 'B' });
        assert.equal(researchView(f.db, subject).nodes.find((n) => n.id === parent.id).status, 'checked');
      }
      assert.throws(() => assessResearchKnowledge(f.db, parent.id, { state: 'mastered' }));
    } finally { f.db.close(); }
  }
});

test('实际面板可点击补全节点确认基础，前置在下高级在上', async () => {
  const f = m2Fixture(); seed(f);
  const { server, port } = await startServer({ db: f.db, port: 0 }); const ui = panelHarness({ base: 'http://127.0.0.1:' + port });
  try {
    await ui.settle(); await ui.click('知识树');
    const graph = researchView(f.db, 'math'), parent = graph.nodes.find((n) => n.title === '函数与图像'), advanced = graph.nodes.find((n) => n.title === '二重积分');
    const shown = (id) => ui.all((n) => n.type === 'g' && n.props['data-knowledge-node'] === id)[0];
    const y = (id) => Number(shown(id).props.transform.match(/translate\([^,]+,([^\)]+)\)/)[1]);
    assert.ok(y(advanced.id) < y(parent.id));
    shown(parent.id).props.onClick(); await ui.settle();
    await ui.click('我已掌握（自评）');
    assert.equal(researchView(f.db, 'math').nodes.find((n) => n.id === parent.id).status, 'self-confirmed');
    assert.equal(ui.sent.length, 0);
    assert.ok(ui.text().includes('自动补出的前置仍为推测具备'));
  } finally { ui.dispose(); server.closeAllConnections(); await new Promise((r) => server.close(r)); f.db.close(); }
});

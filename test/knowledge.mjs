import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db/open.mjs';
import { CATALOG, NODE_BY_ID, ancestors, matchKnowledge } from '../server/core/knowledge-catalog.mjs';
import { knowledgeMap, setKnowledgeCurrent, assessKnowledge, checkKnowledge } from '../server/core/knowledge.mjs';
import { startServer } from '../server/http/server.mjs';
import { panelHarness } from './panel-harness.mjs';
import { m2Fixture } from './m2-fixture.mjs';

test('知识路径引用有效且无环；线代不强行依赖微积分，主题匹配优先具体概念', () => {
  assert.equal(new Set(CATALOG.map((n) => n.id)).size, CATALOG.length);
  for (const node of CATALOG) {
    const visit = (id, path = new Set()) => {
      assert.ok(!path.has(id), 'prerequisite cycle'); const next = new Set([...path, id]);
      for (const parent of NODE_BY_ID.get(id).prerequisites) {
        assert.ok(NODE_BY_ID.has(parent));
        assert.ok(NODE_BY_ID.get(id).position[1] < NODE_BY_ID.get(parent).position[1], '高级节点必须在其先修节点上方');
        visit(parent, next);
      }
    };
    visit(node.id); assert.ok(node.position.every(Number.isFinite));
    assert.equal(node.check.options.length, 4);
  }
  assert.ok(ancestors('double-integrals').has('derivatives'));
  assert.equal(ancestors('linear-transformations').has('derivatives'), false);
  assert.equal(matchKnowledge('偏导数：固定其他变量再求导数'), 'partials');
  assert.equal(matchKnowledge('高数'), null);
  const { projectPoint } = panelHarness().mapMath;
  const origin = [0,1,2].map((axis) => (Math.min(...CATALOG.map((n) => n.position[axis])) + Math.max(...CATALOG.map((n) => n.position[axis]))) / 2);
  for (const node of CATALOG) for (const parent of node.prerequisites) {
    const childScreen = projectPoint(node.position, { yaw: -.18, pitch: -.08, zoom: 1 }, origin);
    const parentScreen = projectPoint(NODE_BY_ID.get(parent).position, { yaw: -.18, pitch: -.08, zoom: 1 }, origin);
    assert.ok(childScreen.y < parentScreen.y, '默认视角也必须高级向上：' + parent + ' -> ' + node.id);
  }
});

test('节点点击不被画布捕获；双击选中并聚焦，不改学习起点；无网格或文字黑底', async () => {
  const f = m2Fixture(); const { server, port } = await startServer({ db: f.db, port: 0 });
  const ui = panelHarness({ base: `http://127.0.0.1:${port}` });
  try {
    await ui.settle(); await ui.click('知识树');
    const svg = ui.all((n) => n.type === 'svg' && n.props.ref)[0], dom = svg.props.ref.current;
    assert.equal(ui.all((n) => n.type === 'line').length, 0);
    assert.equal(ui.all((n) => n.type === 'rect').length, 0);
    const initial = knowledgeMap(f.db).current.nodeId;
    const node = ui.all((n) => n.props['data-knowledge-node'] === 'derivatives')[0];
    svg.props.onPointerDown({ button: 0, pointerId: 8, clientX: 100, clientY: 100, currentTarget: dom });
    assert.equal(dom.hasPointerCapture(8), false);
    svg.props.onPointerUp({ pointerId: 8, currentTarget: dom });
    node.props.onClick(); await ui.settle();
    assert.equal(ui.all((n) => n.type === 'select' && n.props['aria-label'] === '选择知识点')[0].props.value, 'derivatives');
    node.props.onDoubleClick({ preventDefault() {}, stopPropagation() {} }); await ui.settle();
    assert.ok(ui.text().includes('ZOOM 115%'));
    assert.equal(ui.all((n) => n.type === 'select' && n.props['aria-label'] === '选择知识点')[0].props.value, 'derivatives');
    assert.equal(knowledgeMap(f.db).current.nodeId, initial);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type LIKE 'knowledge.%'").get().n, 0);
    const focused = ui.all((n) => n.props['data-knowledge-node'] === 'derivatives')[0];
    assert.equal(focused.props['aria-pressed'], true); assert.equal(focused.props.style.outline, 'none');
    svg.props.onPointerDown({ button: 0, pointerId: 9, clientX: 100, clientY: 100, currentTarget: dom });
    svg.props.onPointerMove({ pointerId: 9, clientX: 125, clientY: 115 });
    assert.equal(dom.hasPointerCapture(9), true);
    svg.props.onPointerUp({ pointerId: 9, currentTarget: dom });
  } finally { ui.dispose(); server.closeAllConnections(); await new Promise((r) => server.close(r)); f.db.close(); }
});

test('高级起点只推测前置；自评持久化可撤销；新自检错误能覆盖旧自评，且不发XP/改成绩', () => {
  const f = m2Fixture(); let db = f.db;
  try {
    const rows = JSON.stringify(db.prepare('SELECT * FROM answers ORDER BY id').all());
    const xp = db.prepare('SELECT SUM(delta) n FROM xp_ledger').get().n;
    let map = setKnowledgeCurrent(db, { nodeId: 'double-integrals' });
    assert.equal(map.current.source, 'manual'); assert.equal(map.nodes.find((n) => n.id === 'derivatives').status, 'assumed');
    assert.equal(map.nodes.find((n) => n.id === 'derivatives').evidence, null);
    assessKnowledge(db, 'derivatives', { state: 'self-known' });
    db.close(); db = openDb(f.file).db;
    assert.equal(knowledgeMap(db).nodes.find((n) => n.id === 'derivatives').status, 'self-confirmed');
    const failed = checkKnowledge(db, 'derivatives', { answer: 'A' });
    assert.equal(failed.result.correct, false); assert.equal(failed.map.nodes.find((n) => n.id === 'derivatives').status, 'needs-review');
    assessKnowledge(db, 'derivatives', { state: 'clear' });
    const passed = checkKnowledge(db, 'derivatives', { answer: 'B' });
    assert.equal(passed.map.nodes.find((n) => n.id === 'derivatives').status, 'checked');
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM answers ORDER BY id').all()), rows);
    assert.equal(db.prepare('SELECT SUM(delta) n FROM xp_ledger').get().n, xp);
    const automatic = setKnowledgeCurrent(db, { nodeId: null });
    assert.equal(automatic.current.source, 'recent-question');
    assert.throws(() => assessKnowledge(db, 'derivatives', { state: 'mastered-by-model' }));
    assert.throws(() => setKnowledgeCurrent(db, { nodeId: 'nonexistent' }));
  } finally { db.close(); }
});

test('题目/证据定位不虚构掌握，知识API不泄露自检答案，拒绝无效课程/答案', async () => {
  const f = m2Fixture(); const { server, port } = await startServer({ db: f.db, port: 0 }); const base = `http://127.0.0.1:${port}`;
  try {
    const map = knowledgeMap(f.db);
    assert.ok(map.current); assert.ok(map.nodes.find((n) => n.id === 'addition').relatedSessions.length);
    assert.equal(map.nodes.find((n) => n.id === 'addition').status, 'needs-review');
    const response = await fetch(base + '/panel/knowledge'); const body = await response.json();
    assert.equal(response.status, 200); assert.equal(Object.hasOwn(body.nodes[0].check, 'answer'), false);
    assert.equal(Object.hasOwn(body.nodes[0].check, 'explanation'), false);
    assert.equal((await fetch(base + '/panel/knowledge?courseId=unknown')).status, 400);
    assert.equal((await fetch(base + '/panel/knowledge/derivatives/check', { method: 'POST', body: JSON.stringify({ answer: 'Q' }) })).status, 400);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type LIKE 'knowledge.%'").get().n, 0);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); f.db.close(); }
});

test('真实3D透视、缩放上下限与邻域；实际鼠标回调旋转、非被动滚轮阻止页面滚动', async () => {
  const f = m2Fixture(); const { server, port } = await startServer({ db: f.db, port: 0 });
  const ui = panelHarness({ base: `http://127.0.0.1:${port}` });
  try {
    const { projectPoint, zoomCamera } = ui.mapMath;
    const near = projectPoint([100,0,-200], { yaw: 0, pitch: 0, zoom: 1 });
    const far = projectPoint([100,0,200], { yaw: 0, pitch: 0, zoom: 1 });
    assert.ok(near.x > far.x); assert.ok(near.scale > far.scale);
    let camera = { yaw: 0, pitch: 0, zoom: 1 };
    for (let i = 0; i < 80; i++) camera = zoomCamera(camera, -10000);
    assert.equal(camera.zoom, 3.5);
    for (let i = 0; i < 80; i++) camera = zoomCamera(camera, 10000);
    assert.equal(camera.zoom, .35);
    await ui.settle(); await ui.click('知识树');
    const svg = ui.all((n) => n.type === 'svg' && n.props.ref)[0]; const dom = svg.props.ref.current;
    const listener = dom.listeners.get('wheel'); assert.equal(listener.options.passive, false);
    let prevented = false, stopped = false;
    listener.handler({ deltaY: -180, deltaMode: 0, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
    await ui.settle(); assert.ok(prevented && stopped); assert.ok(!ui.text().includes('ZOOM 100%'));
    const before = ui.all((n) => n.type === 'g' && n.props.role === 'button').map((n) => n.props.transform).join();
    svg.props.onPointerDown({ button: 0, pointerId: 1, clientX: 100, clientY: 100, currentTarget: dom });
    svg.props.onPointerMove({ pointerId: 1, clientX: 160, clientY: 120 });
    svg.props.onPointerUp({ pointerId: 1, currentTarget: dom }); await ui.settle();
    const after = ui.all((n) => n.type === 'g' && n.props.role === 'button').map((n) => n.props.transform).join();
    assert.notEqual(before, after);
    const selection = ui.all((n) => n.type === 'select' && n.props['aria-label'] === '选择知识点')[0].props.value;
    ui.all((n) => n.type === 'g' && n.props.role === 'button')[0].props.onClick(); await ui.settle();
    assert.equal(ui.all((n) => n.type === 'select' && n.props['aria-label'] === '选择知识点')[0].props.value, selection);
    await ui.click('定位当前'); assert.ok(ui.text().includes('ZOOM 100%'));
    await ui.click('全部路径'); assert.equal(ui.all((n) => n.type === 'g' && n.props.role === 'button').length, CATALOG.length);
  } finally { ui.dispose(); server.closeAllConnections(); await new Promise((r) => server.close(r)); f.db.close(); }
});

test('面板可跨级定位、确认基础、自检并恢复；不产生模型请求或正式作答', async () => {
  const f = m2Fixture(); const { server, port } = await startServer({ db: f.db, port: 0 });
  const base = `http://127.0.0.1:${port}`; let ui = panelHarness({ base });
  try {
    await ui.settle();
    ui.all((n) => n.props['aria-label'] === '查看数学知识树')[0].props.onClick();
    await ui.settle();
    let select = ui.all((n) => n.type === 'select' && n.props['aria-label'] === '选择知识点')[0];
    select.props.onChange({ target: { value: 'double-integrals' } }); await ui.settle(); await ui.click('设为学习起点');
    select = ui.all((n) => n.type === 'select' && n.props['aria-label'] === '选择知识点')[0];
    select.props.onChange({ target: { value: 'derivatives' } }); await ui.settle();
    assert.ok(ui.text().includes('尚未确认掌握'));
    await ui.click('我已掌握（自评）');
    assert.equal(knowledgeMap(f.db).nodes.find((n) => n.id === 'derivatives').status, 'self-confirmed');
    await ui.click('撤销自评'); await ui.click('做一道自检');
    ui.all((n) => n.type === 'input' && n.props.name === 'knowledge-check-derivatives' && n.props.value === 'B')[0].props.onChange();
    await ui.settle(); await ui.click('提交自检'); assert.ok(ui.text().includes('最近一次自检：答对'));
    const storage = ui.storage; ui.dispose(); ui = panelHarness({ base, storage }); await ui.settle();
    assert.equal(knowledgeMap(f.db, f.course.id).current.nodeId, 'double-integrals');
    assert.equal(knowledgeMap(f.db).current.nodeId, 'addition'); // 当前课程定位不覆盖全局定位。
    assert.equal(knowledgeMap(f.db).nodes.find((n) => n.id === 'derivatives').status, 'checked');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM answers').get().n, 3);
    assert.equal(ui.sent.length, 0);
  } finally { ui.dispose(); server.closeAllConnections(); await new Promise((r) => server.close(r)); f.db.close(); }
});

test('知识树原生全屏及受限宿主回退：Esc退出、选中与缩放保留，画布随尺寸重算且不写学习记录', async () => {
  const f = m2Fixture(); const { server, port } = await startServer({ db: f.db, port: 0 });
  const before = f.db.prepare('SELECT COUNT(*) n FROM events').get().n;
  try {
    for (const nativeFullscreen of [true, false]) {
      const ui = panelHarness({ base: `http://127.0.0.1:${port}`, nativeFullscreen });
      try {
        await ui.settle(); await ui.click('知识树');
        const node = ui.all((n) => n.props['data-knowledge-node'] === 'derivatives')[0];
        node.props.onDoubleClick({ preventDefault() {}, stopPropagation() {} }); await ui.settle();
        await ui.click('+');
        const zoom = ui.all((n) => n.type === 'text' && ui.text(n).includes('ORBIT'))[0];
        const zoomText = ui.text(zoom);
        await ui.click('全屏查看');
        const graph = () => ui.all((n) => n.props['aria-label'] === '三维知识科技树')[0];
        assert.equal(graph().props['data-fullscreen'], true);
        if (nativeFullscreen) assert.equal(ui.document.fullscreenElement, graph().props.ref.current);
        const svg = ui.all((n) => n.type === 'svg' && n.props.ref)[0];
        ui.resize(svg.props.ref.current, 1800, 760); await ui.settle();
        assert.equal(ui.all((n) => n.type === 'svg' && n.props.ref)[0].props.viewBox, '0 0 1800 760');
        if (nativeFullscreen) await ui.document.exitFullscreen();
        else ui.document.dispatch('keydown', { key: 'Escape' });
        await ui.settle();
        assert.equal(graph().props['data-fullscreen'], false);
        assert.equal(ui.all((n) => n.props['aria-label'] === '选择知识点')[0].props.value, 'derivatives');
        assert.equal(ui.text(ui.all((n) => n.type === 'text' && ui.text(n).includes('ORBIT'))[0]), zoomText);
        await ui.click('全屏查看'); await ui.click('退出全屏');
        assert.equal(graph().props['data-fullscreen'], false);
        assert.equal(ui.sent.length, 0);
      } finally { ui.dispose(); assert.equal(ui.document.listeners.get('keydown').size, 0); }
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM events').get().n, before);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); f.db.close(); }
});

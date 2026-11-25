import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, inject } from '../plugin/index.js';
import { inject as workerInject } from '../plugin/worker.js';
import { m2Fixture } from './m2-fixture.mjs';
import { startServer } from '../server/http/server.mjs';
import { panelHarness } from './panel-harness.mjs';

test('宿主启动只依赖connection，模型未就绪时也注册桌面和网页共用的恢复通道', async () => {
  assert.deepEqual(inject, ['connection']);
  assert.deepEqual(workerInject, ['tools', 'llm']);
  const previous = process.env.STUDY_SERVICE_URL;
  process.env.STUDY_SERVICE_URL = 'http://127.0.0.1:19999';
  const routes = [], effects = [];
  try {
    apply({
      connection: { rpc: { handle: (channel, handler) => { routes.push({ channel, handler }); return () => {}; } } },
      effect: (setup) => effects.push(setup()),
      inject(names) { assert.deepEqual(names, ['tools', 'llm']); },
    });
    assert.equal(routes[0].channel, '/study-services');
    assert.equal((await routes[0].handler('start', { port: '9999' })).ok, false);
    assert.equal((await routes[0].handler('other', { port: '7788' })).ok, false);
  } finally {
    effects.forEach((cleanup) => cleanup?.());
    if (previous === undefined) delete process.env.STUDY_SERVICE_URL; else process.env.STUDY_SERVICE_URL = previous;
  }
});

test('打开面板遇到服务离线时请求宿主启动，合并并发恢复，并在再次掉线后重新拉起', async () => {
  const f = m2Fixture();
  const { server, port } = await startServer({ db: f.db, port: 0 });
  const connection = { online: false, startups: 0 };
  const ui = panelHarness({ base: 'http://127.0.0.1:' + port, connection });
  try {
    await ui.settle();
    assert.ok(ui.text().includes('学习总览'));
    assert.ok(ui.text().includes('数学'));
    assert.equal(connection.startups, 1);
    assert.equal(ui.calls.find((c) => c.channel === '/study-services').payload.port, '7788');
    connection.online = false;
    await ui.click('刷新');
    assert.equal(connection.startups, 2);
    assert.ok(ui.text().includes('数学'));
  } finally { ui.dispose(); server.closeAllConnections(); await new Promise((r) => server.close(r)); f.db.close(); }
});

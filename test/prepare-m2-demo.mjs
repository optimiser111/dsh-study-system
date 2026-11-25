// 仅在全新.probe库创建有明确标记的演示数据，不读取或写入正式学习库。
import fs from 'node:fs';
import { m2Fixture } from './m2-fixture.mjs';
import { workspaceView } from '../server/core/workspace.mjs';
const f = m2Fixture({ demo: true });
try {
  const view = workspaceView(f.db);
  const report = { evidence: 'original fixture with fixed cards and simulated attempts',
    database: f.file, dataDir: f.dir, sessionId: f.sessionId, base: 'http://127.0.0.1:7789',
    due: view.due.length, xp: view.xp, demoOnly: true };
  fs.mkdirSync(new URL('../.probe/m1-evidence/', import.meta.url), { recursive: true });
  fs.writeFileSync(new URL('../.probe/m1-evidence/m2-demo-ready.json', import.meta.url), JSON.stringify(report, null, 2));
  fs.writeFileSync(f.dir + '/manifest.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { f.db.close(); }

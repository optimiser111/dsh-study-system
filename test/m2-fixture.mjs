import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDb } from '../server/db/open.mjs';
import { upsertCourse, saveSource, createSession, attachContent, materializeForSession, recordAnswer } from '../server/core/store.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
export function m2Fixture({ demo = false } = {}) {
  const dir = path.join(root, '.probe', (demo ? 'm2-demo-' : 'm2-test-') + randomUUID()); fs.mkdirSync(dir, { recursive: true });
  const { db, file } = openDb(path.join(dir, 'study.db'));
  const sample = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/m1-understanding.json'), 'utf8'));
  const text = fs.readFileSync(path.join(root, 'fixtures/lecture-p2.txt'), 'utf8');
  const course = upsertCourse(db, { platform: 'fixture', externalId: 'm2-p2', title: demo ? 'P2 · M2试用数据（非个人成绩）' : 'P2 fixture', axis: 'math' });
  const sourceId = saveSource(db, { courseId: course.id, kind: 'bilibili-cc', status: 'ok', detail: '使用自编的课程测试文本和固定题，预设作答仅供隔离测试' });
  const sessionId = createSession(db, { courseId: course.id, sourceId, startedAt: Date.now() - 2 * 86400000 });
  const content = { text, normalizerVersion: 1 }; attachContent(db, sessionId, content);
  db.prepare('INSERT INTO segments VALUES (?,?,?,?,?,?,?)').run(randomUUID(), sessionId, 0, 'bilibili-cc', text, 0, text.length);
  const { kept } = materializeForSession(db, { sessionId, content, rawCards: sample.cards, model: 'manual:Codex-fixed-fixture', promptVersion: 'm1-cards-v7' });
  if (kept.length !== 4) throw new Error('M2 fixture failed');
  for (let i = 0; i < 3; i++) recordAnswer(db, { cardId: kept[i], sessionId, raw: ['A', 'B', 'C', 'D'].find((x) => x !== sample.cards[i].answer), now: Date.now() - 2 * 86400000 });
  return { db, file, dir, course, sessionId, cards: kept, sample };
}

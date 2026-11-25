import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
export function collectorKeyFile(db) {
  const file = db.prepare('PRAGMA database_list').all().find((r) => r.name === 'main')?.file;
  if (!file) throw new Error('collector requires a file database');
  return path.join(path.dirname(file), 'collector.key');
}
export function getCollectorKey(db, create = false) {
  const file = collectorKeyFile(db);
  if (create && !fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null;
}
export function validCollectorKey(expected, header) {
  if (!expected || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7)), wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

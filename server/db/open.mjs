import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = fileURLToPath(new URL('.', import.meta.url)); // server/db
const ROOT = path.resolve(HERE, '..', '..');                 // study-system

/**
 * 数据目录优先级：STUDY_DATA_DIR → %APPDATA%\study-system → <project>/data
 * 前两条是 D.2 认可的正式位置；第三条是沙箱里跑测试用的退路。
 */
export function resolveDataDir() {
  const candidates = [
    process.env.STUDY_DATA_DIR,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'study-system') : null,
    path.join(ROOT, 'data'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('no writable data directory');
}

export function openDb(file) {
  const target = file || path.join(resolveDataDir(), 'study.db');
  const db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  const ready = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
    .get();
  if (!ready) {
    db.exec(fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8'));
    db.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(1);
  }
  return { db, file: target };
}

export const SCHEMA_VERSION = 1;

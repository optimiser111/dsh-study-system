import { randomUUID } from 'node:crypto';

export const XP = {
  objectiveCorrect: 10,
  objectiveWrong: 3,
  reviewCorrect: 15,
  subjective: 0,
};

export function levelFor(xp) {
  return Math.floor(Math.sqrt(Math.max(xp, 0) / 100)) + 1;
}

function deltaFor(p) {
  if (p.kind !== 'objective') return XP.subjective;
  if (!p.correct) return XP.objectiveWrong;
  return p.reviewed ? XP.reviewCorrect : XP.objectiveCorrect;
}

function reasonFor(p) {
  if (p.kind !== 'objective') return 'subjective:' + (p.passed ? 'pass' : 'fail');
  return 'objective:' + (p.correct ? (p.reviewed ? 'review-correct' : 'correct') : 'wrong');
}

/**
 * 唯一写入口。同一 dedupeKey 重复写入不会产生第二个事件（A7）。
 * @returns {{deduped:boolean, id:string|null}}
 */
export function applyEvent(db, { type, payload = {}, at = Date.now(), dedupeKey = null }) {
  const id = randomUUID();
  const res = db
    .prepare(
      'INSERT OR IGNORE INTO events (id, type, payload_json, created_at, dedupe_key) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, type, JSON.stringify(payload), at, dedupeKey);
  if (Number(res.changes) === 0) return { deduped: true, id: null };
  if (type === 'answer.recorded') rebuildLedger(db, at);
  return { deduped: false, id };
}

/** xp_ledger 是派生表：任何时候都能从 events 整表重建（同一批事件 → 同一结果，A4）。 */
export function rebuildLedger(db, now = Date.now()) {
  const rows = db
    .prepare(
      "SELECT id, payload_json, created_at FROM events WHERE type = 'answer.recorded' ORDER BY created_at, id",
    )
    .all();

  db.exec('DELETE FROM xp_ledger');
  const insert = db.prepare(
    'INSERT INTO xp_ledger (id, axis, delta, reason, event_id) VALUES (?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    const p = JSON.parse(row.payload_json);
    const delta = deltaFor(p);
    if (!delta) continue;
    insert.run(randomUUID(), p.axis || 'other', delta, reasonFor(p), row.id);
  }

  const totals = Object.fromEntries(
    db.prepare('SELECT axis, SUM(delta) AS total FROM xp_ledger GROUP BY axis').all()
      .map((r) => [r.axis, Number(r.total)]),
  );
  const emit = db.prepare(
    'INSERT OR IGNORE INTO events (id, type, payload_json, created_at, dedupe_key) VALUES (?, ?, ?, ?, ?)',
  );
  for (const [axis, xp] of Object.entries(totals)) {
    for (let level = 2; level <= levelFor(xp); level++) {
      emit.run(randomUUID(), 'level.up', JSON.stringify({ axis, level }), now, `level:${axis}:${level}`);
    }
  }
  return totals;
}

export function xpByAxis(db) {
  return Object.fromEntries(
    db.prepare('SELECT axis, SUM(delta) AS total FROM xp_ledger GROUP BY axis').all()
      .map((r) => [r.axis, Number(r.total)]),
  );
}

export function levelByAxis(db) {
  return Object.fromEntries(
    Object.entries(xpByAxis(db)).map(([axis, xp]) => [axis, levelFor(xp)]),
  );
}

// 只读审计。发现历史冲突时报告，不自动猜测哪份记录正确。
export function auditDb(db) {
  const issues = [];
  const counts = {};
  for (const table of ['courses', 'sessions', 'cards', 'answers', 'reviews', 'events']) {
    counts[table] = Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
  }
  for (const row of db.prepare("SELECT * FROM answers WHERE graded_by LIKE 'model:%'").all()) {
    let grade;
    try { grade = JSON.parse(row.rubric_json); } catch { /* report */ }
    if (!grade || grade.method !== 'blind-model' || typeof grade.passed !== 'boolean' || !Array.isArray(grade.points)) {
      issues.push({ severity: 'error', code: 'INVALID_MODEL_GRADE', answerId: row.id });
      continue;
    }
    const event = db.prepare('SELECT payload_json FROM events WHERE dedupe_key=?').get(`regrade:${row.id}`);
    if (!event) issues.push({ severity: 'warning', code: 'LEGACY_GRADE_WITHOUT_EVENT', answerId: row.id });
    else {
      const p = JSON.parse(event.payload_json);
      if (p.passed !== grade.passed || p.by !== row.graded_by || p.hit !== grade.hit) issues.push({ severity: 'error', code: 'GRADE_EVENT_MISMATCH', answerId: row.id });
    }
  }
  for (const row of db.prepare(`SELECT k.id,k.span_text,k.span_start,k.span_end,c.text FROM cards k
    JOIN segments g ON g.id=k.segment_id JOIN sessions s ON s.id=g.session_id
    JOIN contents c ON c.id=s.content_id WHERE k.discarded=0`).all()) {
    if (row.text.slice(row.span_start, row.span_end) !== row.span_text) issues.push({ severity: 'error', code: 'INVALID_CARD_SPAN', cardId: row.id });
  }
  const expected = {};
  for (const row of db.prepare("SELECT payload_json FROM events WHERE type='answer.recorded'").all()) {
    const p = JSON.parse(row.payload_json);
    if (p.kind === 'objective') expected[p.axis || 'other'] = (expected[p.axis || 'other'] || 0) + (!p.correct ? 3 : p.reviewed ? 15 : 10);
  }
  const actual = Object.fromEntries(db.prepare('SELECT axis,SUM(delta) n FROM xp_ledger GROUP BY axis').all().map((r) => [r.axis, Number(r.n)]));
  for (const axis of new Set([...Object.keys(actual), ...Object.keys(expected)])) {
    if ((actual[axis] || 0) !== (expected[axis] || 0)) issues.push({ severity: 'error', code: 'XP_EVENT_MISMATCH', axis });
  }
  return { ok: !issues.some((i) => i.severity === 'error'), counts, xp: actual, issues };
}

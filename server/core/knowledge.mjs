import { CATALOG, NODE_BY_ID, CATALOG_VERSION, SOURCES, ancestors, matchKnowledge } from './knowledge-catalog.mjs';
import { applyEvent } from './events.mjs';
import { publicAnswer } from './workspace.mjs';
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const lastEvents = (db, type) => db.prepare('SELECT payload_json,created_at,rowid AS sequence FROM events WHERE type=? ORDER BY rowid DESC').all(type);
function requireCourse(db, courseId) { if (courseId && !db.prepare('SELECT id FROM courses WHERE id=?').get(courseId)) throw new Error('课程不存在'); }
function requireNode(nodeId) { const node = NODE_BY_ID.get(nodeId); if (!node) throw new Error('知识点不存在'); return node; }

export function knowledgeMap(db, courseId = null) {
  requireCourse(db, courseId);
  const studied = new Set(), related = new Map(), evidence = new Map(), cards = new Map();
  const sessions = db.prepare(`SELECT s.id,s.started_at,c.title,c.axis FROM sessions s JOIN courses c ON c.id=s.course_id
    WHERE (? IS NULL OR s.course_id=?) ORDER BY s.started_at DESC,s.rowid DESC`).all(courseId, courseId);
  const sessionById = new Map(sessions.map((s) => [s.id, s]));
  const include = (nodeId, sessionId) => {
    if (!nodeId || sessionById.get(sessionId)?.axis !== 'math') return;
    studied.add(nodeId); const list = related.get(nodeId) || [];
    if (!list.some((s) => s.id === sessionId)) list.push({ id: sessionId, title: sessionById.get(sessionId).title, at: sessionById.get(sessionId).started_at });
    related.set(nodeId, list);
  };
  for (const event of lastEvents(db, 'lesson.summarized')) {
    const data = parse(event.payload_json); if (!data || !sessionById.has(data.sessionId)) continue;
    for (const idea of data.summary?.coreIdeas || []) include(matchKnowledge(idea.title) || matchKnowledge(idea.meaning), data.sessionId);
  }
  // 以每题保存的目标关联优先，其次只匹配题干/主题，不用学生答案或错误选项定位。
  const mapped = new Map();
  for (const event of lastEvents(db, 'card.assessed')) {
    const data = parse(event.payload_json); if (!data || mapped.has(data.cardId)) continue;
    const summaryEvent = db.prepare("SELECT payload_json FROM events WHERE id=? AND type='lesson.summarized'").get(data.summaryId);
    const idea = parse(summaryEvent?.payload_json)?.summary?.coreIdeas?.find((i) => i.id === data.targetId);
    if (idea) mapped.set(data.cardId, matchKnowledge(idea.title) || matchKnowledge(idea.meaning));
  }
  let automatic = null;
  const rows = db.prepare(`SELECT k.*,g.session_id,s.started_at FROM cards k JOIN segments g ON g.id=k.segment_id
    JOIN sessions s ON s.id=g.session_id JOIN courses c ON c.id=s.course_id WHERE k.discarded=0 AND c.axis='math'
    AND (? IS NULL OR s.course_id=?) ORDER BY s.started_at DESC,k.created_at DESC,k.rowid DESC`).all(courseId, courseId);
  for (const card of rows) {
    const nodeId = mapped.get(card.id) || matchKnowledge(card.topic) || matchKnowledge(card.question);
    if (!nodeId) continue;
    cards.set(card.id, nodeId); include(nodeId, card.session_id);
    if (!automatic) automatic = { nodeId, source: 'recent-question', description: '按最近题目主题定位，可手动调整' };
  }
  const newestQuestionAt = rows[0]?.started_at || 0;
  let latestCapture = null;
  for (const event of lastEvents(db, 'capture.imported')) {
    const captured = parse(event.payload_json);
    const session = sessionById.get(captured?.sessionId);
    if (session?.axis !== 'math') continue;
    const counts = new Map();
    const content = db.prepare('SELECT text FROM contents WHERE session_id=?').get(session.id);
    for (const line of (content?.text || '').split('\n')) {
      const id = matchKnowledge(line);
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
    for (const id of counts.keys()) include(id, session.id);
    const nodeId = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (nodeId && (!latestCapture || session.started_at > latestCapture.at)) latestCapture = { nodeId, at: session.started_at };
  }
  if (latestCapture && (!automatic || latestCapture.at > newestQuestionAt)) {
    automatic = { nodeId: latestCapture.nodeId, source: 'watched-subtitles', description: '根据已观看片段的字幕定位' };
  }
  for (const row of db.prepare('SELECT * FROM answers ORDER BY created_at DESC,rowid DESC').all()) {
    const nodeId = cards.get(row.card_id); if (!nodeId || evidence.has(nodeId)) continue;
    const answer = publicAnswer(db, row);
    if (answer.passed === null || answer.status === 'audit-required') continue;
    const recorded = db.prepare("SELECT created_at,rowid AS sequence FROM events WHERE type IN ('answer.recorded','answer.regraded') AND json_extract(payload_json,'$.answerId')=? ORDER BY rowid DESC LIMIT 1").get(answer.id);
    evidence.set(nodeId, { passed: answer.passed, at: recorded?.created_at || answer.at, sequence: recorded?.sequence || 0, answerId: answer.id, sessionId: row.session_id,
      source: answer.status === 'correct' || answer.status === 'wrong' ? 'objective-answer' : answer.independent === false ? 'followup-answer' : 'model-answer',
      description: answer.passed ? answer.independent === false ? '追问后有正确解释记录' : '有正确作答记录' : '最近关联作答仍有错误或证据不足' });
  }
  const scope = courseId || 'math';
  const selected = lastEvents(db, 'knowledge.current').map((e) => parse(e.payload_json)).find((p) => p?.scope === scope);
  const current = selected?.nodeId ? { nodeId: selected.nodeId, source: 'manual', description: '你选择的学习起点' } : automatic;
  const assessments = new Map(), checks = new Map();
  for (const e of lastEvents(db, 'knowledge.self-assessed')) { const p = parse(e.payload_json); if (p && !assessments.has(p.nodeId)) assessments.set(p.nodeId, { state: p.state, at: e.created_at, sequence: e.sequence }); }
  for (const e of lastEvents(db, 'knowledge.checked')) { const p = parse(e.payload_json); if (p && !checks.has(p.nodeId)) checks.set(p.nodeId, { ...p, at: e.created_at, sequence: e.sequence }); }
  const inferred = new Set();
  const anchors = new Set([current?.nodeId, ...[...evidence].filter(([, e]) => e.passed).map(([id]) => id),
    ...[...assessments].filter(([, a]) => a.state === 'self-known').map(([id]) => id)]);
  for (const id of anchors) if (id) for (const parent of ancestors(id)) inferred.add(parent);
  const nodes = CATALOG.map((node) => {
    const self = assessments.get(node.id), result = checks.get(node.id), proof = evidence.get(node.id);
    let status = studied.has(node.id) ? 'encountered' : inferred.has(node.id) ? 'assumed' : 'unseen';
    const signals = [];
    if (proof) signals.push({ ...proof, status: proof.passed ? 'evidence' : 'needs-review' });
    if (result) signals.push({ ...result, status: result.correct ? 'checked' : 'needs-review' });
    if (self && self.state !== 'clear') signals.push({ ...self, status: self.state === 'self-known' ? 'self-confirmed' : 'needs-review' });
    signals.sort((a, b) => b.at - a.at || b.sequence - a.sequence);
    if (signals[0]) status = signals[0].status;
    return { id: node.id, title: node.title, branch: node.branch, position: node.position, prerequisites: node.prerequisites,
      description: node.description, status, isCurrent: current?.nodeId === node.id, inferredPrerequisite: inferred.has(node.id),
      selfAssessment: self?.state || 'clear', evidence: proof || null, lastCheck: result || null,
      relatedSessions: (related.get(node.id) || []).sort((a, b) => b.at - a.at),
      check: { question: node.check.question, options: node.check.options } };
  });
  return { version: CATALOG_VERSION, scope, current, nodes,
    edges: CATALOG.flatMap((n) => n.prerequisites.map((from) => ({ from, to: n.id, kind: 'suggested-prerequisite' }))),
    provenance: { description: '人工整理的数学学习邻域；参考课程章节，连线为建议先修，不是当前B站课程的官方目录，也不是掌握证明。', sources: SOURCES },
    notices: ['低亮的前置节点只表示推测具备；自评、单题自检和实际作答证据分开标记，不发XP。', '节点主题由已存题目或提要匹配，可能有偏差；可手动选择学习起点。'] };
}

export function setKnowledgeCurrent(db, { nodeId, courseId = null }) {
  if (nodeId !== null) requireNode(nodeId);
  requireCourse(db, courseId);
  const scope = courseId || 'math';
  const latest = lastEvents(db, 'knowledge.current').map((e) => parse(e.payload_json)).find((p) => p?.scope === scope);
  if (latest?.nodeId !== nodeId) applyEvent(db, { type: 'knowledge.current', payload: { nodeId, scope } });
  return knowledgeMap(db, courseId);
}
export function assessKnowledge(db, nodeId, { state, courseId = null }) {
  requireNode(nodeId); requireCourse(db, courseId);
  if (!['self-known', 'needs-review', 'clear'].includes(state)) throw new Error('自评状态无效');
  const latest = lastEvents(db, 'knowledge.self-assessed').map((e) => parse(e.payload_json)).find((p) => p?.nodeId === nodeId);
  if (latest?.state !== state) applyEvent(db, { type: 'knowledge.self-assessed', payload: { nodeId, state, source: 'user-self-report' } });
  return knowledgeMap(db, courseId);
}
export function checkKnowledge(db, nodeId, { answer, courseId = null }) {
  const node = requireNode(nodeId); requireCourse(db, courseId);
  if (!['A', 'B', 'C', 'D'].includes(answer)) throw new Error('请选择有效选项');
  const result = { nodeId, answer, correct: answer === node.check.answer, explanation: node.check.explanation,
    source: 'manual-single-item-check', checkVersion: CATALOG_VERSION };
  applyEvent(db, { type: 'knowledge.checked', payload: result });
  return { result, map: knowledgeMap(db, courseId) };
}

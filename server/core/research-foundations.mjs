import { createHash } from 'node:crypto';
import { CATALOG, NODE_BY_ID, SOURCES } from './knowledge-catalog.mjs';
import { knowledgeMap } from './knowledge.mjs';

const prerequisite = (edge) => ['prerequisite', 'suggested-prerequisite'].includes(edge.kind);
const aliases = new Map([['向量数乘', 'scaling'], ['数乘', 'scaling'], ['标量乘法', 'scaling'], ['向量', 'vectors'],
  ['坐标表示', 'coordinates'], ['基', 'basis'], ['导数', 'derivatives'], ['极限', 'limits'], ['积分', 'integrals']]);
const catalogId = (n) => n.subject === 'math' ? CATALOG.find((c) => c.title === n.title)?.id || aliases.get(n.title) : null;
const stableId = (title) => createHash('sha256').update('math:' + title.normalize('NFKC').toLowerCase()).digest('hex').slice(0, 24);

export function addResearchFoundations(db, rawNodes, rawEdges,{expandNodeIds=null}={}) {
  const nodes = new Map(rawNodes.map((n) => [n.id, { ...n, selfAssessment: 'clear' }]));
  const edges = rawEdges.slice(), byCatalog = new Map();
  const math = rawNodes.some((n) => n.subject === 'math') ? knowledgeMap(db) : null;
  const mathNodes = new Map(math?.nodes.map((n) => [n.id, n]) || []);
  for (const node of nodes.values()) {
    const id = catalogId(node);
    if (id) { node.catalogId = id; if (!byCatalog.has(id)) byCatalog.set(id, node.id); }
  }
  const assessments = new Map();
  for (const row of db.prepare("SELECT payload_json FROM events WHERE type='research.self-assessed' ORDER BY rowid DESC").all()) {
    const p = JSON.parse(row.payload_json); if (!assessments.has(p.nodeId)) assessments.set(p.nodeId, p.state);
  }
  const reachable = (from, to, seen = new Set()) => {
    if (from === to) return true;
    if (seen.has(from)) return false; seen.add(from);
    return edges.some((e) => prerequisite(e) && e.from === from && reachable(e.to, to, seen));
  };
  const ensure = (id) => {
    if (byCatalog.has(id)) return nodes.get(byCatalog.get(id));
    const item = NODE_BY_ID.get(id), nodeId = stableId(item.title);
    const node = { id: nodeId, subject: 'math', title: item.title, description: item.description,
      status: 'unseen', courseQuote: null, catalogId: id, origin: 'catalog-prerequisite', selfAssessment: 'clear',
      references: SOURCES.map((s) => ({ ...s, authority: '人工整理的数学建议先修路径，课程章节参考' })) };
    nodes.set(nodeId, node); byCatalog.set(id, nodeId); return node;
  };
  const supplemented = new Set();
  const complete = (id) => {
    if (supplemented.has(id)) return; supplemented.add(id);
    const child = ensure(id);
    for (const parentId of NODE_BY_ID.get(id).prerequisites) {
      const parent = ensure(parentId); complete(parentId);
      if (!edges.some((e) => prerequisite(e) && e.from === parent.id && e.to === child.id) && !reachable(child.id, parent.id)) {
        edges.push({ from: parent.id, to: child.id, kind: 'suggested-prerequisite',
          reason: '数学基础目录建议先了解“' + parent.title + '”再学习“' + child.title + '”；这条补全关系不是本课字幕或掌握证明。',
          references: SOURCES.map((s) => ({ ...s })) });
      }
    }
  };
  const anchors = rawNodes.filter((n) => n.status === 'encountered' || assessments.get(n.id) === 'self-known' ||
    ['evidence', 'checked', 'self-confirmed'].includes(mathNodes.get(catalogId(n))?.status));
  for (const n of anchors) { const id = catalogId(n); if (id&&(!expandNodeIds||expandNodeIds.has(n.id))) complete(id); }
  const inferred = new Set();
  const visitParents = (id, seen = new Set()) => {
    if (seen.has(id)) return; seen.add(id);
    for (const edge of edges.filter((e) => prerequisite(e) && e.to === id)) { inferred.add(edge.from); visitParents(edge.from, seen); }
  };
  anchors.forEach((n) => visitParents(n.id));
  for (const node of nodes.values()) {
    node.inferredPrerequisite = inferred.has(node.id);
    if (node.status === 'unseen' && node.inferredPrerequisite) node.status = 'assumed';
    const known = mathNodes.get(node.catalogId);
    if (known) {
      node.selfAssessment = known.selfAssessment; node.check = known.check; node.lastCheck = known.lastCheck; node.evidence = known.evidence;
      if (['evidence', 'checked', 'self-confirmed', 'needs-review'].includes(known.status)) node.status = known.status;
    } else {
      const state = assessments.get(node.id) || 'clear'; node.selfAssessment = state;
      if (state !== 'clear') node.status = state === 'self-known' ? 'self-confirmed' : 'needs-review';
    }
  }
  return { nodes: [...nodes.values()], edges };
}

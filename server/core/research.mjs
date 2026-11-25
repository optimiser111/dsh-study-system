import { createHash } from 'node:crypto';
import { modelSettings } from './model-settings.mjs';
import { applyEvent } from './events.mjs';
import { normalizeSubject, subjectLabel } from './subjects.mjs';
import { sourceAuthority, chatgptUsageNotice,navigationErrorNotice } from '../../plugin/research.js';
import {findPrerequisiteCycle} from '../../plugin/prerequisite-graph.js';
import { addResearchFoundations } from './research-foundations.mjs';
import { mergeExplorations, explorationStatuses } from './node-exploration.mjs';
import { assessKnowledge, checkKnowledge } from './knowledge.mjs';
import { loadLessonSummary } from './store.mjs';
import { FOUNDATION_VERSION, foundationErrors } from '../../plugin/foundations.js';
import { SUBJECT_AREAS, subjectArea } from '../../plugin/subject-areas.js';
import { validatePresentation } from '../../plugin/subject-presentation.js';
import { subjectPresentationStatus } from './subject-presentation.mjs';
import { CHATGPT_SOURCE } from '../capture/chatgpt.mjs';
import { CODEX_SOURCE } from '../capture/codex.mjs';

export const RESEARCH_VERSION = 'course-map-v2';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const records = (db, type) => db.prepare('SELECT payload_json,created_at,rowid sequence FROM events WHERE type=? ORDER BY rowid DESC').all(type).map((r) => ({ ...JSON.parse(r.payload_json), at: r.created_at, sequence: r.sequence }));
const identity = (db,sessionId) => db.prepare(`SELECT s.id sessionId,c.id courseId,c.title,c.axis,c.external_id bvid,t.text,r.kind sourceKind
    FROM sessions s JOIN courses c ON c.id=s.course_id JOIN contents t ON t.id=s.content_id LEFT JOIN sources r ON r.id=s.source_id WHERE s.id=?`).get(sessionId);
export function researchInput(db, sessionId,{includeCheckpoint=true}={}) {
  const row=identity(db,sessionId);
  if (!row) throw new Error('课程字幕尚未准备');
  const key = hash(RESEARCH_VERSION + row.courseId + row.text);
  const previous = records(db, 'research.completed').find((r) => r.key === key);
  const lesson = loadLessonSummary(db, sessionId);
  const lessonSequence = lesson ? db.prepare('SELECT rowid AS seq FROM events WHERE id=?').get(lesson.id)?.seq || 0 : 0;
  const request = records(db,'research.requested').find(r=>r.key===key);
  // Historical checkpoints contain full textbooks. Never load the entire
  // history to find one draft, and ordinary overview requests do not need it.
  const checkpointRow=includeCheckpoint?db.prepare("SELECT payload_json,created_at,rowid sequence FROM events WHERE type='research.checkpoint' AND json_extract(payload_json,'$.key')=? AND json_extract(payload_json,'$.foundationVersion')=? AND json_extract(payload_json,'$.lessonSequence')=? ORDER BY rowid DESC LIMIT 1").get(key,FOUNDATION_VERSION,lessonSequence):null;
  const checkpoint=checkpointRow?{...JSON.parse(checkpointRow.payload_json),at:checkpointRow.created_at,sequence:checkpointRow.sequence}:null;
  const confirmed = new Set(records(db, 'research.confirmed').map((r) => r.key));
  return { ...row, key, previous: previous || null, needsFoundations: !!previous && (previous.foundationVersion !== FOUNDATION_VERSION || foundationErrors(previous, lesson?.summary).length > 0),
    lessonSummary: lesson?.summary || null, lessonSequence, sourceHints: request?.sourceHints || [],attemptId:request?.sequence?String(request.sequence):'auto:'+key+':'+lessonSequence,checkpoint:checkpoint||null,
    subjects: db.prepare('SELECT DISTINCT axis FROM courses').all().map((r) => ({ id: r.axis, name: subjectLabel(r.axis) })),
    maps: records(db, 'research.completed').filter((r) => r.version === RESEARCH_VERSION && (!r.needsConfirmation || confirmed.has(r.key))).slice(0, 12) };
}
export function saveResearchCheckpoint(db,sessionId,data){
  const input=researchInput(db,sessionId,{includeCheckpoint:false});
  if(data.key!==input.key||data.foundationVersion!==FOUNDATION_VERSION||!['planning','retrieving','mapping','auditing','incomplete','complete'].includes(data.stage))throw Error('基础补全检查点无效');
  if((data.sources?.length||0)>40||(data.plan?.concepts?.length||0)>80||(data.graph?.nodes?.length||0)>80||Buffer.byteLength(JSON.stringify(data),'utf8')>1800000)throw Error('基础补全检查点过大');
  // A checkpoint is unfinished work, never a knowledge-map completion event.
  applyEvent(db,{type:'research.checkpoint',payload:{...data,gaps:(Array.isArray(data.gaps)?data.gaps:[]).map(g=>typeof g==='string'?g:g?.reason||JSON.stringify(g)).slice(0,20),sessionId,courseId:input.courseId,key:input.key,lessonSequence:input.lessonSequence}});
  return {ok:true};
}
export function requestResearch(db, sessionId, { foundations = false, sourceHints = [] } = {}) {
  const input = researchInput(db, sessionId,{includeCheckpoint:false});
  if (!Array.isArray(sourceHints) || sourceHints.length>5 || sourceHints.some(url=>typeof url!=='string'||!sourceAuthority(url))) throw new Error('补充来源须为权威教材地址，最多5个');
  if (input.previous) return { state: 'completed', sessionId, cached: true };
  const requests = records(db, 'research.requested');
  const previous = requests.find((r) => r.key === input.key);
  const failure = records(db, 'research.failed').find((r) => r.key === input.key);
  if (!previous || (failure && failure.sequence > previous.sequence) || (input.needsFoundations && input.previous.sequence > previous.sequence)) {
    applyEvent(db, { type: 'research.requested', payload: { sessionId, key: input.key, ...(sourceHints.length ? {sourceHints} : {}) } });
  }
  return { state: 'queued', sessionId };
}
export function researchQueue(db, automatic = true) {
  automatic = automatic && modelSettings(db).autoResearch;
  const requested = records(db, 'research.requested');
  const completed = new Set(records(db, 'research.completed').map((r) => r.key));
  const failed = records(db, 'research.failed');
  const imported = records(db, 'capture.imported'), batches = records(db, 'capture.batch-prepared');
  const covered = new Set(batches.flatMap((b) => imported.filter((r) => b.jobIds.includes(r.jobId)).map((r) => r.sessionId)));
  // Resuming automation applies to new material. Older captures remain
  // available through an explicit request instead of silently spending quota.
  const settings = records(db, 'models.settings');
  const resumed = settings.find((r, i) => r.autoResearch === true && settings[i + 1]?.autoResearch === false);
  const hasCards = db.prepare('SELECT 1 FROM segments g JOIN cards k ON k.segment_id=g.id WHERE g.session_id=? AND k.discarded=0 LIMIT 1');
  const candidates = automatic ? [...batches, ...imported.filter((r) => !covered.has(r.sessionId))].filter(r =>
    r.sequence > (resumed?.sequence || 0) && (![CHATGPT_SOURCE, CODEX_SOURCE].includes(r.sourceKind) || hasCards.get(r.sessionId))) : [];
  const sessions = [...new Set([...requested, ...candidates].map((r) => r.sessionId))];
  return sessions.map(id=>{const row=identity(db,id);return row?{id,key:hash(RESEARCH_VERSION+row.courseId+row.text)}:null;}).filter(Boolean).filter(r=>!completed.has(r.key)).map(r=>researchInput(db,r.id,{includeCheckpoint:false})).filter((r) => {
    if (completed.has(r.key)) return false;
    const failure = failed.find((f) => f.key === r.key);
    const request = requested.find((q) => q.key === r.key);
    return !failure || request?.sequence > failure.sequence || (candidates.some(c=>c.sessionId===r.sessionId) && r.lessonSequence > failure.sequence);
  }).slice(0, 1);
}
function text(value, max = 800) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('知识分析字段不完整或过长');
  return value.trim();
}
function assertAcyclic(nodes, edges) {
  const cycle=findPrerequisiteCycle(edges);
  if(cycle){const titles=new Map(nodes.map(n=>[n.id,n.title]));throw Error('先修关系存在循环：'+cycle.map(id=>titles.get(id)||id).join(' → '));}
}
export function saveResearch(db, sessionId, data) {
  const input = researchInput(db, sessionId,{includeCheckpoint:false});
  if (input.previous && (!input.needsFoundations || data.foundationVersion !== FOUNDATION_VERSION)) return input.previous;
  if (data.key !== input.key) throw new Error('课程内容已变化，请重新分析');
  const subject = normalizeSubject(data.subject);
  if (!subject || !Number.isFinite(data.confidence) || data.confidence < 0 || data.confidence > 1) throw new Error('学科归属无效');
  const foundations = data.foundationVersion === FOUNDATION_VERSION;
  if (foundations && foundationErrors(data, input.lessonSummary).length) throw new Error('前置知识尚未补齐：' + foundationErrors(data, input.lessonSummary).join('；'));
  if (!Array.isArray(data.sources) || !data.sources.length || data.sources.length > (foundations ? 41 : 3)) throw new Error('需要已检索的来源正文');
  const sources = data.sources.map((s) => {
    if(s.id==='course-text'){
      if(!foundations||s.kind!=='course-material'||s.url!=='urn:study-material:'+sessionId||s.content!==input.text)throw Error('课程来源必须是本次实际采集的原文');
      return {id:'course-text',kind:'course-material',url:s.url,title:'本次采集的学习材料',publisher:'本机采集',authority:'课程原文，非外部基础教材',content:input.text,fetchedAt:text(s.fetchedAt,40)};
    }
    const url = new URL(s.url);
    if (!sourceAuthority(url.href) || url.username || url.password) throw new Error('来源需使用大学站点、公开教材或官方文档');
    return { id: text(s.id, 32), url: url.href, title: text(s.title, 300), publisher: text(s.publisher, 150),
      authority: text(s.authority, 500), content: text(s.content, foundations?64000:16000), fetchedAt: text(s.fetchedAt, 40),...(['main-v2','main-v3'].includes(s.extractor)?{extractor:s.extractor}:{}) };
  });
  const sourceMap = new Map(sources.map((s) => [s.id, s]));
  if (sourceMap.size !== sources.length) throw new Error('来源ID重复');
  const support = (items) => {
    if (!Array.isArray(items) || !items.length) throw new Error('节点与关系都需要来源原文');
    return items.map((e) => {
      const source = sourceMap.get(e.sourceId), quote = text(e.quote, 800);
      if (!source || !source.content.includes(quote)) throw new Error('来源原文无法核对');
      return { sourceId: source.id, quote };
    });
  };
  if (!Array.isArray(data.nodes) || !data.nodes.length || data.nodes.length > (foundations ? 80 : 20)) throw new Error('知识节点数量无效');
  const ids = new Map();
  const nodes = data.nodes.map((n) => {
    const axis = normalizeSubject(n.subject), title = text(n.title, 100), local = text(n.id, 80);
    if (!axis || ids.has(local)) throw new Error('知识点学科无效或ID重复');
    const id = hash(axis + ':' + title.normalize('NFKC').toLowerCase()).slice(0, 24);
    ids.set(local, id);
    const quote = n.courseQuote ? text(n.courseQuote, 800) : null;
    if (quote && (!input.text.includes(quote) || axis !== subject)) throw new Error('已接触节点需要本课字幕原文');
    return { id, subject: axis, area: subjectArea(axis, n.area, axis === subject ? data.area : null).id, title, description: text(n.description), support: support(n.support), status: quote ? 'encountered' : 'unseen', courseQuote: quote,
      ...(foundations ? { foundationRoot: n.foundationRoot === true, foundationReason: n.foundationRoot ? text(n.foundationReason) : null,
        learningTargetIds: (n.learningTargetIds || []).filter(id => input.lessonSummary?.coreIdeas.some(idea => idea.id === id)||data.foundationPlan?.targets.some(t=>t.targetId===id)),planConceptIds:n.planConceptIds,level:n.level } : {}) };
  });
  if (!nodes.some((n) => n.subject === subject && n.status === 'encountered')) throw new Error('需要至少一个与已看字幕对应的知识点');
  if (new Set(nodes.map((n) => n.id)).size !== nodes.length) throw new Error('知识点重复');
  if (!Array.isArray(data.edges) || data.edges.length > (foundations ? 180 : 32)) throw new Error('关系数量无效');
  const edges = data.edges.map((e) => {
    const from = ids.get(e.from), to = ids.get(e.to);
    if (!from || !to || from === to || !['prerequisite','suggested-prerequisite', 'application', 'connection'].includes(e.kind)) throw new Error('知识关系无效');
    return { from, to, kind: e.kind, reason: (e.kind==='suggested-prerequisite'?'AI推理建议先修：':'')+text(e.reason), support: support(e.support) };
  });
  const existing = researchView(db, null, input.previous ? input.key : null,foundations?input.courseId:null);
  assertAcyclic([...existing.nodes, ...nodes], [...existing.edges, ...edges]);
  const result = { key: input.key, sessionId, courseId: input.courseId, subject, area: subjectArea(subject, data.area).id, confidence: data.confidence,
    reason: text(data.reason), nodes, edges, sources, version: RESEARCH_VERSION, needsConfirmation: data.confidence < 0.8 };
  if(data.navigationMode==='overview-v1')result.navigationMode='overview-v1';
  if (data.execution) result.execution = { provider: text(data.execution.provider, 160), model: text(data.execution.model, 160), searchProvider: text(data.execution.searchProvider, 50) };
  if (foundations) { result.foundationVersion = FOUNDATION_VERSION; result.lessonSequence = input.lessonSequence;result.foundationPlan=data.foundationPlan;result.foundationAudit=data.foundationAudit;
    const persistedErrors=foundationErrors(result,input.lessonSummary);if(persistedErrors.length)throw Error('基础结果保存校验未通过：'+persistedErrors.join('；'));
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const presentation = validatePresentation(data.presentation, { newCopy: true });
    if (presentation && !subjectPresentationStatus(db).get(subject)?.presentation) result.presentation = presentation;
    applyEvent(db, { type: 'research.completed', payload: result, dedupeKey: 'research:' + input.key + (foundations ? ':' + FOUNDATION_VERSION + ':' + input.lessonSequence+':'+result.foundationAudit.graphHash : '') });
    if (!result.needsConfirmation) db.prepare('UPDATE courses SET axis=? WHERE id=?').run(subject, input.courseId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return result;
}
export function researchFailure(db, sessionId, key, message = '课程知识分析暂未完成，可手动重试。') {
  const input = researchInput(db, sessionId,{includeCheckpoint:false});
  if (input.key !== key) throw new Error('课程内容已变化');
  applyEvent(db, { type: 'research.failed', payload: { sessionId, key, version: RESEARCH_VERSION,navigationMode:'overview-v1', message: String(message).slice(0, 250) } });
}
export function researchView(db, axis = null, excludeKey = null,excludeFoundationCourseId=null) {
  const unique = new Set();
  const all = records(db, 'research.completed').filter(r => r.version === RESEARCH_VERSION && r.key !== excludeKey && !unique.has(r.key) && unique.add(r.key));
  const confirmed = new Set(records(db, 'research.confirmed').map((r) => r.key));
  const maps = all.filter((r) => !r.needsConfirmation || confirmed.has(r.key));
  const nodes = new Map(), edges = new Map();
  const deepCourses=new Set(maps.filter(m=>m.foundationVersion===FOUNDATION_VERSION).map(m=>m.courseId));
  const legacyExpansionIds=new Set(maps.filter(m=>m.navigationMode!=='overview-v1').flatMap(m=>m.nodes.map(n=>n.id)));
  for (const m of maps.slice().reverse()) {
    for (const n of m.nodes) {
      const prior = nodes.get(n.id);
      nodes.set(n.id, { ...n,foundationStatus:m.foundationVersion===FOUNDATION_VERSION?'verified':'on-demand',...(deepCourses.has(m.courseId)&&m.foundationVersion!==FOUNDATION_VERSION?{foundationRoot:false}:{}), courseIds: [...new Set([...(prior?.courseIds || []), m.courseId])], learningTargets:[...(prior?.learningTargets||[]),...(n.learningTargetIds||[]).map(targetId=>({sessionId:m.sessionId,targetId}))], status: prior?.status === 'encountered' ? 'encountered' : n.status, references: [...(prior?.references || []), ...n.support.map((e) => ({ ...e, ...m.sources.find((s) => s.id === e.sourceId), content: undefined }))] });
    }
    for (const e of m.edges){if(['prerequisite','suggested-prerequisite'].includes(e.kind)&&(m.courseId===excludeFoundationCourseId||deepCourses.has(m.courseId)&&m.foundationVersion!==FOUNDATION_VERSION))continue;
      edges.set(e.from + ':' + e.to + ':' + e.kind, { ...e, references: e.support.map((p) => ({ ...p, ...m.sources.find((s) => s.id === p.sourceId), content: undefined })) });}
  }
  // Validated lesson concepts stay visible even while external research is
  // missing or has only covered a side branch. They are course evidence,
  // never invented external prerequisite relations.
  for (const row of db.prepare('SELECT s.id,s.course_id,c.axis,c.platform,c.external_id FROM sessions s JOIN courses c ON c.id=s.course_id WHERE s.content_id IS NOT NULL').all()) {
    const lesson = loadLessonSummary(db, row.id)?.summary;
    if (!lesson || row.axis === '待识别') continue;
    const local = new Map();
    for (const idea of lesson.coreIdeas) {
      const mapped = [...nodes.values()].find(n => n.courseIds?.includes(row.course_id) && (n.learningTargets?.some(t=>t.sessionId===row.id && t.targetId===idea.id) || n.title === idea.title));
      const id = mapped?.id || hash(row.axis + ':' + idea.title.normalize('NFKC').toLowerCase()).slice(0,24); local.set(idea.id,id);
      if (mapped) continue;
      const previous = nodes.get(id);
      nodes.set(id, { id, subject: row.axis, title: idea.title, description: idea.meaning, status: 'encountered', origin: 'course-summary', courseQuote: idea.evidence,
        courseIds: [...new Set([...(previous?.courseIds || []),row.course_id])], references: [{ title: '本次课程提要原文依据',
          ...(row.platform === 'bilibili' ? { url: 'https://www.bilibili.com/video/' + row.external_id } : { kind: 'course-material' }),
          quote: idea.evidence, authority: '课程原文，非联网先修依据' }] });
    }
    for (const e of lesson.connections) {
      const from=local.get(e.from),to=local.get(e.to),key=from+':'+to+':connection';
      if (from !== to && !edges.has(key)) edges.set(key,{from,to,kind:'connection',reason:e.relation,origin:'course-summary',references:[]});
    }
  }
  const legacy=addResearchFoundations(db,[...nodes.values()],[...edges.values()],{expandNodeIds:legacyExpansionIds});
  const extended=mergeExplorations(db,legacy.nodes,legacy.edges);
  const expanded = addResearchFoundations(db, extended.nodes, extended.edges,{expandNodeIds:new Set()});
  nodes.clear(); edges.clear();
  expanded.nodes.forEach((n) => nodes.set(n.id, n));
  expanded.edges.forEach((e) => edges.set(e.from + ':' + e.to + ':' + e.kind, e));
  const declaredAreas=new Map();
  function rememberArea({subject, area}) {
    const resolved = subjectArea(subject, area).id;
    if (resolved !== 'unclassified' && !declaredAreas.has(subject)) declaredAreas.set(subject, resolved);
  }
  // Course-level classification has priority over an incidental cross-subject suggestion.
  maps.forEach(rememberArea);
  maps.forEach(map => map.nodes.forEach(rememberArea));
  nodes.forEach(rememberArea);
  const overrides = new Map();
  for (const item of records(db, 'research.area-assigned')) {
    if (!overrides.has(item.subject)) overrides.set(item.subject, item.area);
  }
  for (const [id, node] of nodes) {
    const areaOverride = overrides.get(node.subject);
    const automaticArea = subjectArea(node.subject, declaredAreas.get(node.subject), node.area).id;
    nodes.set(id, { ...node, area: areaOverride || automaticArea, ...(areaOverride ? { areaOverride, automaticArea } : {}) });
  }
  const selected = [...nodes.values()].filter((n) => !axis || n.subject === axis);
  const own = new Set(selected.map((n) => n.id));
  const links = [...edges.values()].filter((e) => own.has(e.from) || own.has(e.to));
  const related = new Set(links.flatMap((e) => [e.from, e.to]));
  const requests = records(db, 'research.requested');
  const failures = records(db, 'research.failed').filter((r, index, items) => r.version === RESEARCH_VERSION &&
    !items.slice(0, index).some((f) => f.key === r.key) && !all.some((m) => m.key === r.key) &&
    !requests.some((q) => q.key === r.key && q.sequence > r.sequence));
  const checkpoints=db.prepare("SELECT MAX(rowid) sequence FROM events WHERE type='research.checkpoint' GROUP BY coalesce(json_extract(payload_json,'$.courseId'),json_extract(payload_json,'$.sessionId')) ORDER BY sequence DESC").all().map(r=>{const row=db.prepare('SELECT payload_json,created_at FROM events WHERE rowid=?').get(r.sequence);return {...JSON.parse(row.payload_json),at:row.created_at,sequence:r.sequence};}),seenCourses=new Set();
  const foundationProgress=checkpoints.filter(c=>c.foundationVersion===FOUNDATION_VERSION&&(!axis||c.classification?.subject===axis)&&!seenCourses.has(c.courseId||c.sessionId)&&seenCourses.add(c.courseId||c.sessionId)&&!all.some(m=>m.key===c.key&&m.sequence>c.sequence)).map(c=>({sessionId:c.sessionId,stage:c.stage==='complete'?'saving':c.stage,label:c.stage==='complete'?'基础已审核，等待保存':c.stageLabel,concepts:c.plan?.concepts?.length||0,alignedConcepts:c.graph?.evidenceProgress?.completed,sources:c.sources?.length||0,gaps:(c.gaps||[]).slice(0,5)}));
  return { autoResearch: modelSettings(db).autoResearch,navigationMode:'overview-v1',explorations:explorationStatuses(db), nodes: [...nodes.values()].filter((n) => own.has(n.id) || related.has(n.id)), edges: links,foundationProgress,
    pending: all.filter((r) => r.needsConfirmation && !confirmed.has(r.key)).map(({ key, subject, reason, sessionId }) => ({ key, subject, reason, sessionId })),
    queued: researchQueue(db).map(({ sessionId, courseId }) => ({ sessionId, courseId })),
    failures: failures.slice(0, 5).map(f=>{const row=identity(db,f.sessionId),usage=chatgptUsageNotice(f.message),notice=navigationErrorNotice(f.message);
      return {...f,courseTitle:row?.title||'课程',legacyFoundation:!f.navigationMode&&/基础规划|基础尚|基础补全|前置知识尚/.test(f.message),...(notice||{}),...(usage?{message:usage,code:'chatgpt-sharing-limit',usageUrl:'https://chatgpt.com/settings/usage'}:{})};}) };
}
export function assignResearchSubjectArea(db, { subject, area }) {
  const normalized = normalizeSubject(subject);
  if (!normalized || !researchView(db).nodes.some(node => node.subject === normalized)) throw new Error('知识树中没有这个学科');
  if (area !== null && !SUBJECT_AREAS.some(item => item.id !== 'unclassified' && item.id === area)) throw new Error('知识分区无效');
  const previous = records(db, 'research.area-assigned').find(item => item.subject === normalized);
  if ((previous?.area ?? null) !== area) applyEvent(db, { type: 'research.area-assigned', payload: { subject: normalized, area } });
  return { ok: true };
}
export function assessResearchKnowledge(db, nodeId, { state }) {
  if (!['self-known', 'needs-review', 'clear'].includes(state)) throw new Error('自评状态无效');
  const node = researchView(db).nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error('知识点不存在');
  if (node.catalogId) assessKnowledge(db, node.catalogId, { state });
  else {
    if (node.selfAssessment !== state) applyEvent(db, { type: 'research.self-assessed', payload: { nodeId, state, source: 'user-self-report' } });
  }
  return { ok: true };
}
export function checkResearchKnowledge(db, nodeId, { answer }) {
  const node = researchView(db).nodes.find((n) => n.id === nodeId);
  if (!node?.catalogId) throw new Error('该知识点暂无已校验的自检题');
  return { result: checkKnowledge(db, node.catalogId, { answer }).result };
}
export function confirmResearch(db, key) {
  const result = records(db, 'research.completed').find((r) => r.key === key);
  if (!result) throw new Error('分析不存在');
  const existing = researchView(db);
  assertAcyclic([...existing.nodes, ...result.nodes], [...existing.edges, ...result.edges]);
  db.exec('BEGIN IMMEDIATE');
  try {
    applyEvent(db, { type: 'research.confirmed', payload: { key }, dedupeKey: 'research-confirm:' + key });
    db.prepare('UPDATE courses SET axis=? WHERE id=?').run(result.subject, result.courseId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { ok: true };
}

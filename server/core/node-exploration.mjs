import { createHash, randomUUID } from 'node:crypto';
import { applyEvent } from './events.mjs';
import { normalizeSubject } from './subjects.mjs';
import { subjectArea } from '../../plugin/subject-areas.js';
import { sourceAuthority } from '../../plugin/research.js';

import { EXPLORATION_VERSION } from '../../plugin/node-exploration.js';
export { EXPLORATION_VERSION };
const events = (db, type) => db.prepare('SELECT payload_json,created_at FROM events WHERE type=? ORDER BY rowid DESC').all(type).map(r=>({...JSON.parse(r.payload_json),at:r.created_at}));
const prerequisite = e => ['prerequisite','suggested-prerequisite'].includes(e.kind);
const key = n => normalizeSubject(n.subject)+':'+n.title.normalize('NFKC').trim().toLowerCase();
const field = (v,max=800) => {if(typeof v!=='string'||!v.trim()||v.length>max)throw Error('深挖字段不完整或过长');return v.trim();};
const find = (db,id) => events(db,'exploration.requested').find(r=>r.id===id);
function state(db,r){
  const end=events(db,'exploration.finished').find(e=>e.id===r.id);
  if(end)return end.failed?'failed':'completed';
  const claim=events(db,'exploration.claimed').find(e=>e.id===r.id);
  if(Date.now()-(claim?.at||r.at)>(claim?360000:300000))return 'failed';
  return claim?'processing':'queued';
}
export function explorationStatuses(db){
  const latest=new Map();
  for(const r of events(db,'exploration.requested'))if(!latest.has(r.nodeId)){
    const end=events(db,'exploration.finished').find(e=>e.id===r.id),status=state(db,r);
    latest.set(r.nodeId,{id:r.id,nodeId:r.nodeId,state:status,message:end?.message||(status==='failed'?'深挖已中断或等待超时，点击后重试。':''),outcome:end?.result?.outcome,added:end?.result?.nodes.length||0,reused:end?.result?.reusedNodeIds.length||0});
  }
  return [...latest.values()];
}
export function requestExploration(db,nodeId,graph){
  const target=graph.nodes.find(n=>n.id===nodeId);if(!target)throw Error('知识点不存在');
  const prior=explorationStatuses(db).find(r=>r.nodeId===nodeId);
  if(prior&&prior.state!=='failed')return {...prior,cached:prior.state==='completed'};
  const id=randomUUID();applyEvent(db,{type:'exploration.requested',payload:{id,nodeId,version:EXPLORATION_VERSION}});
  return {id,nodeId,state:'queued',cached:false};
}
export function explorationQueue(db){return events(db,'exploration.requested').filter(r=>state(db,r)==='queued').reverse().map(({id,nodeId})=>({id,nodeId}));}
export function claimExploration(db,id){
  const r=find(db,id);if(!r||state(db,r)!=='queued')return {claimed:false};
  const token=randomUUID(),saved=applyEvent(db,{type:'exploration.claimed',payload:{id,token},dedupeKey:'exploration-claim:'+id});
  return saved.deduped?{claimed:false}:{claimed:true,token};
}
export function explorationInput(db,id,graph){
  const r=find(db,id);if(!r)throw Error('深挖任务不存在');
  const target=graph.nodes.find(n=>n.id===r.nodeId);if(!target)throw Error('目标知识点已变化');
  const sources=new Map();
  for(const e of [...events(db,'exploration.finished').filter(e=>!e.failed).map(e=>e.result),...events(db,'research.completed')])for(const s of e.sources||[]){
    if(s.id==='course-text'||!sourceAuthority(s.url)||!s.content||Date.now()-Date.parse(s.fetchedAt)>30*86400000)continue;
    if(!sources.has(s.url))sources.set(s.url,s);
  }
  return {id,nodeId:r.nodeId,target,graph:{nodes:graph.nodes,edges:graph.edges},cachedSources:[...sources.values()]};
}
function validateResult(data,target,graph){
  if(data.targetId!==target.id||data.version!==EXPLORATION_VERSION)throw Error('深挖目标或版本不匹配');
  if(!['expanded','no-supported-prerequisites'].includes(data.outcome))throw Error('深挖结果状态无效');
  const sources=data.sources;
  if(!Array.isArray(sources)||!sources.length||sources.length>3)throw Error('深挖需提供1至3份来源正文');
  const checkedSources=sources.map(s=>{
    if(!sourceAuthority(s.url)||new URL(s.url).username||new URL(s.url).password)throw Error('深挖来源不在允许范围');
    return {id:field(s.id,32),url:s.url,title:field(s.title,300),publisher:field(s.publisher,150),authority:field(s.authority,500),content:field(s.content,24000),fetchedAt:field(s.fetchedAt,40)};
  });
  const bySource=new Map(checkedSources.map(s=>[s.id,s]));if(bySource.size!==sources.length)throw Error('深挖来源ID重复');
  const support=items=>{
    if(!Array.isArray(items)||!items.length||items.length>6)throw Error('深挖节点和连线需要实质来源');
    return items.map(p=>{const quote=field(p.quote),source=bySource.get(p.sourceId);if(!source?.content.includes(quote))throw Error('深挖引文无法核对');return {sourceId:source.id,quote};});
  };
  if(!Array.isArray(data.nodes)||data.nodes.length>6||!Array.isArray(data.edges)||data.edges.length>18)throw Error('每次只允许一层、最多6个直接前置及18条关系');
  const existing=new Map(graph.nodes.map(n=>[n.id,n])),identities=new Map(graph.nodes.map(n=>[key(n),n])),local=new Map(),nodes=[],reused=new Set();
  const knownAreas = new Map(graph.nodes.map(n => [normalizeSubject(n.subject), n.automaticArea ?? n.area]));
  for(const n of data.nodes){
    const id=field(n.id,80);if(local.has(id)||id===target.id)throw Error('深挖节点ID重复');
    const subject=normalizeSubject(n.subject),title=field(n.title,100);if(!subject)throw Error('深挖学科无效');
    const old=n.existingId?existing.get(n.existingId):identities.get(key({subject,title}));
    if(n.existingId&&(!old||key(old)!==key({subject,title})))throw Error('复用节点须沿用全局节点的学科和名称');
    support(n.support);
    const stable=old?.id||createHash('sha256').update(key({subject,title})).digest('hex').slice(0,24);
    if(existing.has(id)&&id!==stable)throw Error('深挖局部ID不能覆盖其他全局节点');
    if(stable===target.id||[...local.values()].includes(stable))throw Error('深挖不能重复目标或同一前置');
    local.set(id,stable);
    if(old)reused.add(stable);
    else {const node={id:stable,subject,area:subjectArea(subject,knownAreas.get(subject),n.area).id,title,description:field(n.description),status:'unseen',courseQuote:null,origin:'node-exploration',support:support(n.support),courseIds:[]};nodes.push(node);existing.set(stable,node);}
  }
  const resolve=id=>local.get(id)|| (existing.has(id)?id:null),scope=new Set([target.id,...local.values()]);
  const seen=new Set(),edges=data.edges.map(e=>{
    const from=resolve(e.from),to=resolve(e.to);
    if(!from||!to||from===to||!scope.has(from)&&!scope.has(to)||!['prerequisite','suggested-prerequisite','connection','application'].includes(e.kind))throw Error('深挖关系超出本节点范围');
    // Every newly created node belongs to the selected node's immediate layer.
    if(nodes.some(n=>n.id===from)&&nodes.some(n=>n.id===to))throw Error('一次深挖不能新增前置的前置');
    const k=from+':'+to+':'+e.kind;if(seen.has(k))throw Error('深挖关系重复');seen.add(k);
    return {from,to,kind:e.kind,reason:field(e.reason),support:support(e.support)};
  });
  for(const id of local.values())if(!edges.some(e=>e.from===id&&e.to===target.id&&prerequisite(e)))throw Error('新增或复用的节点必须是目标的一层直接前置');
  if(data.outcome==='expanded'&&!local.size)throw Error('深挖未提供直接前置');
  if(data.outcome==='no-supported-prerequisites'&&(nodes.length||local.size||edges.length))throw Error('无可核实前置的结果不能混入新图');
  const all=[...graph.edges,...edges].filter(prerequisite),active=new Set(),visited=new Set();
  const visit=id=>{if(active.has(id))throw Error('深挖先修关系存在循环');if(visited.has(id))return;active.add(id);for(const e of all.filter(e=>e.from===id))visit(e.to);active.delete(id);visited.add(id);};
  existing.forEach(n=>visit(n.id));
  // Reused global endpoints on additional links are kept intact too.
  for(const e of edges)for(const id of [e.from,e.to])if(graph.nodes.some(n=>n.id===id)&&id!==target.id)reused.add(id);
  const additions=edges.filter(e=>!graph.edges.some(old=>old.from===e.from&&old.to===e.to&&(old.kind===e.kind||prerequisite(old)&&prerequisite(e))));
  return {version:EXPLORATION_VERSION,targetId:target.id,outcome:data.outcome,reason:field(data.reason),nodes,edges:additions,reusedNodeIds:[...reused],sources:checkedSources};
}
export function finishExploration(db,id,{token,failed=false,message,result},graph){
  const r=find(db,id),claim=events(db,'exploration.claimed').find(e=>e.id===id);
  if(!r||!claim||claim.token!==token||typeof failed!=='boolean')throw Error('深挖任务凭据无效');
  const end=events(db,'exploration.finished').find(e=>e.id===id);if(end)return {state:end.failed?'failed':'completed',cached:true};
  if(state(db,r)!=='processing')throw Error('深挖任务已过期，请重新点击');
  const target=graph.nodes.find(n=>n.id===r.nodeId);if(!target)throw Error('知识点不存在');
  const saved=failed?null:validateResult(result,target,graph);
  applyEvent(db,{type:'exploration.finished',payload:{id,nodeId:r.nodeId,failed,message:failed?String(message||'深挖未完成，请重试。').slice(0,500):'',...(saved?{result:saved}:{})},dedupeKey:'exploration-result:'+id});
  return {state:failed?'failed':'completed',added:saved?.nodes.length||0,reused:saved?.reusedNodeIds.length||0};
}
export function mergeExplorations(db,rawNodes,rawEdges){
  const nodes=new Map(rawNodes.map(n=>[n.id,n])),edges=new Map(rawEdges.map(e=>[e.from+':'+e.to+':'+e.kind,e]));
  for(const e of events(db,'exploration.finished').reverse()){
    const r=e.result;if(e.failed||!r||!nodes.has(r.targetId))continue;
    const refs=support=>support.map(p=>({...p,...r.sources.find(s=>s.id===p.sourceId),content:undefined}));
    for(const n of r.nodes)if(!nodes.has(n.id))nodes.set(n.id,{...n,references:refs(n.support),foundationStatus:'on-demand'});
    for(const link of r.edges){const k=link.from+':'+link.to+':'+link.kind;if(nodes.has(link.from)&&nodes.has(link.to)&&!edges.has(k))edges.set(k,{...link,references:refs(link.support)});}
  }
  return {nodes:[...nodes.values()],edges:[...edges.values()]};
}

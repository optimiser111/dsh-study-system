import {normalizeSubject} from './subject-identity.js';

export const isPrerequisite = edge => ['prerequisite','suggested-prerequisite'].includes(edge.kind);
export function findPrerequisiteCycle(edges) {
  const outgoing=new Map(),done=new Set(),active=new Map(),path=[];
  for(const e of edges.filter(isPrerequisite)){
    if(!outgoing.has(e.from))outgoing.set(e.from,[]);
    outgoing.get(e.from).push(e.to);
  }
  function visit(id){
    if(active.has(id))return [...path.slice(active.get(id)),id];
    if(done.has(id))return null;
    active.set(id,path.length);path.push(id);
    for(const next of outgoing.get(id)||[]){const cycle=visit(next);if(cycle)return cycle;}
    active.delete(id);path.pop();done.add(id);return null;
  }
  for(const id of outgoing.keys()){const cycle=visit(id);if(cycle)return cycle;}
  return null;
}

// Match the same subject aliases and title normalization as persisted node IDs.
const identity=n=>JSON.stringify([normalizeSubject(n.subject),String(n.title||'').trim().normalize('NFKC').toLowerCase()]);
export function researchCycleErrors(graph, existing={nodes:[],edges:[]}) {
  const global=new Map((existing.nodes||[]).map(n=>[n.id,identity(n)]));
  const local=new Map((graph.nodes||[]).map(n=>[n.id,identity(n)]));
  const titles=new Map([...(existing.nodes||[]),...(graph.nodes||[])].map(n=>[identity(n),n.title]));
  const translate=(edges,ids)=>(edges||[]).filter(e=>ids.has(e.from)&&ids.has(e.to)).map(e=>({...e,from:ids.get(e.from),to:ids.get(e.to)}));
  const cycle=findPrerequisiteCycle([...translate(existing.edges,global),...translate(graph.edges,local)]);
  return cycle?[{code:'prerequisite-cycle',path:cycle.map(id=>({subject:JSON.parse(id)[0],title:titles.get(id)})),message:'先修关系形成循环：'+cycle.map(id=>titles.get(id)).join(' → ')}]:[];
}

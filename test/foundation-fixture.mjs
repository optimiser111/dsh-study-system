// Explicit synthetic planning/audit data for integration fixtures. This helper
// never runs in production or claims an actual model audited these test graphs.
import {FOUNDATION_VERSION,foundationFingerprint} from '../plugin/foundations.js';
export function certifyFixture(raw,summary){
  const graph=structuredClone(raw),concepts=[];
  for(const n of graph.nodes){
    const parents=graph.edges.filter(e=>e.to===n.id&&['prerequisite','suggested-prerequisite'].includes(e.kind)).map(e=>e.from);
    n.level=parents.length?'foundation':'primitive';n.foundationRoot=!parents.length;if(n.foundationRoot)n.foundationReason||='Synthetic fixture primitive';
    n.planConceptIds=[n.id];n.learningTargetIds||=[];
    if(n.courseQuote&&!n.learningTargetIds.length)n.learningTargetIds=['fixture-'+n.id];
    concepts.push({id:n.id,title:n.title,subject:n.subject,level:n.level,parents,learningTargetIds:n.learningTargetIds,boundaryReason:n.foundationRoot?n.foundationReason:undefined});
  }
  graph.foundationPlan={concepts,targets:graph.nodes.filter(n=>n.courseQuote).flatMap(n=>n.learningTargetIds.map(targetId=>({targetId,conceptId:n.id,minDepth:0,reason:'Synthetic integration boundary'}))),queries:['fixture']};
  graph.foundationAudit={passed:true,roots:concepts.filter(c=>c.level==='primitive').map(c=>({conceptId:c.id,accepted:true,reason:'Synthetic fixture only'})),targets:graph.foundationPlan.targets.map(t=>({targetId:t.targetId,accepted:true,reason:'Synthetic fixture only'})),gaps:[]};
  graph.foundationAudit.graphHash=foundationFingerprint(graph);graph.foundationVersion=FOUNDATION_VERSION;return graph;
}

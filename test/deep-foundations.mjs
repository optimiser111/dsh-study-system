import test from 'node:test';import assert from 'node:assert/strict';
import {FOUNDATION_VERSION,foundationErrors,foundationFingerprint,planErrors,compactFoundationPlan} from '../plugin/foundations.js';
import {buildResearch,sourceAuthority,pageText} from '../plugin/research.js';import {m2Fixture} from './m2-fixture.mjs';
import {researchInput,saveResearch,saveResearchCheckpoint,researchView,requestResearch,researchQueue,researchFailure} from '../server/core/research.mjs';
import {startServer} from '../server/http/server.mjs';import {panelHarness} from './panel-harness.mjs';
import {fillFoundationEvidence} from '../plugin/foundation-evidence.js';
const text='Synthetic textbook: Numbers describe quantities. Sets contain elements. Vectors are ordered quantities. Matrices describe linear maps. Functions map inputs to outputs. Neural networks compose parameterized functions. Attention weights values using queries and keys. Graphs represent vertices and edges. Graph convolutions aggregate neighbours. Cosine transforms describe signals using cosine basis functions.';
const makePlan=()=>({concepts:[
  ['num','数与量','primitive',[]],['set','集合与元素','primitive',[]],['vec','向量','foundation',['num']],['mat','矩阵运算','foundation',['vec']],['fun','函数与映射','foundation',['num','set']],
  ['nn','神经网络','mechanism',['mat','fun']],['att','查询键值注意力','method',['nn','mat']],['gra','图与邻接表示','foundation',['set','mat']],['gcn','图卷积','method',['nn','gra']],['dct','离散余弦变换','method',['fun','vec']],['out','人体动作预测','application',['att','gcn','dct']],
].map(([id,title,level,parents])=>({id,title,level,parents,subject:['num','set','vec','mat','fun','dct'].includes(id)?'math':'人工智能',learningTargetIds:id==='out'?['goal']:[],...(level==='primitive'?{boundaryReason:'Synthetic elementary definition; assumes only everyday counting and reading.'}:{})})),targets:[{targetId:'goal',conceptId:'out',minDepth:4,reason:'Multiple mathematical and model dependencies'}],queries:['root textbook definitions']});
function fixture(){const f=m2Fixture(),base=researchInput(f.db,f.sessionId);const input={...base,title:'Synthetic motion paper',lessonSummary:{coreIdeas:[{id:'goal',title:'人体动作预测'}]},subjects:[],maps:[],previous:null};return {...f,input};}
function graph(input,plan=makePlan()){
  const support=[{sourceId:'s1',quote:'Numbers describe quantities.'}];
  return {key:input.key,subject:'人工智能',confidence:.99,reason:'Synthetic integration',foundationVersion:FOUNDATION_VERSION,foundationPlan:plan,
    nodes:plan.concepts.map(c=>({id:c.id,subject:c.subject,title:c.title,level:c.level,planConceptIds:[c.id],description:'Synthetic definition',support,foundationRoot:c.level==='primitive',foundationReason:c.boundaryReason,learningTargetIds:c.learningTargetIds,...(c.id==='out'?{courseQuote:input.text.slice(0,30)}:{})})),
    edges:plan.concepts.flatMap(c=>c.parents.map(from=>({from,to:c.id,kind:'suggested-prerequisite',reason:'Synthetic learning dependency',support}))),sources:[{id:'s1',url:'https://ocw.mit.edu/definitions',title:'Fixture',publisher:'Fixture',authority:'Fixture',content:text,fetchedAt:new Date().toISOString()}]};
}
function audit(g,passed=true){const support=n=>n.support||(n.supportRefs||[]).map(id=>g.evidence?.find(e=>e.id===id));return {passed,roots:(g.foundationPlan||makePlan()).concepts.filter(c=>c.level==='primitive').map(c=>({conceptId:c.id,accepted:passed,reason:'Synthetic separate root review'})),targets:[{targetId:'goal',accepted:passed,reason:'Synthetic target review'}],courseDefinitions:(g.nodes||[]).filter(n=>support(n).length&&support(n).every(s=>s?.sourceId==='course-text')).map(n=>({conceptId:n.planConceptIds[0],accepted:passed,reason:'Synthetic course-definition check'})),gaps:passed?[]:['根的定义资料尚不充分'],queries:passed?[]:['deeper elementary definitions']};}
const certify=g=>({...g,foundationAudit:{...audit(g),graphHash:foundationFingerprint(g)}});

test('去除重复直接先修保留全部祖先路径，腾出扩展容量；循环和无效计划不能借此过关',()=>{
  const plan=makePlan();for(let i=0;i<20;i++)plan.concepts.push({id:'dense'+i,title:'Synthetic dense '+i,subject:'math',level:'foundation',parents:['num',...Array.from({length:i},(_,j)=>'dense'+j)],learningTargetIds:[]});
  assert.ok(planErrors(plan,{coreIdeas:[{id:'goal'}]}).includes('基础计划依赖过多'));
  const reduced=compactFoundationPlan(plan);assert.deepEqual(planErrors(reduced,{coreIdeas:[{id:'goal'}]}),[]);
  const reach=(p,id,seen=new Set())=>{for(const parent of p.concepts.find(c=>c.id===id).parents)if(!seen.has(parent)){seen.add(parent);reach(p,parent,seen);}return [...seen].sort();};
  for(const c of plan.concepts)assert.deepEqual(reach(reduced,c.id),reach(plan,c.id));
  assert.deepEqual(reduced.concepts.find(c=>c.id==='dense19').parents,['dense18']);assert.equal(plan.concepts.find(c=>c.id==='dense19').parents.length,20);
  const cyclic=structuredClone(plan);cyclic.concepts[0].parents=['out'];assert.equal(compactFoundationPlan(cyclic),cyclic);assert.ok(planErrors(cyclic,{coreIdeas:[{id:'goal'}]}).some(e=>e.includes('循环')));
  const invalid=structuredClone(plan);invalid.concepts[1].parents=['unknown'];assert.equal(compactFoundationPlan(invalid),invalid);
});

test('教材主文不被长侧栏截断，嵌套role=main完整读取；认可公开教材与论文但拒绝仿冒域名',()=>{
  const body={kind:'html',content:'<div class="sidebar">'+'unrelated chapter list '.repeat(1500)+'</div><div role="main"><div><h1>Vectors</h1></div><div>A vector is an ordered collection of numbers.</div><p>Matrix multiplication represents composition.</p></div><div>Footer noise</div>'};
  const result=pageText(body);assert.ok(result.includes('A vector is an ordered collection'));assert.ok(result.includes('Matrix multiplication'));assert.ok(!result.includes('unrelated chapter'));assert.ok(!result.includes('Footer noise'));
  assert.ok(sourceAuthority('https://discrete.openmathbooks.org/dmoi3/sec_intro-sets.html'));assert.ok(sourceAuthority('https://www.ecva.net/papers/eccv_2020/paper.pdf'));assert.equal(sourceAuthority('https://ecva.net.untrusted.example/paper'),null);
});

test('长教材可保留截断点以后的正文，续读同一来源保留原ID及全部已引用原文',async()=>{
  const f=fixture();try{
    const prefix=(text+' padding words'.repeat(2000)).slice(0,16000),late=' A long chapter defines accumulation of transforms along a kinematic tree.',body=prefix+late;
    assert.ok(!pageText({kind:'text',content:body}).includes('kinematic tree'));assert.ok(pageText({kind:'text',content:body},64000).includes('kinematic tree'));
    const g=graph(f.input);for(const item of [...g.nodes,...g.edges])for(const s of item.support)s.sourceId='s19';
    const url='https://ocw.mit.edu/long-chapter',saved={foundationVersion:FOUNDATION_VERSION,plan:makePlan(),classification:{subject:'人工智能',confidence:.99,reason:'Synthetic'},graph:g,stage:'mapping',round:1,sources:[{...g.sources[0],id:'s19',url,content:prefix,extractor:'main-v2'}]};
    let reads=0;const result=await buildResearch({...f.input,checkpoint:saved,sourceHints:[url]},{requireFoundations:true,model:async(system,user)=>{assert.ok(system.startsWith('你是基础'));return JSON.stringify(audit(JSON.parse(user).graph));},web:{search:async()=>{throw Error('valid graph does not need a new search');},fetch:async({url})=>{reads++;return {url,statusCode:200,body:{kind:'text',content:body}};}}});
    const expanded=result.sources.find(s=>s.id==='s19');assert.equal(reads,1);assert.ok(expanded.content.startsWith(prefix));assert.ok(expanded.content.includes('kinematic tree'));assert.equal(expanded.extractor,'main-v3');assert.deepEqual(foundationErrors(result,f.input.lessonSummary),[]);saveResearch(f.db,f.sessionId,result);
  }finally{f.db.close();}
});

test('完整多支路深入基础才通过；伪装任务为根、缺一支、过浅、漏审核及审核后改图均拒绝',()=>{
  const f=fixture();try{const g=certify(graph(f.input));assert.deepEqual(foundationErrors(g,f.input.lessonSummary),[]);
    const fake=structuredClone(g);fake.foundationPlan.concepts.find(c=>c.id==='out').level='primitive';fake.foundationPlan.concepts.find(c=>c.id==='out').parents=[];fake.foundationPlan.concepts.find(c=>c.id==='out').boundaryReason='仅以任务为边界';assert.ok(planErrors(fake.foundationPlan,f.input.lessonSummary).some(e=>e.includes('高级方法')));
    const shallow=structuredClone(g);shallow.foundationPlan.targets[0].minDepth=0;assert.ok(planErrors(shallow.foundationPlan,f.input.lessonSummary).some(e=>e.includes('深度不足')));
    const missing=structuredClone(g);missing.edges=missing.edges.filter(e=>!(e.from==='gcn'&&e.to==='out'));assert.ok(foundationErrors(missing,f.input.lessonSummary).some(e=>e.includes('支路')));
    const unaudited=structuredClone(g);unaudited.foundationAudit.roots.pop();assert.ok(foundationErrors(unaudited,f.input.lessonSummary).some(e=>e.includes('逐一审核')));
    const changed=structuredClone(g);changed.nodes.find(n=>n.id==='nn').support=[{sourceId:'s1',quote:'Altered quote'}];assert.ok(foundationErrors(changed,f.input.lessonSummary).some(e=>e.includes('不对应')));
    const wrongTarget=structuredClone(g);wrongTarget.nodes[0].learningTargetIds=['goal'];assert.ok(foundationErrors(wrongTarget,f.input.lessonSummary).some(e=>e.includes('不能冒充')));
    assert.ok(sourceAuthority('https://d2l.ai/chapter_multilayer-perceptrons/mlp.html'));assert.ok(sourceAuthority('https://www.deeplearningbook.org/contents/mlp.html'));assert.equal(sourceAuthority('https://d2l.ai.untrusted.example/book'),null);
  }finally{f.db.close();}
});

test('发现缺支路后真的重新搜索，补回全部支路后另行审核，结果可被服务端保存并复用',async()=>{
  const f=fixture(),searches=[],checkpoints=[];let maps=0,audits=0;
  try{const result=await buildResearch(f.input,{requireFoundations:true,checkpoint:async p=>checkpoints.push(structuredClone(p)),
    model:async(system,user)=>{
      if(system.startsWith('根据已看'))return JSON.stringify({subject:'人工智能',confidence:.99,reason:'Synthetic'});
      if(system.startsWith('你负责'))return JSON.stringify(system.includes('针对errors')?{queries:['graph convolution prerequisites'],expandConcepts:[]}:makePlan());
      if(system.startsWith('你是基础')){audits++;return JSON.stringify(audit(JSON.parse(user).graph));}
      const g=graph(f.input);if(++maps===1)g.edges=g.edges.filter(e=>!(e.from==='gcn'&&e.to==='out'));
      else{g.evidence=[{id:'proof',...g.nodes[0].support[0]}];for(const n of [...g.nodes,...g.edges]){delete n.support;n.supportRefs=['proof'];}}
      return JSON.stringify(g);
    },web:{search:async({query})=>{searches.push(query);return {sources:[{url:'https://ocw.mit.edu/'+(searches.length===1?'definitions':'graph-prerequisites')}]};},fetch:async({url})=>({url,statusCode:200,body:{kind:'text',content:text}})}});
    assert.deepEqual(searches,['root textbook definitions','graph convolution prerequisites']);assert.equal(maps,2);assert.equal(audits,1);assert.ok(checkpoints.some(c=>c.gaps?.some(g=>g.includes('支路'))));
    assert.deepEqual(foundationErrors(result,f.input.lessonSummary),[]);
    // Actual service summary is empty in this fixture; the plan still carries
    // its own explicit target and course evidence instead of skipping auditing.
    const saved=saveResearch(f.db,f.sessionId,result);assert.equal(saved.foundationVersion,FOUNDATION_VERSION);assert.equal(saved.nodes.find(n=>n.title==='神经网络').foundationRoot,false);assert.equal(researchInput(f.db,f.sessionId).needsFoundations,false);
    assert.equal(requestResearch(f.db,f.sessionId,{foundations:true}).cached,true);
  }finally{f.db.close();}
});

test('结构正确也不能跳过语义审核；审核指出资料缺口后重新检索并复审',async()=>{
  const f=fixture();let audits=0,searches=0;
  try{const result=await buildResearch(f.input,{requireFoundations:true,model:async(system,user)=>JSON.stringify(system.startsWith('根据已看')?{subject:'人工智能',confidence:.99,reason:'Fixture'}:system.startsWith('你负责')?makePlan():system.startsWith('你是基础')?audit(JSON.parse(user).graph,++audits>1):graph(f.input)),
    web:{search:async()=>({sources:[{url:'https://ocw.mit.edu/source'+(++searches)}]}),fetch:async({url})=>({url,statusCode:200,body:{kind:'text',content:text}})}});
    assert.equal(audits,2);assert.equal(searches,2);assert.equal(result.foundationAudit.passed,true);
  }finally{f.db.close();}
});

test('引文均可核对但建图者仍报告定义缺口时，下一轮必须重新搜索并修补',async()=>{
  const f=fixture();let searches=0,maps=0,audits=0;
  try{const result=await buildResearch(f.input,{requireFoundations:true,model:async(system,user)=>{
    if(system.startsWith('根据已看'))return JSON.stringify({subject:'人工智能',confidence:.99,reason:'Synthetic'});
    if(system.startsWith('你负责'))return JSON.stringify(system.includes('针对errors')?{queries:['missing actual function definition']}:makePlan());
    if(system.startsWith('你是基础')){audits++;return JSON.stringify(audit(JSON.parse(user).graph));}
    const g=graph(f.input);if(++maps===1)g.gaps=[JSON.stringify({conceptId:'fun',detail:'Definition not fully supported.'})];return JSON.stringify(g);
  },web:{search:async()=>({sources:[{url:'https://ocw.mit.edu/definition'+(++searches)}]}),fetch:async({url})=>({url,statusCode:200,body:{kind:'text',content:text}})}});
    assert.equal(searches,2);assert.equal(maps,2);assert.equal(audits,1);assert.deepEqual(foundationErrors(result,f.input.lessonSummary),[]);
  }finally{f.db.close();}
});

test('额度上限或中断只保存缺口不宣布完成；继续时复用规划和资料，不能用旧图根绕过',async()=>{
  const f=fixture();let state,searches=0,plans=0;
  const options={requireFoundations:true,checkpoint:async value=>{state=structuredClone(value);saveResearchCheckpoint(f.db,f.sessionId,{...value,key:f.input.key});},
    model:async(system,user)=>{
      if(system.startsWith('根据已看'))return JSON.stringify({subject:'人工智能',confidence:.99,reason:'Fixture'});
      if(system.startsWith('你负责')){plans++;return JSON.stringify(system.includes('针对errors')?{queries:['missing foundations '+plans],expandConcepts:[]}:makePlan());}
      if(system.startsWith('你是基础'))return JSON.stringify(audit(JSON.parse(user).graph,false));return JSON.stringify(graph(f.input));
    },web:{search:async()=>({sources:[{url:'https://ocw.mit.edu/retry'+(++searches)}]}),fetch:async({url})=>({url,statusCode:200,body:{kind:'text',content:text}})}};
  try{await assert.rejects(buildResearch(f.input,options),/基础尚未补全/);assert.ok(searches>=1&&searches<=3);assert.equal(state.stage,'incomplete');assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE type='research.completed'").get().n,0);assert.equal(researchView(f.db).foundationProgress[0].stage,'incomplete');
    const resumed=researchInput(f.db,f.sessionId);assert.ok(resumed.checkpoint.plan);const beforePlans=plans;
    await assert.rejects(buildResearch(resumed,{...options,model:async()=>{throw Error('must not restart spent attempt');}}),/本轮基础补查额度/);
    researchFailure(f.db,f.sessionId,f.input.key,'Synthetic exhausted attempt');requestResearch(f.db,f.sessionId,{foundations:true});
    const result=await buildResearch(researchInput(f.db,f.sessionId),{...options,model:async(system,user)=>{if(system.startsWith('你负责')){plans++;throw Error('must reuse plan');}return JSON.stringify(system.startsWith('你是基础')?audit(JSON.parse(user).graph):graph(f.input));}});
    assert.equal(plans,beforePlans);assert.ok(result.sources.length>=2);saveResearch(f.db,f.sessionId,result);assert.equal(researchView(f.db).foundationProgress.length,0);
  }finally{f.db.close();}
});

test('本课方法可引用实际采集原文；伪造课程来源和用课程替代基础教材均拒绝',()=>{
  const f=fixture();try{
    const g=graph(f.input),out=g.nodes.find(n=>n.id==='out');out.support=[{sourceId:'course-text',quote:out.courseQuote}];
    const courseSource={id:'course-text',kind:'course-material',url:'urn:study-material:'+f.sessionId,content:f.input.text,fetchedAt:new Date().toISOString()};g.sources.push(courseSource);
    const good=certify(g);assert.deepEqual(foundationErrors(good,f.input.lessonSummary),[]);
    const forged=structuredClone(good);forged.sources.at(-1).content+='fabricated';assert.throws(()=>saveResearch(f.db,f.sessionId,forged),/实际采集的原文/);
    const fakeRoot=structuredClone(good);fakeRoot.nodes[0].support=[{sourceId:'course-text',quote:out.courseQuote}];assert.ok(foundationErrors(fakeRoot,f.input.lessonSummary).some(e=>e.includes('外部教材')));
    const missingReview=structuredClone(good);missingReview.foundationAudit.courseDefinitions=[];assert.ok(foundationErrors(missingReview,f.input.lessonSummary).some(e=>e.includes('真正展开定义')));
    const saved=saveResearch(f.db,f.sessionId,good);assert.equal(saved.sources.find(s=>s.id==='course-text').kind,'course-material');
  }finally{f.db.close();}
});

test('端点教材定义与本课用法可共同支撑推理边，明确标建议先修并接受审核',async()=>{
  const f=fixture();try{
    const data=graph(f.input);data.nodes.find(n=>n.id==='out').support=[{sourceId:'course-text',quote:f.input.text.slice(0,30)}];
    const edge=data.edges.find(e=>e.from==='gcn'&&e.to==='out');edge.support=[{sourceId:'course-text',quote:f.input.text.slice(0,30)}];
    const result=await buildResearch(f.input,{requireFoundations:true,model:async(system,user)=>JSON.stringify(system.startsWith('根据已看')?{subject:'人工智能',confidence:.99,reason:'Synthetic'}:system.startsWith('你负责')?makePlan():system.startsWith('你是基础')?audit(JSON.parse(user).graph):data),web:{search:async()=>({sources:[{url:'https://ocw.mit.edu/fixture'}]}),fetch:async({url})=>({url,statusCode:200,body:{kind:'text',content:text}})}});
    const saved=result.edges.find(e=>e.from==='gcn'&&e.to==='out');assert.equal(saved.kind,'suggested-prerequisite');assert.match(saved.reason,/非教材明定/);assert.ok(saved.support.some(s=>s.sourceId==='s1'));assert.ok(saved.support.some(s=>s.sourceId==='course-text'));assert.deepEqual(foundationErrors(result,f.input.lessonSummary),[]);
  }finally{f.db.close();}
});

test('大图按计划分批核对并保存部分进度，成功证据可复用，遗漏条目不能变成完整图',async()=>{
  const f=fixture(),plan=makePlan(),source=graph(f.input).sources[0];
  for(let i=0;i<20;i++)plan.concepts.push({id:'extra'+i,title:'Synthetic foundation '+i,subject:'math',level:'foundation',parents:['num'],learningTargetIds:[]});
  let active=0,maxActive=0,calls=0;const snapshots=[];
  const model=async(_system,user)=>{calls++;active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,1));active--;
    const batch=JSON.parse(user).focusConcepts;return JSON.stringify({items:batch.map(c=>({conceptId:c.id,description:'Synthetic textbook definition',...(c.id==='out'?{courseQuote:f.input.text.slice(0,30)}:{}),supportRefs:['e'],parents:c.parents.map(id=>({conceptId:id,kind:'suggested-prerequisite',reason:'Synthetic dependency',supportRefs:['e']}))})),evidence:[{id:'e',sourceId:'s1',quote:'Numbers describe quantities.'}],gaps:[]});};
  try{const result=await fillFoundationEvidence(plan,{input:f.input,sources:[source],context:{sources:[source]},model,onProgress:async p=>snapshots.push(structuredClone(p))});
    assert.equal(calls,4);assert.equal(maxActive,2);assert.equal(result.nodes.length,31);assert.equal(result.evidenceProgress.completed,31);assert.ok(snapshots.some(s=>s.evidenceProgress.completed<31));
    const full={...result,foundationPlan:plan};assert.deepEqual(foundationErrors(full,f.input.lessonSummary,{requireAudit:false}),[]);
    calls=0;const reused=await fillFoundationEvidence(plan,{previous:result,input:f.input,sources:[source],context:{},model});assert.equal(calls,0);assert.equal(reused.nodes.length,31);
    const missing=await fillFoundationEvidence(plan,{input:f.input,sources:[source],context:{},model:async()=>JSON.stringify({items:[],evidence:[],gaps:[]})});assert.ok(foundationErrors({...missing,foundationPlan:plan},f.input.lessonSummary,{requireAudit:false}).length>0);
  }finally{f.db.close();}
});

test('大图只修补有明确缺口的定义；有引文但承认不完整的条目不计入完成进度',async()=>{
  const f=fixture(),plan=makePlan();
  for(let i=0;i<20;i++)plan.concepts.push({id:'extra'+i,title:'Synthetic foundation '+i,subject:'math',level:'foundation',parents:['num'],learningTargetIds:[]});
  const previous=graph(f.input,plan),gap=JSON.stringify({conceptId:'nn',parentIds:['mat','fun'],detail:'Synthetic missing definition.'});previous.gaps=[gap];
  const batches=[];let retainGap=true;
  const model=async(_system,user)=>{const batch=JSON.parse(user).focusConcepts;batches.push(batch.map(c=>c.id));return JSON.stringify({items:batch.map(c=>({conceptId:c.id,description:'Updated synthetic definition',support:[{sourceId:'s1',quote:'Numbers describe quantities.'}],parents:c.parents.map(id=>({conceptId:id,kind:'suggested-prerequisite',reason:'Synthetic dependency',support:[{sourceId:'s1',quote:'Numbers describe quantities.'}]}))})),gaps:retainGap?[gap]:[]});};
  try{
    const incomplete=await fillFoundationEvidence(plan,{previous,input:f.input,sources:previous.sources,context:{},model});
    assert.deepEqual(batches,[['nn']]);assert.equal(incomplete.evidenceProgress.completed,30);assert.equal(incomplete.nodes.find(n=>n.id==='mat').description,'Synthetic definition');assert.equal(incomplete.gaps.length,1);
    retainGap=false;const repaired=await fillFoundationEvidence(plan,{previous:incomplete,input:f.input,sources:previous.sources,context:{},model});
    assert.deepEqual(batches,[['nn'],['nn']]);assert.equal(repaired.evidenceProgress.completed,31);assert.deepEqual(repaired.gaps,[]);
    repaired.foundationAudit={passed:false,roots:[{conceptId:'num',accepted:false}],gaps:[]};
    await fillFoundationEvidence(plan,{previous:repaired,input:f.input,sources:previous.sources,context:{},model});assert.deepEqual(batches.at(-1),['num']);
  }finally{f.db.close();}
});

test('旧递归检查点保留为未完成历史，不再在面板提供整图递归继续；外部来源不能写入',async()=>{
  const f=fixture(),host=await startServer({db:f.db,port:0}),base='http://127.0.0.1:'+host.port,ui=panelHarness({base});
  try{
    const checkpoint={key:f.input.key,foundationVersion:FOUNDATION_VERSION,stage:'incomplete',stageLabel:'基础尚有缺口',classification:{subject:'人工智能'},plan:makePlan(),sources:[],gaps:['向量与矩阵的定义尚未核对']};
    const denied=await fetch(base+'/panel/research/'+f.sessionId+'/checkpoint',{method:'POST',headers:{origin:'https://untrusted.example','content-type':'application/json'},body:JSON.stringify(checkpoint)});assert.equal(denied.status,403);
    const response=await fetch(base+'/panel/research/'+f.sessionId+'/checkpoint',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(checkpoint)});assert.equal(response.status,200);
    await ui.settle();assert.equal(ui.all(n=>n.type==='button'&&ui.text(n)==='继续补全基础').length,0);
    assert.equal(researchView(f.db).foundationProgress[0].stage,'incomplete');assert.equal(researchQueue(f.db,false).length,0);assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE type='research.completed'").get().n,0);
  }finally{ui.dispose();host.server.closeAllConnections();await new Promise(r=>host.server.close(r));f.db.close();}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { m2Fixture } from './m2-fixture.mjs';
import { researchInput, saveResearch, researchView, requestResearch, researchQueue, assessResearchKnowledge } from '../server/core/research.mjs';
import { requestExploration, explorationQueue, claimExploration, explorationInput, finishExploration, explorationStatuses } from '../server/core/node-exploration.mjs';
import { buildNodeExploration, EXPLORATION_VERSION } from '../plugin/node-exploration.js';
import { buildResearch } from '../plugin/research.js';
import { startServer } from '../server/http/server.mjs';
import { apply } from '../plugin/worker.js';
import { saveModelSettings } from '../server/core/model-settings.mjs';
import { panelHarness } from './panel-harness.mjs';

const content='Synthetic teaching fixture, not real scientific evidence. Probability spaces define outcomes and probabilities. Loss functions measure prediction differences. These artificial definitions are used only to verify graph plumbing.';
const source={id:'s1',url:'https://ocw.mit.edu/exploration-test-fixture',title:'Synthetic textbook fixture',publisher:'Fixture',authority:'Synthetic',content,fetchedAt:new Date().toISOString()};
const support=[{sourceId:'s1',quote:'Probability spaces define outcomes and probabilities.'}];
function fixture(){
  const f=m2Fixture(),input=researchInput(f.db,f.sessionId);
  saveResearch(f.db,f.sessionId,{key:input.key,subject:'人工智能',confidence:.99,reason:'Synthetic integration fixture',navigationMode:'overview-v1',sources:[source],nodes:[
    {id:'t',subject:'人工智能',title:'预测方法',description:'Synthetic target',courseQuote:input.text.slice(0,30),support},
    {id:'p',subject:'math',title:'概率空间',description:'Existing synthetic definition to retain',support},
    {id:'o',subject:'社会学',title:'访谈分析',description:'Unrelated branch to retain',support},
  ],edges:[]});
  const graph=researchView(f.db),target=graph.nodes.find(n=>n.title==='预测方法'),known=graph.nodes.find(n=>n.title==='概率空间'),other=graph.nodes.find(n=>n.title==='访谈分析');
  return {...f,target,known,other};
}
function output(f,{reuse=true}={}){return {version:EXPLORATION_VERSION,targetId:f.target.id,outcome:'expanded',reason:'Synthetic direct prerequisites and cross-discipline connection',sources:[source],nodes:[
  {id:'p',subject:'math',title:'概率空间',...(reuse?{existingId:f.known.id}:{}),description:'Must not overwrite existing definition',support},
  {id:'loss',subject:'人工智能',title:'损失函数',description:'Synthetic new direct prerequisite',support},
],edges:[{from:'p',to:f.target.id,kind:'suggested-prerequisite',reason:'Synthetic direct dependency',support},{from:'loss',to:f.target.id,kind:'suggested-prerequisite',reason:'Synthetic direct dependency',support},
  {from:'loss',to:f.other.id,kind:'connection',reason:'Synthetic cross-discipline link',support}]};}
const enqueue=f=>{const r=requestExploration(f.db,f.target.id,researchView(f.db));return {r,claim:claimExploration(f.db,r.id)};};

test('一层增量合并：全局复用与跨科连接，不改旧图/自评/XP，不自动展开下一层',()=>{
  const f=fixture();try{
    assessResearchKnowledge(f.db,f.known.id,{state:'needs-review'});assessResearchKnowledge(f.db,f.other.id,{state:'self-known'});
    const old=f.db.prepare("SELECT payload_json FROM events WHERE type='research.completed'").all(),xp=f.db.prepare('SELECT sum(delta) xp FROM xp_ledger').get().xp;
    const {r,claim}=enqueue(f);assert.equal(requestExploration(f.db,f.target.id,researchView(f.db)).id,r.id);assert.equal(claim.claimed,true);assert.equal(claimExploration(f.db,r.id).claimed,false);
    const input=explorationInput(f.db,r.id,researchView(f.db));assert.equal(input.target.id,f.target.id);assert.ok(input.graph.nodes.some(n=>n.id===f.other.id));
    const result=finishExploration(f.db,r.id,{token:claim.token,result:output(f,{reuse:false})},researchView(f.db));assert.equal(result.added,1);assert.equal(result.reused,2);
    const view=researchView(f.db);assert.equal(view.nodes.filter(n=>n.title==='概率空间').length,1);assert.equal(view.nodes.find(n=>n.id===f.known.id).description,'Existing synthetic definition to retain');
    assert.equal(view.nodes.find(n=>n.id===f.known.id).selfAssessment,'needs-review');assert.equal(view.nodes.find(n=>n.id===f.other.id).selfAssessment,'self-known');
    const added=view.nodes.find(n=>n.title==='损失函数');assert.ok(!['encountered','checked','self-confirmed','evidence'].includes(added.status));assert.equal(added.courseQuote,null);
    assert.ok(view.edges.some(e=>e.from===added.id&&e.to===f.other.id));assert.equal(explorationQueue(f.db).length,0);
    assert.equal(requestExploration(f.db,f.target.id,view).cached,true);assert.equal(finishExploration(f.db,r.id,{token:claim.token,failed:true,message:'late error'},view).cached,true);
    assert.deepEqual(f.db.prepare("SELECT payload_json FROM events WHERE type='research.completed'").all(),old);assert.equal(f.db.prepare('SELECT sum(delta) xp FROM xp_ledger').get().xp,xp);
    assert.equal(requestExploration(f.db,added.id,view).state,'queued');assert.equal(explorationQueue(f.db).length,1);
  }finally{f.db.close();}
});

test('同学科分区复用会补齐历史未知节点，跨科新分区来自节点本身', () => {
  const f=fixture();
  try {
    const {r,claim}=enqueue(f),data=output(f);
    data.nodes[1]={...data.nodes[1],subject:'合成学科',area:'unclassified'};
    finishExploration(f.db,r.id,{token:claim.token,result:data},researchView(f.db));
    let view=researchView(f.db);
    const old=view.nodes.find(n=>n.subject==='合成学科');
    assert.equal(old.area,'unclassified');
    const add=(target,title,area)=>{
      const job=requestExploration(f.db,target.id,view),lease=claimExploration(f.db,job.id);
      const result={...output(f),targetId:target.id,nodes:[{id:'new',subject:'合成学科',title,area,description:'Fixture definition',support}],
        edges:[{from:'new',to:target.id,kind:'prerequisite',reason:'Fixture prerequisite',support}]};
      finishExploration(f.db,job.id,{token:lease.token,result},view);
      view=researchView(f.db);
      return view.nodes.find(n=>n.title===title);
    };
    const next=add(old,'新增基础','natural');
    assert.ok(view.nodes.filter(n=>n.subject==='合成学科').every(n=>n.area==='natural'));
    const newer=add(next,'再下一层','unclassified');
    assert.equal(newer.area,'natural');
    const stored=JSON.parse(f.db.prepare("SELECT payload_json FROM events WHERE type='exploration.finished' ORDER BY rowid DESC LIMIT 1").get().payload_json);
    assert.equal(stored.result.nodes[0].area,'natural');
  } finally { f.db.close(); }
});

test('待确定学科可从图上移动整个学科并恢复自动分区，节点与连线保留', async () => {
  const f=fixture(),host=await startServer({db:f.db,port:0}),ui=panelHarness({base:'http://127.0.0.1:'+host.port});
  try {
    const {r,claim}=enqueue(f),data=output(f);
    data.nodes[1]={...data.nodes[1],subject:'合成学科'};
    data.nodes.push({id:'extra',subject:'合成学科',title:'同学科节点',description:'Fixture definition',support});
    data.edges.push({from:'extra',to:f.target.id,kind:'prerequisite',reason:'Fixture prerequisite',support});
    finishExploration(f.db,r.id,{token:claim.token,result:data},researchView(f.db));
    const before=researchView(f.db),node=before.nodes.find(n=>n.subject==='合成学科');
    await ui.settle();
    ui.all(n=>n.props.role==='tab'&&ui.text(n)==='知识树')[0].props.onClick();await ui.settle();
    const areaButton=()=>ui.all(n=>n.props['data-area-filter']==='unclassified')[0];
    areaButton().props.onClick();await ui.settle();
    const selectArea=()=>ui.all(n=>n.props['aria-label']==='学科分区')[0];
    await selectArea().props.onChange({target:{value:'natural'}});await ui.settle();
    assert.ok(!areaButton());
    const after=researchView(f.db);
    assert.ok(after.nodes.filter(n=>n.subject==='合成学科').every(n=>n.area==='natural'&&n.areaOverride==='natural'));
    assert.deepEqual(after.edges,before.edges);
    assert.deepEqual(after.nodes.map(n=>n.id),before.nodes.map(n=>n.id));
    ui.all(n=>n.props['aria-label']==='选择知识点')[0].props.onChange({target:{value:node.id}});await ui.settle();
    await selectArea().props.onChange({target:{value:''}});await ui.settle();
    assert.ok(areaButton());
    assert.ok(researchView(f.db).nodes.filter(n=>n.subject==='合成学科').every(n=>n.area==='unclassified'&&!n.areaOverride));
  } finally { ui.dispose(); host.server.closeAllConnections(); await new Promise(resolve=>host.server.close(resolve));f.db.close(); }
});

test('二层新增、脱离目标、假引文、冒用全局ID、循环与过期结果均拒绝且不写半张图',()=>{
  const f=fixture();try{
    const before=JSON.stringify(researchView(f.db).nodes);
    const mutations=[
      d=>{d.nodes[0].existingId=undefined;d.nodes[0].title='新基础';d.nodes[0].subject='人工智能';d.edges[0].to='loss';},
      d=>{d.edges=d.edges.filter(e=>e.from!=='loss'||e.to!==f.target.id);},
      d=>{d.nodes[1].support=[{sourceId:'s1',quote:'Fabricated quotation.'}];},
      d=>{d.nodes[0].title='不同概念';},
      d=>{d.edges.push({from:f.target.id,to:f.known.id,kind:'prerequisite',reason:'Synthetic cycle',support});},
    ];
    for(const mutate of mutations){const {r,claim}=enqueue(f),data=output(f);mutate(data);assert.throws(()=>finishExploration(f.db,r.id,{token:claim.token,result:data},researchView(f.db)));
      assert.equal(JSON.stringify(researchView(f.db).nodes),before);finishExploration(f.db,r.id,{token:claim.token,failed:true,message:'Synthetic rejected result'},researchView(f.db));}
    const {r,claim}=enqueue(f);f.db.prepare("UPDATE events SET created_at=? WHERE type='exploration.claimed' AND json_extract(payload_json,'$.id')=?").run(Date.now()-400000,r.id);
    assert.throws(()=>finishExploration(f.db,r.id,{token:claim.token,result:output(f)},researchView(f.db)),/过期/);assert.equal(explorationQueue(f.db).length,0);
    assert.notEqual(requestExploration(f.db,f.target.id,researchView(f.db)).id,r.id);
  }finally{f.db.close();}
});

test('没有可核实前置时只保存本次结论，不把节点宣布为终极根',()=>{
  const f=fixture();try{const {r,claim}=enqueue(f);finishExploration(f.db,r.id,{token:claim.token,result:{...output(f),nodes:[],edges:[],outcome:'no-supported-prerequisites',reason:'Synthetic source did not establish a prerequisite'}},researchView(f.db));
    assert.equal(explorationStatuses(f.db)[0].outcome,'no-supported-prerequisites');assert.equal(researchView(f.db).nodes.length,3);assert.equal(researchView(f.db).nodes.find(n=>n.id===f.target.id).foundationRoot,undefined);
  }finally{f.db.close();}
});

test('模型只处理单节点与相关材料；复用缓存时两次模型调用，无全图递归审核',async()=>{
  const f=fixture();let calls=0;try{
    const {r}=enqueue(f),input=explorationInput(f.db,r.id,researchView(f.db));
    const result=await buildNodeExploration(input,{model:async(system,user)=>{calls++;const context=JSON.parse(user);assert.equal(context.target.id,f.target.id);
      if(system.startsWith('为用户选中'))return JSON.stringify({prerequisites:[{title:'概率空间',subject:'math',existingId:f.known.id},{title:'损失函数',subject:'人工智能'}],queries:[]});
      assert.ok(context.existingConcepts.some(n=>n.id===f.other.id));assert.ok(context.sources.every(s=>s.content.length<=6000));return JSON.stringify(output(f));
    },web:{search:async()=>{throw Error('cached definitions should not search');},fetch:async()=>{throw Error('cached definitions should not refetch');}}});
    assert.equal(calls,2);assert.equal(result.version,EXPLORATION_VERSION);assert.equal(result.nodes.length,2);
  }finally{f.db.close();}
});

test('初次建树复用旧递归图资料时仍限3份外部正文，不携带旧课程全文或整图审核字段',async()=>{
  const f=fixture();let calls=0;try{
    const base=researchInput(f.db,f.sessionId),old={...base.previous,sources:[{id:'course-text',url:'urn:old-course',content:'Old collected course material',fetchedAt:new Date().toISOString()},...Array.from({length:12},(_,i)=>({...source,id:'s'+i,url:'https://ocw.mit.edu/cached-'+i,content:content+' padding'.repeat(8000)}))]};
    const result=await buildResearch({...base,maps:[old]},{model:async(system,user)=>{
      calls++;if(system.startsWith('根据已看'))return JSON.stringify({subject:'人工智能',confidence:.99,reason:'Synthetic cached material',reuseKey:old.key,queries:['unused']});
      const context=JSON.parse(user);assert.equal(context.sources.length,3);assert.ok(context.sources.every(s=>s.id!=='course-text'&&s.content.length<=16000));return JSON.stringify({nodes:[],edges:[],foundationVersion:'untrusted-model-field',foundationPlan:{},foundationAudit:{passed:true}});
    },web:{search:async()=>{throw Error('cache should not search');},fetch:async()=>{throw Error('cache should not refetch');}}});
    assert.equal(calls,2);assert.equal(result.navigationMode,'overview-v1');assert.equal(result.foundationVersion,undefined);assert.equal(result.foundationAudit,undefined);
  }finally{f.db.close();}
});

test('HTTP按钮→宿主指定模型→只增一层；完成不再自动接单，未改其他分支',async()=>{
  const f=fixture(),host=await startServer({db:f.db,port:0}),base='http://127.0.0.1:'+host.port,previous=process.env.STUDY_SERVICE_URL;process.env.STUDY_SERVICE_URL=base;
  const ui=panelHarness({base}),defs=[];let modelCalls=0;
  saveModelSettings(f.db,{tasks:{navigation:{provider:'chatgpt',model:'fixture-on-demand'}},autoResearch:false});
  apply({effect(){},tools:{register:def=>defs.push(def)},web:{search:async()=>{throw Error('should reuse cached definition');},fetch:async()=>{throw Error('should reuse cached definition');}},llm:{stream({provider,model,system}){assert.equal(provider,'chatgpt');assert.equal(model,'fixture-on-demand');modelCalls++;
    const value=system.startsWith('为用户选中')?{prerequisites:[{title:'概率空间',subject:'math',existingId:f.known.id},{title:'损失函数',subject:'人工智能'}],queries:[]}:output(f);
    return (async function*(){yield {type:'text-delta',text:JSON.stringify(value)};})();}}});
  try{
    await ui.settle();ui.all(n=>n.props['aria-label']==='查看人工智能知识树')[0].props.onClick();await ui.settle();assert.ok(ui.text().includes('深挖只补一层'));
    await ui.click('深挖');assert.equal(explorationQueue(f.db).length,1);await ui.settle();assert.ok(ui.text().includes('深挖已排队'));
    const denied=await fetch(base+'/panel/research/nodes/'+f.target.id+'/explore',{method:'POST',headers:{origin:'https://untrusted.example','content-type':'application/json'},body:'{}'});assert.equal(denied.status,403);
    const tool=defs.find(d=>d.name==='study_explore_node');assert.equal((await tool.execute({nodeId:f.target.id},{})).state,'completed');assert.equal(modelCalls,2);
    assert.equal((await tool.execute({nodeId:f.target.id},{})).cached,true);assert.equal(modelCalls,2);assert.equal(explorationQueue(f.db).length,0);
    await ui.click('刷新');assert.ok(ui.text().includes('已深挖一层'));assert.ok(ui.text().includes('本次新增 1 个节点'));
    assert.equal(requestResearch(f.db,f.sessionId,{foundations:true}).cached,true);assert.equal(researchQueue(f.db,false).length,0);
  }finally{ui.dispose();host.server.closeAllConnections();await new Promise(r=>host.server.close(r));f.db.close();if(previous===undefined)delete process.env.STUDY_SERVICE_URL;else process.env.STUDY_SERVICE_URL=previous;}
});

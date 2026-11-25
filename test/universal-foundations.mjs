import test from 'node:test';
import assert from 'node:assert/strict';
import { FOUNDATION_VERSION, foundationErrors } from '../plugin/foundations.js';
import { m2Fixture } from './m2-fixture.mjs';
import { upsertCourse,saveSource,createSession,attachContent,buildContent,addSegments,saveLessonSummary } from '../server/core/store.mjs';
import { researchInput,saveResearch,researchView,requestResearch,researchQueue,assessResearchKnowledge } from '../server/core/research.mjs';
import { applyEvent } from '../server/core/events.mjs';
import { startServer } from '../server/http/server.mjs';
import { panelHarness } from './panel-harness.mjs';
import {certifyFixture} from './foundation-fixture.mjs';

function course(f,subject,bvid) {
  const c=upsertCourse(f.db,{platform:'bilibili',externalId:bvid,title:subject+'隔离测试',axis:subject});
  const sourceId=saveSource(f.db,{courseId:c.id,kind:'fixture',status:'ok'}),id=createSession(f.db,{courseId:c.id,sourceId});
  const text='本测试讲解两种方法的意义，以及如何用已有基础解释它们的关系。第二部分进一步讨论具体的观察与解释。';
  const content=buildContent({sessionId:id,sourceKind:'fixture',parts:[{text,ts:0}]});attachContent(f.db,id,content);addSegments(f.db,id,content);
  saveLessonSummary(f.db,{sessionId:id,model:'fixture',promptVersion:'fixture',summary:{overview:'隔离接线测试',coreIdeas:[{id:'a',title:subject+'方法一',meaning:'方法一的含义',evidence:content.text.slice(0,20)},{id:'b',title:subject+'方法二',meaning:'方法二的含义',evidence:content.text.slice(20)}],connections:[]}});
  applyEvent(f.db,{type:'capture.queued',payload:{bvid,page:1,ranges:[[0,90]],axis:subject}});
  applyEvent(f.db,{type:'capture.imported',payload:{bvid,page:1,sessionId:id,courseId:c.id,jobId:id}});
  return researchInput(f.db,id);
}
function graph(input) {
  const support=[{sourceId:'s',quote:'Original test fixture definitions and prerequisites.'}];
  const node=(id,title,extra={})=>({id,title,subject:input.axis,description:'隔离测试概念',support,...extra});
  return certifyFixture({key:input.key,subject:input.axis,confidence:.99,reason:'仅为接线测试',foundationVersion:FOUNDATION_VERSION,
    sources:[{id:'s',url:'https://ocw.mit.edu/fixture',title:'隔离测试原文',publisher:'fixture',authority:'fixture',content:support[0].quote,fetchedAt:new Date().toISOString()}],
    nodes:[node('root',input.axis+'入门符号',{foundationRoot:true,foundationReason:'本测试的入门边界'}),node('middle',input.axis+'基本概念'),
      ...input.lessonSummary.coreIdeas.map((idea,i)=>node('c'+i,idea.title,{courseQuote:idea.evidence,learningTargetIds:[idea.id]}))],
    edges:[{from:'root',to:'middle',kind:'prerequisite',reason:'测试递归先修',support},...input.lessonSummary.coreIdeas.map((_,i)=>({from:'middle',to:'c'+i,kind:'prerequisite',reason:'测试方法前置',support}))]},input.lessonSummary);
}

test('未知新学科同样强制课程核心覆盖与递归前置，缺根和遗漏主线均拒绝',()=>{
  const f=m2Fixture();try{
    const input=course(f,'地理信息学','BV1QcnP6DEMS'),g=graph(input);
    assert.deepEqual(foundationErrors(g,input.lessonSummary),[]);
    assert.deepEqual(foundationErrors(certifyFixture({...g,edges:g.edges.map(e=>({...e,kind:'suggested-prerequisite'}))},input.lessonSummary),input.lessonSummary),[]);
    assert.ok(foundationErrors({...g,edges:[]},input.lessonSummary).some(e=>e.includes('前置链')));
    assert.throws(()=>saveResearch(f.db,input.sessionId,{...g,nodes:g.nodes.filter(n=>n.id!=='c1'),edges:g.edges.filter(e=>e.to!=='c1')}),/未覆盖课程核心/);
    const before=f.db.prepare('SELECT SUM(delta) n FROM xp_ledger').get().n;
    saveResearch(f.db,input.sessionId,g);const view=researchView(f.db),root=view.nodes.find(n=>n.title==='地理信息学入门符号');
    assert.equal(root.status,'assumed');assert.equal(root.courseQuote,null);
    assessResearchKnowledge(f.db,root.id,{state:'self-known'});assert.equal(researchView(f.db).nodes.find(n=>n.id===root.id).status,'self-confirmed');
    assert.equal(f.db.prepare('SELECT SUM(delta) n FROM xp_ledger').get().n,before);
  }finally{f.db.close();}
});

test('旧图保留且复用，不再因旧请求或foundations参数进入全库递归重跑',()=>{
  const f=m2Fixture();try{
    const input=course(f,'天文学','BV1QcnP6DEMS'),g=graph(input);const old={...g};delete old.foundationVersion;
    saveResearch(f.db,input.sessionId,old);assert.equal(requestResearch(f.db,input.sessionId).cached,true);
    assert.equal(researchQueue(f.db).length,0);
    assert.equal(requestResearch(f.db,input.sessionId,{foundations:true}).cached,true);assert.equal(researchQueue(f.db).length,0);
    saveResearch(f.db,input.sessionId,g);assert.equal(researchQueue(f.db).length,0);
    assert.equal(requestResearch(f.db,input.sessionId,{foundations:true}).cached,true);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='research.completed'").get().n,2);
    assert.equal(researchView(f.db).nodes.filter(n=>n.title==='天文学入门符号').length,1);
  }finally{f.db.close();}
});

test('默认全学科全览，点击学科只显示本学科，返回全览恢复全部根系；基础在下',async()=>{
  const f=m2Fixture();const a=course(f,'经济学','BV1QcnP6DEMS'),b=course(f,'天文学','BV1ib411t7YR');
  saveResearch(f.db,a.sessionId,graph(a));saveResearch(f.db,b.sessionId,graph(b));
  const {server,port}=await startServer({db:f.db,port:0}),ui=panelHarness({base:'http://127.0.0.1:'+port});
  try{
    await ui.settle();await ui.click('知识树');assert.match(ui.text(),/知识星图 · 全部学科/);
    const roots=ui.all(n=>n.props['data-subject-root']);assert.ok(roots.some(n=>n.props['data-subject-root']==='经济学'));assert.ok(roots.some(n=>n.props['data-subject-root']==='天文学'));
    const expected=new Set(researchView(f.db).nodes.map(n=>n.id));
    const ids=()=>new Set(ui.all(n=>n.props['data-knowledge-node']).map(n=>n.props['data-knowledge-node']).filter(id=>expected.has(id)));const before=ids();assert.deepEqual(before,expected);
    await ui.click('天文学');assert.deepEqual(ids(),new Set(researchView(f.db).nodes.filter(n=>n.subject==='天文学').map(n=>n.id)));
    assert.deepEqual(ui.all(n=>n.props['data-subject-root']).map(n=>n.props['data-subject-root']),['天文学']);
    const focusNode=ui.all(n=>n.props['data-knowledge-node']&&expected.has(n.props['data-knowledge-node']))[0];focusNode.props.onDoubleClick({preventDefault(){},stopPropagation(){}});await ui.settle();
    await ui.click('经济学');assert.deepEqual(ids(),new Set(researchView(f.db).nodes.filter(n=>n.subject==='经济学').map(n=>n.id)));
    await ui.click('全部学科 · 同图');assert.deepEqual(ids(),before);
    assert.equal(ui.all(n=>n.type==='button'&&ui.text(n)==='经济学')[0].props['aria-pressed'],false);
    await ui.click('经济学');await ui.click('总览');await ui.click('知识树');assert.deepEqual(ids(),before);
    const graphView=researchView(f.db),root=graphView.nodes.find(n=>n.title==='经济学入门符号'),advanced=graphView.nodes.find(n=>n.title==='经济学方法一');
    const y=id=>Number(ui.all(n=>n.props['data-knowledge-node']===id)[0].props.transform.match(/translate\([^,]+,([^\)]+)\)/)[1]);
    assert.ok(y(root.id)>y(advanced.id));
    const screen=ui.all(n=>n.type==='svg'&&n.props.ref)[0];screen.props.ref.current.listeners.get('wheel').handler({deltaY:-100,deltaMode:0,preventDefault(){},stopPropagation(){}});await ui.settle();assert.ok(Number(ui.text().match(/ZOOM (\d+)%/)[1])>100);
  }finally{ui.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));f.db.close();}
});

test('尚未联网的课程核心也显示，来自不同会话的同名目标ID不串课',()=>{
  const f=m2Fixture();try{
    const a=course(f,'语言学','BV1QcnP6DEMS');
    assert.ok(researchView(f.db).nodes.some(n=>n.title==='语言学方法二'&&n.origin==='course-summary'));
    saveResearch(f.db,a.sessionId,graph(a));
    const next=createSession(f.db,{courseId:a.courseId});const text='这是同一课程下一讲的新内容与新概念。';attachContent(f.db,next,{text,normalizerVersion:1});
    saveLessonSummary(f.db,{sessionId:next,model:'fixture',promptVersion:'fixture',summary:{overview:'下一讲',coreIdeas:[{id:'a',title:'新的语音概念',meaning:'新概念',evidence:text}],connections:[]}});
    assert.ok(researchView(f.db).nodes.some(n=>n.title==='新的语音概念'));
  }finally{f.db.close();}
});

test('先建图后生成新提要时显示新增课程目标，不启动全图递归补齐',()=>{
  const f=m2Fixture();try{
    const input=course(f,'逻辑学','BV1QcnP6DEMS'),full=graph(input);
    f.db.prepare("DELETE FROM events WHERE type='lesson.summarized' AND json_extract(payload_json,'$.sessionId')=?").run(input.sessionId);
    const partial=certifyFixture({...full,nodes:full.nodes.filter(n=>n.id!=='c1'),edges:full.edges.filter(e=>e.to!=='c1')});
    saveResearch(f.db,input.sessionId,partial);assert.equal(researchQueue(f.db).length,0);
    saveLessonSummary(f.db,{sessionId:input.sessionId,model:'fixture',promptVersion:'fixture',summary:input.lessonSummary});
    assert.equal(researchQueue(f.db).length,0);assert.ok(researchView(f.db).nodes.some(n=>n.origin==='course-summary'));
    saveResearch(f.db,input.sessionId,full);assert.equal(researchQueue(f.db).length,0);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='research.completed'").get().n,2);
  }finally{f.db.close();}
});

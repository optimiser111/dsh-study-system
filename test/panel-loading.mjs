import test from 'node:test';import assert from 'node:assert/strict';
import {m2Fixture} from './m2-fixture.mjs';import {startServer} from '../server/http/server.mjs';import {panelHarness} from './panel-harness.mjs';
import {researchInput,researchQueue,researchView,requestResearch,researchFailure,saveResearchCheckpoint} from '../server/core/research.mjs';
import {FOUNDATION_VERSION} from '../plugin/foundations.js';

test('大量历史草稿保留：普通队列不解析教材草稿，进度只读最新草稿，旧断点仍可单独读取',t=>{
  const f=m2Fixture();try{
    const input=researchInput(f.db,f.sessionId);requestResearch(f.db,f.sessionId);researchFailure(f.db,f.sessionId,input.key,'Synthetic stopped task');
    for(let i=0;i<40;i++)saveResearchCheckpoint(f.db,f.sessionId,{key:input.key,foundationVersion:FOUNDATION_VERSION,stage:'incomplete',stageLabel:'Draft '+i,classification:{subject:'人工智能'},plan:{concepts:[]},sources:[],gaps:['Synthetic gap'],checkpointMarker:'bulk-fixture',padding:'x'.repeat(100000)});
    const original=JSON.parse;let parsed=0;t.mock.method(JSON,'parse',(value,...args)=>{if(typeof value==='string'&&value.includes('"checkpointMarker":"bulk-fixture"'))parsed++;return original(value,...args);});
    assert.equal(researchQueue(f.db,false).length,0);assert.equal(parsed,0);
    const view=researchView(f.db);assert.equal(view.foundationProgress[0].label,'Draft 39');assert.equal(parsed,1);
    const legacy=researchInput(f.db,f.sessionId);assert.equal(legacy.checkpoint.stageLabel,'Draft 39');assert.equal(parsed,2);
    assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE type='research.checkpoint'").get().n,40);
  }finally{f.db.close();}
});

test('设置读取超时明确报错，刷新能恢复，不永久显示读取中',async()=>{
  const f=m2Fixture(),app=await startServer({db:f.db,port:0}),base='http://127.0.0.1:'+app.port;let stalled=true,aborted=0;
  const ui=panelHarness({base,requestTimeoutMs:1000,fetchOverride:(url,options)=>{
    if(stalled&&new URL(url).pathname==='/panel/models/settings')return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>{aborted++;reject(options.signal.reason);},{once:true}));
  }});
  try{
    await ui.settle();await ui.click('设置');assert.ok(aborted>0);assert.ok(ui.text().includes('本地学习服务响应超时'));assert.ok(ui.text().includes('设置尚未读取'));assert.ok(!ui.text().includes('正在读取设置…'));
    stalled=false;await ui.click('刷新');assert.ok(ui.all(n=>n.props['aria-label']==='联网知识导航模型').length>0);assert.ok(!ui.text().includes('设置尚未读取'));
  }finally{ui.dispose();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));f.db.close();}
});

test('知识图不重复订阅；慢请求期间连续轮询也不叠加请求',async()=>{
  const f=m2Fixture(),app=await startServer({db:f.db,port:0}),base='http://127.0.0.1:'+app.port;let slow=false,calls=0,release;
  const ui=panelHarness({base,fetchOverride:(url,options)=>{
    if(new URL(url).pathname==='/panel/research'){
      calls++;if(slow)return new Promise((resolve,reject)=>{release=resolve;options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
    }
  }});
  try{
    await ui.settle();assert.equal(calls,1);await ui.click('知识树');assert.equal(calls,1);
    slow=true;ui.tickPolls();ui.tickPolls();ui.tickPolls();assert.equal(calls,2);
    release({ok:true,json:async()=>({nodes:[],edges:[],pending:[],queued:[],failures:[],autoResearch:true})});await ui.settle();slow=false;ui.tickPolls();await ui.settle();assert.equal(calls,3);
  }finally{ui.dispose();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));f.db.close();}
});

test('数学自检读取失败显示实际错误，不冒充正在建图',async()=>{
  const f=m2Fixture(),app=await startServer({db:f.db,port:0}),base='http://127.0.0.1:'+app.port;
  const ui=panelHarness({base,fetchOverride:url=>new URL(url).pathname==='/panel/knowledge'?Promise.resolve({ok:false,status:503,json:async()=>({error:'Synthetic knowledge read failed'})}):null});
  try{await ui.settle();await ui.click('知识树');assert.ok(ui.text().includes('数学自检读取失败'));assert.ok(ui.text().includes('Synthetic knowledge read failed'));assert.ok(!ui.text().includes('正在构建知识邻域'));}
  finally{ui.dispose();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));f.db.close();}
});

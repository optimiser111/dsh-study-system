import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../server/db/open.mjs';
import {ReadingCapture,readingLines} from '../server/capture/reading.mjs';
import {Collector,captureJobs} from '../server/capture/collector.mjs';
import {captureAction,captureReadiness,generationQueue} from '../server/core/capture-controls.mjs';
import {loadContent} from '../server/core/store.mjs';
import {studyProgress} from '../server/core/progress.mjs';
import {startServer} from '../server/http/server.mjs';
import {panelHarness} from './panel-harness.mjs';
import {researchQueue} from '../server/core/research.mjs';
import {codexMessages, CODEX_TURN_LIMIT} from '../server/capture/codex.mjs';
const window={id:'7',processId:11,started:'123',process:'Acrobat',title:'Research methods.pdf',strict:true,rank:0};
const paragraph=i=>`Research statement ${i}: controlled experiments compare groups under the same conditions and report the evidence without assuming the conclusion.`;
const frame=(ids,state='captured')=>({state,window,engine:'fixture-ocr',language:'en-GB',width:1200,height:900,lines:ids.map((id,i)=>({text:paragraph(id),x:40,y:50+i*35,width:1050,height:24}))});
function fixture(){const {db}=openDb(':memory:');let now=100000,snapshot=frame([1,2,3,4]);const probe=async action=>action==='list'?{windows:[window],videoRank:999}:snapshot;
  const collector=new Collector(db,{now:()=>now,getVideo:()=>{throw Error('must not read video');}}),reading=new ReadingCapture(db,{enabled:true,probe,now:()=>now});collector.reading=reading;
  return {db,collector,reading,probe,advance(){now+=5000;},set(value){snapshot=value;}};
}
test('阅读采集去重、切窗暂停与身份校验；结束后按正文量出题，不套用视频30秒门槛',async()=>{
  const f=fixture();try{
    await captureAction(f.db,f.collector,'start');assert.equal(f.collector.settings.desktopEnabled,false);assert.equal(captureReadiness(f.db,f.collector).canGenerate,false);
    await f.reading.poll();const first=f.reading.view().characters;f.advance();await f.reading.poll();assert.equal(f.reading.view().characters,first);
    f.set(frame([3,4,5,6]));f.advance();await f.reading.poll();assert.equal(f.reading.view().frames,2);
    f.set({...frame([999]),state:'paused'});f.advance();await f.reading.poll();
    f.set({...frame([999]),window:{...window,title:'private chat'}});f.advance();await f.reading.poll();
    f.collector.observe({source:'browser',focused:true,url:'https://www.bilibili.com/video/BV1ib411t7YR/',playing:true,position:5});assert.equal(f.collector.active,null);
    await captureAction(f.db,f.collector,'stop');const ready=captureReadiness(f.db,f.collector);assert.equal(ready.canGenerate,true);assert.equal(ready.kind,'reading');assert.ok(ready.seconds<30);
    const job=captureJobs(f.db)[0],content=loadContent(f.db,job.sessionId).text;assert.equal(job.sourceKind,'desktop-ocr');assert.ok(!content.includes('999'));assert.equal((content.match(/Research statement 3:/g)||[]).length,1);
    await captureAction(f.db,f.collector,'questions');await captureAction(f.db,f.collector,'questions');assert.equal(generationQueue(f.db).length,1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cards').get().n,0);
    f.db.prepare("UPDATE courses SET axis='研究方法' WHERE id=?").run(job.courseId);assert.ok(studyProgress(f.db)[0].readCharacters>200);
  }finally{f.reading.shutdown();f.db.close();}
});
test('阅读不足时不创建课程或开放出题；重启保留正文但不自动截图，停止幂等',async()=>{
  const f=fixture();try{
    f.set(frame([]));await captureAction(f.db,f.collector,'start');await f.reading.poll();await captureAction(f.db,f.collector,'stop');assert.equal(captureReadiness(f.db,f.collector).canGenerate,false);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM courses').get().n,0);
    await captureAction(f.db,f.collector,'start');f.set(frame([1,2,3]));await f.reading.poll();const chars=f.reading.view().characters;
    let nativeCalls=0;const recovered=new ReadingCapture(f.db,{enabled:true,probe:async()=>{nativeCalls++;throw Error('no screenshot on restart');}});f.collector.reading=recovered;
    assert.equal(recovered.view().state,'interrupted');assert.equal(recovered.view().characters,chars);await recovered.poll();assert.equal(nativeCalls,0);
    await captureAction(f.db,f.collector,'stop');const count=f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='capture.imported'").get().n;await recovered.stop();assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='capture.imported'").get().n,count);assert.equal(count,1);recovered.shutdown();
  }finally{f.reading.shutdown();f.db.close();}
});
test('停止中的迟到OCR结果不落库，窗口选择只能选候选；数字变化不能被模糊去重',async()=>{
  const f=fixture();try{
    await captureAction(f.db,f.collector,'start');let release;f.reading.probe=()=>new Promise(r=>release=r);const pending=f.reading.poll(),stop=f.reading.stop();release(frame([99]));await Promise.all([pending,stop]);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='reading.frame'").get().n,0);
    f.reading.probe=async()=>({windows:[{...window,strict:false}],videoRank:999});await f.reading.start('another','reading');assert.throws(()=>f.reading.select('fake'),/不存在/);
  }finally{f.reading.shutdown();f.db.close();}
  const ordered=readingLines({...frame([1]),lines:[{text:'实 验 设 计 需 要 控 制 变 量',x:20,y:20,width:600,height:25},{text:'Result value = -12.5',x:20,y:50,width:600,height:25},{text:'Result value = 12.5',x:20,y:80,width:600,height:25}]});
  assert.equal(ordered[0].text,'实验设计需要控制变量');assert.equal(ordered.length,3);
});
test('真实HTTP与面板三按钮接入阅读来源；非本机网页不能启动截屏或读窗口信息',async()=>{
  const f=fixture(),host=await startServer({db:f.db,port:0,readingOptions:{enabled:true,probe:f.probe}}),base='http://127.0.0.1:'+host.port;
  const ui=panelHarness({base});try{
    const denied=await fetch(base+'/panel/capture/start',{method:'POST',headers:{origin:'https://untrusted.example','content-type':'application/json'},body:'{}'});assert.equal(denied.status,403);assert.equal(host.collector.settings.enabled,false);
    await ui.settle();await ui.click('开始采集');assert.equal(host.reading.selectedForRun,true);await host.reading.poll();await ui.settle();assert.ok(ui.text().includes('字'));assert.equal(ui.all(n=>n.type==='button'&&ui.text(n)==='出题').length,0);
    await ui.click('结束采集');assert.ok(ui.all(n=>n.type==='button'&&ui.text(n)==='出题').length);await ui.click('出题');assert.equal(generationQueue(f.db).length,1);
    const segments=await(await fetch(base+'/sessions/'+captureJobs(f.db)[0].sessionId+'/segments')).json();assert.equal(segments.segments[0].sourceKind,'desktop-ocr');assert.ok(segments.segments[0].warnings.some(w=>w.code==='desktop-ocr-review'));
  }finally{ui.dispose();host.server.closeAllConnections();await new Promise(r=>host.server.close(r));f.reading.shutdown();f.db.close();}
});

test('先开始再打开文档会发现窗口；保存失败保留结束按钮和材料，重试能成功',async()=>{
  const f=fixture();try{
    let opened=false;f.reading.probe=async action=>action==='list'?{windows:opened?[window]:[],videoRank:999}:frame([1,2,3]);
    f.collector.configure({captureMode:'reading'});await captureAction(f.db,f.collector,'start');assert.equal(f.reading.view().state,'select-window');
    opened=true;await f.reading.poll();assert.equal(f.reading.view().target.id,window.id);await f.reading.poll();
    const original=f.db.prepare.bind(f.db);let fail=true;f.db.prepare=sql=>{if(fail&&sql.includes('INSERT INTO sources')){fail=false;throw Error('simulated disk failure');}return original(sql);};
    await assert.rejects(()=>captureAction(f.db,f.collector,'stop'),/simulated disk failure/);assert.equal(f.collector.settings.enabled,true);assert.ok(f.reading.view().characters>200);
    await captureAction(f.db,f.collector,'stop');assert.equal(captureReadiness(f.db,f.collector).canGenerate,true);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM courses').get().n,1);
  }finally{f.reading.shutdown();f.db.close();}
});

test('ChatGPT 配对采集锁定一段对话、按消息去重与排序，结束后才允许出题',async()=>{
  const {db}=openDb(':memory:');
  const key='a'.repeat(64);
  const host=await startServer({db,chatOptions:{key},readingOptions:{enabled:true,probe:async()=>assert.fail('ChatGPT 网页不调用本机 OCR')}});
  const base='http://127.0.0.1:'+host.port,ui=panelHarness({base});
  const endpoint=base+'/collector/chatgpt';
  const headers={authorization:'Bearer '+key,origin:'chrome-extension://'+'a'.repeat(32),'content-type':'application/json'};
  const call=async body=>(await fetch(endpoint,{headers,...(body?{method:'POST',body:JSON.stringify(body)}:{})})).json();
  try{
    assert.equal((await fetch(endpoint)).status,401);
    assert.equal((await fetch(endpoint,{headers:{...headers,origin:'https://chatgpt.com'}})).status,403);
    assert.deepEqual(await call(),{enabled:false});
    host.collector.configure({captureMode:'chatgpt'});
    await ui.settle();await ui.click('开始采集');
    assert.match(ui.text(),/打开 ChatGPT 网页对话/);
    const { runId }=await call();
    const target={runId,conversationId:'example-thread',bindingId:'browser-tab-1'};
    const assistant={id:'a1',role:'assistant',order:1,text:paragraph(1)+'\n'+paragraph(2)+'\n```js\n\tconst A = 1;\n```'};
    const question={id:'q1',role:'user',order:0,text:'如何理解对照实验？'};
    const frame={action:'frame',...target,messages:[assistant]};
    assert.equal((await call(frame)).state,'unbound');
    assert.equal((await call({action:'bind',...target,title:'对照实验 · ChatGPT'})).accepted,true);
    assert.equal((await call({...frame,runId:'old-run'})).accepted,false);
    assert.equal((await call({...frame,conversationId:'different-chat'})).accepted,false);
    assert.equal((await call({...frame,bindingId:'different-tab'})).accepted,false);
    assert.equal((await call(frame)).accepted,true);
    await call({...frame,messages:[question,assistant]});
    ui.tickPolls();await ui.settle();assert.match(ui.text(),/ChatGPT 问答/);
    assert.equal(host.reading.view().frames,2);
    assert.equal(ui.all(n=>n.type==='button'&&ui.text(n)==='出题').length,0);
    await ui.click('结束采集');assert.match(ui.text(),/ChatGPT 对话已保存/);
    assert.deepEqual(await call(),{enabled:false});
    assert.equal((await call(frame)).accepted,false);
    assert.equal(researchQueue(db).length,0);
    const [job]=captureJobs(db),content=loadContent(db,job.sessionId);
    assert.equal(job.sourceKind,'chatgpt-conversation');
    assert.equal(content.normalizerVersion,2);
    assert.ok(content.text.startsWith('【用户提问】\n如何理解对照实验？\n【ChatGPT 回答】'));
    assert.ok(content.text.includes('\tconst A = 1;'));
    assert.equal(content.text.match(/Research statement 1:/g).length,1);
    assert.equal(generationQueue(db).length,0);
    await ui.click('出题');assert.equal(generationQueue(db).length,1);
    const {segments}=await(await fetch(base+'/sessions/'+job.sessionId+'/segments')).json();
    assert.equal(segments[0].sourceKind,'chatgpt-conversation');
    assert.ok(segments[0].warnings.some(w=>w.code==='chatgpt-excerpt'));
  }finally{ui.dispose();host.server.closeAllConnections();await new Promise(r=>host.server.close(r));db.close();}
});

test('ChatGPT 仅采到问题时不开放出题，重启后保留已采集的回答',async()=>{
  const f=fixture();
  try{
    f.collector.configure({captureMode:'chatgpt'});
    const bind=()=>{const payload={runId:f.collector.reading.chatStatus().runId,conversationId:'same-thread',bindingId:'tab'};f.collector.reading.receiveChat({action:'bind',...payload});return payload;};
    await captureAction(f.db,f.collector,'start');
    f.reading.receiveChat({action:'frame',...bind(),messages:[{id:'question',role:'user',order:0,text:paragraph(1).repeat(4)}]});
    await captureAction(f.db,f.collector,'stop');
    assert.equal(captureReadiness(f.db,f.collector).canGenerate,false);
    assert.match(captureReadiness(f.db,f.collector).reason,/0 个回答字符/);
    await captureAction(f.db,f.collector,'start');
    f.reading.receiveChat({action:'frame',...bind(),messages:[{id:'answer',role:'assistant',order:0,text:paragraph(1).repeat(4)}]});
    const recovered=new ReadingCapture(f.db,{enabled:true,probe:async()=>assert.fail('重启后不读浏览器')});
    f.collector.reading=recovered;
    assert.equal(recovered.chatStatus().enabled,false);
    assert.equal(recovered.view().state,'interrupted');
    await captureAction(f.db,f.collector,'stop');
    assert.equal(captureReadiness(f.db,f.collector).canGenerate,true);
    recovered.shutdown();
  }finally{f.reading.shutdown();f.db.close();}
});

test('Codex 采集选定会话的近期最终问答，保留代码而跳过中间输出',async()=>{
  const {db}=openDb(':memory:');
  const turn = index => ({status:'completed',items:[
    {type:'userMessage',content:[{type:'text',text:'问题 '+index},{type:'image',url:'data:attachment'}]},
    {type:'agentMessage',phase:'commentary',text:'PRIVATE_PROGRESSION'},
    {type:'commandExecution',aggregatedOutput:'PRIVATE_TOOL_OUTPUT'},
    {type:'agentMessage',phase:'final_answer',text:paragraph(index)+'\n```js\n  const A = 1;\n```'},
  ]});
  const turns=[...Array.from({length:CODEX_TURN_LIMIT+2},(_,i)=>turn(i+1)),{...turn(999),status:'inProgress'}];
  const calls=[];
  const codex={list:async()=>[{id:'selected',title:'对照实验',updatedAt:10000},{id:'other',title:'另一段对话',updatedAt:5000}],
    read:async id=>{calls.push(id);return codexMessages(turns);}};
  const host=await startServer({db,readingOptions:{codex,probe:async()=>assert.fail('Codex 采集不调用 OCR')}});
  const base='http://127.0.0.1:'+host.port,ui=panelHarness({base});
  const request=async (path,body,origin='dsh-app://app')=>fetch(base+path,{headers:{origin,'content-type':'application/json'},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  try{
    host.collector.configure({captureMode:'codex'});
    assert.equal((await request('/panel/capture/start',{},'http://localhost:8000')).status,403);
    await ui.settle();await ui.click('开始采集');
    assert.ok(ui.all(n=>n.props['aria-label']==='选择 Codex 会话').length);
    assert.equal(calls.length,0);
    const untrusted=await(await request('/panel/capture',null,'http://localhost:8000')).json();
    assert.equal(untrusted.reading.candidates.length,0);
    assert.equal((await request('/panel/reading/select',{id:'other'},'http://localhost:8000')).status,403);
    assert.equal((await request('/panel/reading/select',{id:'unlisted'})).status,400);
    assert.equal((await request('/panel/reading/select',{id:'selected'})).status,200);
    assert.deepEqual(calls,['selected']);
    assert.equal((await request('/panel/reading/select',{id:'other'})).status,400);
    await host.reading.poll();assert.deepEqual(calls,['selected']);
    ui.tickPolls();await ui.settle();assert.match(ui.text(),/已读取 Codex 问答/);
    await ui.click('结束采集');assert.match(ui.text(),/Codex 对话已保存/);
    const [job]=captureJobs(db),content=loadContent(db,job.sessionId);
    assert.equal(job.sourceKind,'codex-conversation');
    assert.ok(content.text.startsWith('【用户提问】\n问题 3\n【Codex 回答】'));
    assert.equal(content.text.match(/【Codex 回答】/g).length,CODEX_TURN_LIMIT);
    assert.ok(!/PRIVATE_|attachment|999/.test(content.text));
    assert.ok(content.text.includes('\n  const A = 1;\n'));
    assert.equal(researchQueue(db).length,0);
    await ui.click('出题');assert.equal(generationQueue(db).length,1);
  }finally{ui.dispose();host.server.closeAllConnections();await new Promise(resolve=>host.server.close(resolve));db.close();}
});

test('停止 Codex 采集会丢弃未完成的读取结果，随后可以重新选会话',async()=>{
  const {db}=openDb(':memory:'),collector=new Collector(db);
  let release;
  const codex={list:async()=>[{id:'selected',title:'测试会话'}],read:()=>new Promise(resolve=>{release=resolve;})};
  const reading=new ReadingCapture(db,{codex});collector.reading=reading;
  try{
    collector.configure({captureMode:'codex'});
    await captureAction(db,collector,'start');
    const pending=reading.select('selected'),stopping=captureAction(db,collector,'stop');
    release([{role:'assistant',order:0,text:paragraph(1).repeat(4)}]);
    await Promise.all([pending,stopping]);
    assert.equal(captureJobs(db).length,0);
    assert.equal(db.prepare("SELECT count(*) n FROM events WHERE type='reading.frame'").get().n,0);
    await captureAction(db,collector,'start');assert.equal(reading.view().state,'codex-select');
  }finally{reading.shutdown();db.close();}
});

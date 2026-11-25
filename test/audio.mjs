import test from 'node:test';
import assert from 'node:assert/strict';
import { Collector, captureJobs } from '../server/capture/collector.mjs';
import { m2Fixture } from './m2-fixture.mjs';
import { loadContent } from '../server/core/store.mjs';
import { segmentWarnings } from '../server/sources/warnings.mjs';
import { buildSummaryPrompt } from '../plugin/lesson-core.js';
import { startServer } from '../server/http/server.mjs';
import { panelHarness } from './panel-harness.mjs';
import { interpretDesktop } from '../server/capture/desktop.mjs';
import { captureAction, captureReadiness } from '../server/core/capture-controls.mjs';

test('桌面已识别的播放器PID交给音频层；真实前台课程窗口可覆盖错误的网页隐藏标记',()=>{
  const raw={detected:true,app:{processId:123,foreground:true,windowTitle:'测试课',executable:'bilibili.exe'},
    player:{hasVideo:true,title:'测试课',bvid:'BV1ib411t7YR',page:3,cid:'123',duration:600,position:100,playing:true,rate:1,visible:false}};
  const result=interpretDesktop(raw);
  assert.equal(result.observation.processId,123);assert.equal(result.observation.visible,true);
  assert.equal(interpretDesktop({...raw,app:{...raw.app,windowTitle:'其他B站窗口'}}).observation.visible,false);
  assert.equal(interpretDesktop({...raw,app:{...raw.app,foreground:false}}).observation.visible,false);
});

test('长时间暂停不会计入播放；不足30秒的真实片段仍显示时长及中断原因，停止后不误报断开',async()=>{
  const f=m2Fixture();try{
    let now=1000000;
    const c=new Collector(f.db,{now:()=>now});await captureAction(f.db,c,'start');
    for(const position of [0,5,10]){c.observe({...sample,position});now+=5000;}
    c.observe({...sample,position:10,focused:false});now+=480000;c.observe({...sample,position:490,focused:false});
    await captureAction(f.db,c,'stop');const ready=captureReadiness(f.db,c);
    assert.equal(ready.canGenerate,false);assert.equal(ready.seconds,10);assert.match(ready.reason,/播放器不在前台/);
    const restored=new Collector(f.db,{now:()=>now});assert.equal(restored.diagnostics.lastIssue,'播放器不在前台');
    now+=500000;restored.tick();assert.equal(restored.view().state,'disabled');
  }finally{f.db.close();}
});

const bvid='BV1ib411t7YR', sample={url:'https://www.bilibili.com/video/'+bvid+'/',rate:1,playing:true,focused:true,visible:true,idleState:'active'};
const cues=Array.from({length:8},(_,i)=>({from:i*5,to:i*5+4,text:'这是隔离测试课程，向量的分量可以分别进行数乘与相加，得到的结果是线性组合。'}));
function rig(f, {subtitle={ok:false},mode='fallback',recognized=cues}={}) {
  let now=1000000; const calls=[];
  const audio={observe:(...args)=>calls.push(['observe',...args]),close:(id)=>calls.push(['close',id]),tick(){},forJob:async()=>recognized};
  const c=new Collector(f.db,{now:()=>now,audio,getVideo:async()=>({title:'测试音频课',pages:[{page:1}]}),getSubtitle:async()=>subtitle});
  c.configure({enabled:true,audioMode:mode,allowed:[{bvid,axis:'math'}]});
  for(let p=0;p<=40;p+=5){c.observe({...sample,position:p});now+=5000;}
  c.configure({enabled:false});return {c,calls};
}

test('字幕缺失时本地音频入库，保留来源与观看范围；静音或质量不足拒绝',async()=>{
  for(const recognized of [cues.map((c,i)=>({...c,text:c.text+'第'+i+'段。'})),[]]){
    const f=m2Fixture();try{
      const before=f.db.prepare('select count(*) n from answers').get().n;
      const {c,calls}=rig(f,{recognized});await c.drain();const job=captureJobs(f.db)[0];
      assert.equal(job.stage,recognized.length?'prepared':'failed');
      assert.ok(calls.some(c=>c[0]==='close'));
      if(recognized.length){
        const source=f.db.prepare('select r.kind,r.detail from sources r join sessions s on s.source_id=r.id where s.id=?').get(job.sessionId);
        assert.equal(source.kind,'bilibili-local-asr');assert.equal(JSON.parse(source.detail).needsReview,true);
        assert.ok(loadContent(f.db,job.sessionId).text.includes('线性组合'));
      }
      assert.equal(f.db.prepare('select count(*) n from answers').get().n,before);
    }finally{f.db.close();}
  }
});

test('默认优先字幕，强制音频可验收；无已采集音频时不倒灌整讲',async()=>{
  const f=m2Fixture();try{
    const {c}=rig(f,{subtitle:{ok:true,cues},recognized:[]});await c.drain();
    const job=captureJobs(f.db)[0];assert.equal(job.stage,'prepared');assert.equal(job.sourceKind,'bilibili-cc');
    assert.match(buildSummaryPrompt([{sourceKind:'bilibili-local-asr',text:'原文'}]),/不得把同音猜测/);
    assert.equal(segmentWarnings({source_kind:'bilibili-local-asr',text:'向梁',span_start:0,span_end:2})[0].code,'local-asr-review');
  }finally{f.db.close();}
});

test('暂停、锁屏和离开页面向音频层发送停止信号',()=>{
  const f=m2Fixture();try{
    const {c,calls}=rig(f);c.configure({enabled:true});
    for(const patch of [{playing:false},{focused:false},{visible:false},{idleState:'locked'}]){
      c.observe({...sample,position:100,...patch});assert.equal(calls.at(-1)[3],false);
    }
  }finally{f.db.close();}
});

test('设置页可选择强制音频，采集中拒绝切换来源',async()=>{
  const f=m2Fixture();const {server,port,collector}=await startServer({db:f.db,port:0});const base='http://127.0.0.1:'+port,ui=panelHarness({base});
  try{
    await ui.settle();await ui.click('设置');
    ui.all(n=>n.type==='select'&&n.props['aria-label']==='课程内容来源')[0].props.onChange({target:{value:'force'}});await ui.settle();await ui.click('保存内容来源');
    assert.equal(collector.settings.audioMode,'force');
    collector.configure({enabled:true});
    const r=await fetch(base+'/panel/audio/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'off'})});assert.equal(r.status,400);
  }finally{ui.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));f.db.close();}
});

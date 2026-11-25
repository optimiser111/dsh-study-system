import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Collector, captureJobs } from '../server/capture/collector.mjs';
import { DesktopCapture, interpretDesktop, clockSeconds } from '../server/capture/desktop.mjs';
import { PLAYER_EXPRESSION, readPlayerBridge, localSocket } from '../server/capture/desktop-player.mjs';
import { m2Fixture } from './m2-fixture.mjs';
import { startServer } from '../server/http/server.mjs';
import { panelHarness } from './panel-harness.mjs';
const bvid='BV1ib411t7YR';
const snapshot = (position=0) => ({ detected:true,bridgePort:7790,locked:false,app:{processId:1,name:'哔哩哔哩',executable:'D:/Bilibili/哔哩哔哩.exe',windowTitle:'向量课程',foreground:true},media:{title:'向量课程',position,duration:592,status:'Playing',rate:1},nodes:[{type:'Document',value:'https://www.bilibili.com/video/'+bvid+'/?p=2'}] });

test('客户端能力不足时不猜进度、倍速或P1；手动绑定只匹配当前播放项，变化后失效', () => {
  const raw=snapshot(); raw.nodes=[]; raw.media.duration=0;raw.media.rate=null;
  let view=interpretDesktop(raw);
  assert.equal(view.capabilities.position,false);assert.equal(view.capabilities.identity,false);assert.equal(view.observation.playing,false);
  raw.media.duration=592;raw.media.rate=1;view=interpretDesktop(raw);
  const binding={signature:view.candidate.signature,bvid,page:2};
  assert.equal(interpretDesktop(raw,binding).observation.url,'https://www.bilibili.com/video/'+bvid+'/?p=2');
  raw.media.title='另一讲';assert.equal(interpretDesktop(raw,binding).capabilities.identity,false);
  raw.media.title='向量课程';raw.app.processId=2;assert.equal(interpretDesktop(raw,binding).capabilities.identity,false);
  assert.equal(interpretDesktop({...snapshot(),nodes:[{type:'Document',value:'https://www.bilibili.com/video/'+bvid+'/'}]}).capabilities.identity,false);
});

test('任意入口打开的客户端会自动准备接口，只重开一次并等待验证，已就绪时直接读取', async () => {
  const f = m2Fixture();
  try {
    const collector = new Collector(f.db);
    collector.configure({ enabled: true, desktopEnabled: true, autoConfirm: true });
    let raw = { detected: false, errorCode: 'client-not-running' }, launches = 0;
    const desktop = new DesktopCapture(collector, { probe: async () => raw, launch: async (path) => {
      assert.equal(path, snapshot().app.executable); launches++;
    } });
    await desktop.poll();
    assert.equal(launches, 0);
    raw = snapshot(); delete raw.bridgePort;
    await desktop.poll();
    assert.equal(launches, 1);
    assert.equal(desktop.view().state, 'bridge-starting');
    await desktop.poll();
    assert.equal(launches, 1);
    raw = snapshot();
    await desktop.poll();
    assert.deepEqual(desktop.view().identity, { bvid, page: 2 });
    assert.equal(launches, 1);
    raw = snapshot(); delete raw.bridgePort;
    await desktop.poll();
    assert.equal(launches, 2);
  } finally { f.db.close(); }
});

test('准备接口失败会停止重开，用户重新开始才重试，关闭采集后不启动客户端', async () => {
  const f = m2Fixture();
  try {
    const collector = new Collector(f.db);
    collector.configure({ enabled: true, desktopEnabled: true, autoConfirm: true });
    const raw = snapshot(); delete raw.bridgePort;
    let launches = 0;
    const desktop = new DesktopCapture(collector, { probe: async () => raw, launch: async () => { launches++; throw new Error('test launch failure'); } });
    await desktop.poll(); await desktop.poll();
    assert.equal(launches, 1);
    assert.equal(desktop.view().state, 'bridge-start-failed');
    desktop.resetPreparation();
    await desktop.poll();
    assert.equal(launches, 2);
    collector.configure({ enabled: false, desktopEnabled: false });
    await desktop.poll();
    assert.equal(launches, 2);
  } finally { f.db.close(); }
});

test('精确播放器状态优先；读到暂停/后台/锁屏和多课程冲突时不累计，UIA时钟严格解析', () => {
  assert.equal(clockSeconds('01:02:03'),3723);assert.equal(clockSeconds('01:99'),null);
  const raw=snapshot(0);raw.player={hasVideo:true,bvid,page:2,position:100.5,duration:592,rate:2,playing:true,visible:true};
  let result=interpretDesktop(raw);assert.equal(result.observation.position,100.5);assert.equal(result.observation.rate,2);
  raw.player.playing=false;assert.equal(interpretDesktop(raw).observation.playing,false);
  raw.player.playing=true;raw.locked=true;assert.equal(interpretDesktop(raw).observation.idleState,'locked');
  raw.locked=false;raw.app.foreground=false;assert.equal(interpretDesktop(raw).observation.focused,false);
  raw.nodes.push({type:'Document',value:'https://www.bilibili.com/video/BV1QcnP6DEMS/?p=1'});
  result=interpretDesktop(raw);assert.equal(result.state,'ambiguous');assert.equal(result.observation.playing,false);
  const uia=snapshot();uia.nodes.push({type:'Text',name:'01:30 / 09:52'},{type:'Button',name:'暂停'},{type:'Button',name:'1.5倍速'});
  assert.equal(interpretDesktop(uia).observation.position,90);assert.equal(interpretDesktop(uia).observation.rate,1.5);
});

test('网页与客户端互不被后台心跳打断；切来源会收尾，客户端范围沿用现有自动切段且无XP', () => {
  const f=m2Fixture();let now=1700000000000;
  try {
    const c=new Collector(f.db,{now:()=>now});c.configure({enabled:true,allowed:[{bvid,axis:'math'}]});
    const browser={source:'browser',url:'https://www.bilibili.com/video/'+bvid+'/?p=2',title:'向量课程',focused:true,visible:true,playing:true,rate:1,position:0};
    c.observe(browser);
    for(let i=1;i<=7;i++){now+=5000;c.observe({...browser,position:i*5});c.observe({...interpretDesktop(snapshot(i*5)).observation,focused:false,visible:false});}
    assert.equal(c.view().active.seconds,35);
    for(let i=0;i<=7;i++){now+=5000;c.observe(interpretDesktop(snapshot(100+i*5)).observation);c.observe({...browser,focused:false,visible:false});}
    assert.equal(captureJobs(f.db)[0].source,'browser');assert.equal(c.view().active.seconds,35);assert.equal(c.view().active.source,'desktop');
    now+=46000;c.tick();assert.equal(captureJobs(f.db)[0].source,'desktop');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM answers').get().n,3);
    assert.equal(f.db.prepare('SELECT SUM(delta) xp FROM xp_ledger').get().xp,9);
  } finally {f.db.close();}
});

test('CID按元数据准确映射分P并缓存；未知CID不回退P1，关闭期间返回的读取不采集', async () => {
  const f=m2Fixture();let calls=0,position=0,release;
  try {
    const c=new Collector(f.db);c.configure({enabled:true,desktopEnabled:true,allowed:[{bvid,axis:'math'}]});
    const emitted=[];c.observe=(value)=>emitted.push(value);
    const d=new DesktopCapture(c,{probe:async()=>({...snapshot(),nodes:[],player:{hasVideo:true,bvid,cid:78703697,position:position++,duration:592,rate:1,playing:true,visible:true}}),getVideo:async()=>{calls++;return{pages:[{page:2,cid:78703697}]};}});
    await d.poll();await d.poll();assert.equal(calls,1);assert.ok(emitted[0].url.endsWith('?p=2'));
    d.probe=async()=>({...snapshot(),nodes:[],player:{hasVideo:true,bvid,cid:999,position:position++,duration:592,rate:1,playing:true,visible:true}});
    await d.poll();assert.equal(emitted.at(-1).playing,false);assert.equal(d.view().state,'needs-identity');
    d.probe=()=>new Promise(resolve=>{release=resolve;});const pending=d.poll();c.configure({desktopEnabled:false});release(snapshot());await pending;
    assert.equal(emitted.length,3);
  } finally {f.db.close();}
});

test('只读播放器查询执行真实固定脚本，不操作视频；仅访问本机已验证端口及B站目标', async () => {
  const video={currentTime:86.8,duration:592,playbackRate:1,paused:false,ended:false,seeking:false,readyState:4};
  const value=vm.runInNewContext(PLAYER_EXPRESSION,{document:{querySelector:()=>video,title:'向量课程',visibilityState:'hidden'},window:{},location:{href:'https://bilipc.bilibili.com/player.html?bvid='+bvid+'&cid=78703697&page=2',hash:''},URL});
  assert.equal(value.position,86.8);assert.equal(value.cid,'78703697');assert.equal(value.page,'2');assert.equal(video.currentTime,86.8);
  assert.equal(localSocket('ws://evil.test:7790/devtools/page/1',7790),false);
  const visited=[],methods=[];
  const output=await readPlayerBridge(7790,{fetcher:async()=>({ok:true,json:async()=>[
    {type:'page',url:'https://bank.example/',webSocketDebuggerUrl:'ws://127.0.0.1:7790/devtools/page/2'},
    {type:'page',url:'https://bilipc.bilibili.com/player.html',webSocketDebuggerUrl:'ws://evil.test:7790/a'},
    {type:'page',url:'https://bilipc.bilibili.com/player.html',webSocketDebuggerUrl:'ws://127.0.0.1:7790/devtools/page/1'}]}),connect:async(url)=>{visited.push(url);return{request:async(method,params)=>{methods.push(method);assert.equal(params.expression,PLAYER_EXPRESSION);return{result:{value}};},close(){}};}});
  assert.equal(visited.length,1);assert.deepEqual(methods,['Runtime.evaluate']);assert.equal(output.position,86.8);
  assert.equal(await readPlayerBridge(9222),null);
});

test('元数据暂时不可用时使用播放器明确给出的分P，缺失时保持待识别', async () => {
  const f = m2Fixture();
  try {
    const collector = new Collector(f.db);
    collector.configure({ enabled: true, desktopEnabled: true, autoConfirm: true });
    const raw = { ...snapshot(), nodes: [], player: { hasVideo: true, bvid, cid: 78849538, page: '3', position: 100, duration: 599, rate: 1, playing: true, visible: true } };
    const desktop = new DesktopCapture(collector, { probe: async () => raw, getVideo: async () => { throw new Error('offline fixture'); } });
    await desktop.poll();
    assert.deepEqual(desktop.view().identity, { bvid, page: 3 });
    raw.player.page = null;
    await desktop.poll();
    assert.equal(desktop.view().state, 'needs-identity');
  } finally { f.db.close(); }
});

test('多个实际播放器不猜测；子frame读取使用固定脚本和隔离上下文', async () => {
  let calls=0;
  const target={type:'page',url:'https://bilipc.bilibili.com/player.html',webSocketDebuggerUrl:'ws://127.0.0.1:7790/devtools/page/1'};
  const value={hasVideo:true,visible:true,bvid,position:10,duration:592,rate:1,playing:true};
  let mode='frame';
  const dependencies={fetcher:async()=>({ok:true,json:async()=>mode==='multiple'?[target,{...target,webSocketDebuggerUrl:target.webSocketDebuggerUrl+'2'}]:[target]}),connect:async()=>({request:async(method,params)=>{
    if(method==='Page.getFrameTree')return{frameTree:{childFrames:[{frame:{id:'frame',url:'https://www.bilibili.com/player.html'}}]}};
    if(method==='Page.createIsolatedWorld')return{executionContextId:42};
    calls++;return{result:{value:mode==='multiple'||params.contextId===42?value:{hasVideo:false,bvid}}};
  },close(){}})};
  assert.equal((await readPlayerBridge(7790,dependencies)).position,10);assert.equal(calls,2);
  mode='multiple';assert.equal(await readPlayerBridge(7790,dependencies),null);
});

test('总览开始时同时启用双来源，自动识别客户端，结束时关闭；旧采集页状态恢复到总览', async () => {
  const f=m2Fixture();const raw=snapshot();
  const {server,port,desktop,collector}=await startServer({db:f.db,port:0,desktopOptions:{probe:async()=>raw}});
  const storage=new Map([['study.m2.7788.view','capture']]);
  const ui=panelHarness({base:'http://127.0.0.1:'+port,storage});
  try {
    await ui.settle();
    assert.ok(ui.text().includes('学习总览'));
    await ui.click('开始采集');await desktop.poll();await ui.click('刷新');
    assert.equal(collector.settings.desktopEnabled,true);
    assert.equal(collector.view().source,'desktop');
    assert.ok(ui.text().includes('客户端B站'));
    assert.equal(collector.settings.allowed.length,0);
    assert.equal(collector.view().candidate,null);
    await ui.click('结束采集');
    assert.equal(collector.settings.enabled,false);
    assert.equal(collector.settings.desktopEnabled,false);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM answers').get().n,3);
    assert.equal(ui.sent.length,0);
  } finally {ui.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));f.db.close();}
});

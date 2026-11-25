import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Collector, captureJobs, videoIdentity, watchedCues } from '../server/capture/collector.mjs';
import { getCollectorKey } from '../server/capture/key.mjs';
import { m2Fixture } from './m2-fixture.mjs';
import { startServer } from '../server/http/server.mjs';
import { loadContent, createSession } from '../server/core/store.mjs';
import { xpByAxis } from '../server/core/events.mjs';
import { panelHarness } from './panel-harness.mjs';
import { apply } from '../plugin/worker.js';
import { testLesson, testAssessment } from './lesson-fixture.mjs';
import { captureAction, generationQueue, generationState, claimGeneration, finishGeneration, captureReadiness } from '../server/core/capture-controls.mjs';
import { applyEvent } from '../server/core/events.mjs';
import { openDb } from '../server/db/open.mjs';
const bvid = 'BV1ib411t7YR', other = 'BV1QcnP6DEMS';
const sample = { url: 'https://www.bilibili.com/video/'+bvid+'/?p=2&secret=not-stored', title: '线性代数', visible: true, focused: true, playing: true, idleState: 'active', position: 0, rate: 1 };
function rig(db, overrides = {}) {
  let time = 1700000000000, position = 0;
  const collector = new Collector(db, { now: () => time, ...overrides });
  return { collector, now: () => time, advance: (seconds) => { time += seconds*1000; },
    observe: (patch = {}) => collector.observe({ ...sample, position, ...patch }),
    play(seconds, patch = {}) { collector.observe({ ...sample, position, ...patch }); for (let i=0;i<seconds;i+=5) { time+=5000; position+=5*(patch.rate || 1); collector.observe({ ...sample, position, ...patch }); } return collector.view(); } };
}
const enable = (c) => c.configure({ enabled: true, allowed: [{ bvid, axis: 'math' }] });
const subtitle = { ok: true, cues: Array.from({ length: 50 }, (_,i) => ({ from: i*5, to: i*5+4,
  text: i < 15 ? `第${i}处讨论向量的坐标表示，横向与纵向分量分别相加，能说明移动合成的意义。` : `未观看的第${i}处内容不得进入题目。` })) };
const sources = { getVideo: async () => ({ title: '隔离采集课', pages: [{ page: 2 }] }), getSubtitle: async () => subtitle };

test('采集默认关闭且读取不写库；严格识别BV/P，未确认及排除页不留浏览内容', () => {
  const f = m2Fixture();
  try {
    for (const bad of ['http://www.bilibili.com/video/'+bvid, 'https://evil.test/video/'+bvid, 'https://www.bilibili.com.evil.test/video/'+bvid, sample.url.replace('p=2','p=0'), sample.url.replace('p=2','p=1.5')]) assert.equal(videoIdentity(bad), null);
    assert.deepEqual(videoIdentity(sample.url), { bvid, page: 2 });
    const before = f.db.prepare('SELECT COUNT(*) n FROM events').get().n;
    const r = rig(f.db); r.play(60); r.collector.view();
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM events').get().n, before);
    r.collector.configure({ enabled: true });
    r.play(60); assert.equal(r.collector.view().state, 'needs-confirmation');
    assert.equal(r.collector.view().candidate.suggestedSubject, '数学');
    assert.equal(r.collector.view().active, null);
    r.collector.configure({ blocked: [bvid] }); r.observe();
    assert.equal(r.collector.view().candidate, null);
    assert.equal(r.collector.view().state, 'blocked');
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE payload_json LIKE '%not-stored%' OR payload_json LIKE '%线性代数%'").get().n, 0);
    assert.throws(() => r.collector.configure({ segmentSeconds: 1 }));
    assert.throws(() => r.collector.configure({ allowed: [{ bvid: 'bad', axis: 'math' }] }));
  } finally { f.db.close(); }
});

test('暂停/后台/锁屏/卡顿不计入，连续播放允许输入空闲；拖动跳过内容不补算，观看不发XP', () => {
  const f = m2Fixture();
  try {
    const r = rig(f.db); enable(r.collector); const xp = xpByAxis(f.db);
    r.play(35, { idleState: 'idle' }); assert.equal(r.collector.view().active.seconds, 35);
    for (const patch of [{ playing: false }, { focused: false }, { visible: false }, { idleState: 'locked' }]) {
      r.advance(5); r.observe(patch); assert.equal(r.collector.view().active.seconds,35);
    }
    r.observe({ position: 200 }); r.advance(5); r.observe({ position: 205 });
    assert.deepEqual(r.collector.view().active.ranges, [[0,35],[200,205]]);
    r.advance(5); r.observe({ position: 205 }); assert.equal(r.collector.view().active.seconds,40);
    r.advance(5); r.observe({ position: 800 });
    assert.equal(captureJobs(f.db).length,1); assert.deepEqual(captureJobs(f.db)[0].ranges, [[0,35],[200,205]]);
    assert.deepEqual(xpByAxis(f.db),xp); assert.equal(f.db.prepare('SELECT COUNT(*) n FROM answers').get().n,3);
    r.collector.configure({ titleBlocklist: ['忽略'] }); r.observe({ title: '忽略这门课' }); assert.equal(r.collector.view().state,'blocked');
  } finally { f.db.close(); }
});

test('满8分钟、离开45秒、换P及播放结束自动切段；短段跳过、倍速不多计时间', () => {
  const f = m2Fixture();
  try {
    const r = rig(f.db); enable(r.collector);
    r.play(480,{ rate: 2 }); assert.equal(captureJobs(f.db)[0].seconds,480);
    assert.deepEqual(captureJobs(f.db)[0].ranges,[[0,960]]);
    r.play(35); r.observe({ playing: false }); r.advance(46); r.collector.tick();
    assert.equal(captureJobs(f.db)[0].reason,'away');
    r.play(35); r.observe({ url: sample.url.replace('p=2','p=3') });
    assert.equal(captureJobs(f.db)[0].reason,'course-changed');
    r.play(35); r.observe({ playing: false, ended: true });
    assert.equal(captureJobs(f.db)[0].reason,'video-ended');
    const count = captureJobs(f.db).length; r.play(10); r.collector.close('test-short');
    assert.equal(captureJobs(f.db).length,count);
  } finally { f.db.close(); }
});

test('重启检查点自动收尾，离线时间不计入，恢复与重复关闭不重复创建片段', () => {
  const f = m2Fixture();
  try {
    const r = rig(f.db); enable(r.collector); r.play(60);
    const before = f.db.prepare('SELECT COUNT(*) n FROM events').get().n;
    const restored = new Collector(f.db,{ now: () => r.now()+60000 });
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM events').get().n,before);
    restored.tick(); restored.tick(); restored.close('repeat');
    assert.equal(captureJobs(f.db).length,1);
    assert.ok(captureJobs(f.db)[0].seconds <= 60);
    const again = new Collector(f.db); assert.equal(again.active,null);
  } finally { f.db.close(); }
});

test('字幕只取完整经过范围的句子；落库幂等、质量闸保留，失败不拿整讲补齐且可重试', async () => {
  const f = m2Fixture(); let calls = 0;
  try {
    const r = rig(f.db,{ ...sources, getSubtitle: async () => { calls++; return subtitle; } }); enable(r.collector); r.play(60); r.observe({ playing: false, ended: true });
    const job = captureJobs(f.db)[0];
    await Promise.all([r.collector.prepare(job.jobId), r.collector.prepare(job.jobId)]);
    await r.collector.prepare(job.jobId); assert.equal(calls,1);
    const done = captureJobs(f.db)[0], content = loadContent(f.db,done.sessionId);
    assert.equal(done.stage,'prepared'); assert.equal(done.cueCount,12);
    assert.ok(content.text.includes('第0处')); assert.ok(!content.text.includes('第12处')); assert.ok(!content.text.includes('未观看'));
    const source = JSON.parse(f.db.prepare('SELECT quality_json FROM sources WHERE id=(SELECT source_id FROM sessions WHERE id=?)').get(done.sessionId).quality_json);
    assert.equal(source.segments[0].verdict,'ok');
    assert.deepEqual(watchedCues([{from:0,to:6},{from:5,to:9},{from:9,to:11}],[[5,10]]),[{from:5,to:9}]);
    r.play(35); r.observe({ playing:false,ended:true }); const next = captureJobs(f.db)[0];
    r.collector.getSubtitle = async () => { throw new Error('secret must not be logged'); };
    await r.collector.prepare(next.jobId); await r.collector.drain();
    assert.equal(captureJobs(f.db)[0].stage,'failed');
    assert.ok(!JSON.stringify(r.collector.view()).includes('secret must'));
    r.collector.getSubtitle = async () => subtitle;
    await r.collector.prepare(next.jobId,true); assert.equal(captureJobs(f.db)[0].stage,'prepared');
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM answers').get().n,3);
  } finally { f.db.close(); }
});

test('总览三个按钮完成自动采集、收尾和隔离出题排队，网页无需手动确认课程', async () => {
  const f = m2Fixture(); let now = 1700000000000;
  const { server, port, collector } = await startServer({ db:f.db,port:0,collectorOptions:{ now:()=>now,...sources } });
  const base = `http://127.0.0.1:${port}`; const key = getCollectorKey(f.db,true);
  const storage = new Map([['study.m2.validation','true']]); const ui = panelHarness({ base,storage });
  try {
    assert.equal((await fetch(base+'/collector/observe',{method:'POST',body:'{}'})).status,401);
    assert.equal((await fetch(base+'/collector/observe',{method:'POST',headers:{authorization:'Bearer wrong'},body:'{}'})).status,401);
    await ui.settle();
    assert.equal(ui.all((n) => n.type === 'button' && ui.text(n) === '出题').length, 0);
    assert.equal((await fetch(base + '/panel/capture/questions', { method: 'POST', body: '{}' })).status, 400);
    assert.equal(ui.all((n) => n.props.role === 'tab' && ui.text(n) === '采集').length, 0);
    await ui.click('开始采集');
    assert.equal(collector.settings.desktopEnabled, true);
    assert.equal(collector.settings.autoConfirm, true);
    for (let i=0;i<=12;i++) {
      now+=5000;
      const response = await fetch(base+'/collector/observe',{method:'POST',headers:{authorization:'Bearer '+key},body:JSON.stringify({...sample,position:i*5,ended:i===12})});
      assert.equal(response.status,200);
    }
    await collector.drain(); await ui.click('刷新');
    assert.ok(ui.text().includes('网页端B站'));
    assert.equal(ui.all((n) => n.type === 'button' && ui.text(n) === '出题').length, 0);
    assert.equal((await fetch(base + '/panel/capture/questions', { method: 'POST', body: '{}' })).status, 400);
    await ui.click('结束采集');
    assert.equal(collector.view().config.enabled, false);
    assert.equal(collector.view().config.desktopEnabled, false);
    await ui.click('出题');
    assert.ok(ui.text().includes('等待DSH接单'));
    assert.equal(ui.sent.length, 0);
    const pending = await (await fetch(base + '/panel/generation/queue')).json();
    assert.equal(pending.items.length, 1);
    assert.equal(pending.items[0].sessionId, captureJobs(f.db)[0].sessionId);
    await fetch(base + '/panel/capture/questions', { method: 'POST', body: '{}' });
    assert.equal((await (await fetch(base + '/panel/generation/queue')).json()).items.length, 1);
    assert.ok(!JSON.stringify(collector.view()).includes(key));
    assert.equal(ui.calls.some((c) => c.url.includes('/cards') || c.url.includes('/grade')), false);
  } finally { ui.dispose(); server.closeAllConnections(); await new Promise((r)=>server.close(r)); f.db.close(); }
});

test('点击出题后，宿主自动处理队列并写入题目，重复请求复用结果', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = m2Fixture();
  const lecture = f.db.prepare('SELECT text FROM contents WHERE session_id=?').get(f.sessionId).text;
  let now = 1700000000000, modelCalls = 0, preparedText;
  const { server, port, collector } = await startServer({ db: f.db, port: 0, collectorOptions: { now: () => now,
    getVideo: sources.getVideo, getSubtitle: async () => ({ ok: true, cues: [{ from: 0, to: 60, text: lecture }] }) } });
  const previousBase = process.env.STUDY_SERVICE_URL;
  process.env.STUDY_SERVICE_URL = 'http://127.0.0.1:' + port;
  let cleanup, lastReport;
  apply({ get() { throw new Error('web service is not injected'); },
    effect(fn) { const effect = fn(); if (typeof effect === 'function') { t.after(effect); return; } effect.next(); cleanup = () => effect.return(); },
    tools: { register(tool) { if (tool.name === 'study_generate_cards') { const execute = tool.execute; tool.execute = async (...args) => { lastReport = await execute(...args); return lastReport; }; } } }, llm: { stream({ system }) {
      modelCalls++;
      const result = system.startsWith('先为整讲') ? testLesson(preparedText) : { cards: testAssessment(f.sample.cards).map((card) => ({
        ...card, targetId: 'vector-core', quote: preparedText.slice(0, 60),
      })) };
      return (async function* () { yield { type: 'text-delta', text: JSON.stringify(result) }; })();
    } } });
  try {
    await captureAction(f.db, collector, 'start');
    for (let i = 0; i <= 12; i++) { now += 5000; collector.observe({ ...sample, position: i * 5 }); }
    await captureAction(f.db, collector, 'stop');
    const target = await captureAction(f.db, collector, 'questions');
    preparedText = f.db.prepare('SELECT text FROM segments WHERE session_id=? ORDER BY seq').all(target.sessionId).map((r) => r.text).join('\n');
    t.mock.timers.tick(30000);
    for (let i = 0; i < 200 && ['queued', 'processing'].includes(generationState(f.db)?.state); i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(generationState(f.db).state, 'completed', JSON.stringify(lastReport));
    assert.equal(generationQueue(f.db).length, 0);
    assert.ok(f.db.prepare('SELECT COUNT(*) n FROM cards k JOIN segments g ON g.id=k.segment_id WHERE g.session_id=? AND k.discarded=0').get(target.sessionId).n > 0);
    assert.equal(modelCalls, 2);
    assert.equal((await captureAction(f.db, collector, 'questions')).hasQuestions, true);
    t.mock.timers.tick(30000);
    assert.equal(generationQueue(f.db).length, 0);
    assert.equal(modelCalls, 2);
  } finally {
    cleanup?.(); server.closeAllConnections(); await new Promise((r) => server.close(r)); f.db.close();
    if (previousBase === undefined) delete process.env.STUDY_SERVICE_URL; else process.env.STUDY_SERVICE_URL = previousBase;
  }
});

test('旧排队任务及中断的执行任务会超时，关库重开后仍可恢复，领取与完成均幂等', () => {
  const f = m2Fixture();
  let db = f.db;
  try {
    const sessionId = createSession(db, { courseId: f.course.id });
    applyEvent(db, { type: 'generation.requested', payload: { id: 'stale', sessionId }, at: Date.now() - 600000 });
    assert.equal(generationState(db).state, 'failed');
    assert.equal(generationQueue(db).length, 0);
    assert.equal(claimGeneration(db, 'stale').claimed, false);
    db.close(); db = openDb(f.file).db;
    assert.equal(generationState(db).state, 'failed');
    applyEvent(db, { type: 'generation.requested', payload: { id: 'retry', sessionId } });
    assert.equal(generationState(db).state, 'queued');
    const claim = claimGeneration(db, 'retry');
    assert.equal(claim.claimed, true);
    assert.equal(claimGeneration(db, 'retry').claimed, false);
    assert.equal(generationState(db).state, 'processing');
    assert.equal(generationQueue(db).length, 0);
    assert.throws(() => finishGeneration(db, 'retry', false, 'wrong-token'));
    finishGeneration(db, 'retry', true, claim.token);
    assert.equal(finishGeneration(db, 'retry', false, claim.token).failed, true);
    applyEvent(db, { type: 'generation.requested', payload: { id: 'interrupted', sessionId }, at: Date.now() - 250000 });
    applyEvent(db, { type: 'generation.claimed', payload: { id: 'interrupted', token: 'late' }, at: Date.now() - 245000 });
    assert.equal(generationState(db).state, 'failed');
    assert.throws(() => finishGeneration(db, 'interrupted', false, 'late'), /过期/);
  } finally { db.close(); }
});

test('新一轮空采集不能借用旧片段，结束后出题权限持久保存，过期任务可重新提交', async () => {
  const f = m2Fixture();
  try {
    const r = rig(f.db, sources);
    await captureAction(f.db, r.collector, 'start');
    assert.equal(captureReadiness(f.db, r.collector).canGenerate, false);
    r.play(60);
    await assert.rejects(captureAction(f.db, r.collector, 'questions'), /先结束采集/);
    await captureAction(f.db, r.collector, 'stop');
    assert.equal(captureReadiness(f.db, r.collector).canGenerate, true);
    await captureAction(f.db, r.collector, 'questions');
    const first = generationState(f.db).id;
    f.db.prepare("UPDATE events SET created_at=? WHERE type='generation.requested'").run(Date.now() - 600000);
    await captureAction(f.db, r.collector, 'questions');
    assert.notEqual(generationState(f.db).id, first);
    const restored = new Collector(f.db, sources);
    assert.equal(captureReadiness(f.db, restored).canGenerate, true);
    f.db.prepare("UPDATE events SET created_at=? WHERE type='generation.requested'").run(Date.now() - 600000);
    assert.equal(generationState(f.db).state, 'failed');
    await captureAction(f.db, r.collector, 'start');
    assert.equal(generationState(f.db), null);
    await captureAction(f.db, r.collector, 'stop');
    assert.equal(generationState(f.db), null);
    assert.equal(captureReadiness(f.db, r.collector).canGenerate, false);
    await assert.rejects(captureAction(f.db, r.collector, 'questions'), /至少积累30秒/);
  } finally { f.db.close(); }
});

test('同一视频超过8分钟时汇总本轮总时长，所有技术切段合成一份可复用的出题字幕', async () => {
  const f = m2Fixture();
  try {
    const r = rig(f.db, { ...sources, getSubtitle: async () => ({ ok: true, cues: Array.from({ length: 125 }, (_, i) => ({
      from: i * 5, to: i * 5 + 4, text: '第' + i + '处讨论线性组合与空间的基，向量相加与数乘用来描述能够到达的位置及其几何意义。',
    })) }) });
    await captureAction(f.db, r.collector, 'start');
    r.play(575);
    await captureAction(f.db, r.collector, 'stop');
    const ready = captureReadiness(f.db, r.collector);
    assert.equal(ready.seconds, 575);
    assert.equal(ready.segments, 2);
    assert.equal(ready.jobIds.length, 2);
    const result = await captureAction(f.db, r.collector, 'questions');
    const content = loadContent(f.db, result.sessionId);
    assert.ok(content.text.includes('第1处'));
    assert.ok(content.text.includes('第110处'));
    for (const segment of f.db.prepare('SELECT * FROM segments WHERE session_id=?').all(result.sessionId)) {
      assert.equal(content.text.slice(segment.span_start, segment.span_end), segment.text);
    }
    assert.equal((await captureAction(f.db, r.collector, 'questions')).sessionId, result.sessionId);
    assert.equal(generationQueue(f.db).length, 1);
  } finally { f.db.close(); }
});

test('浏览器桥保留 B 站前台校验，ChatGPT 需用户选中且仅报告选定前台对话', async () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../browser-extension/manifest.json',import.meta.url)));
  assert.deepEqual(manifest.permissions,['storage','idle','activeTab','scripting']);
  assert.ok(!JSON.stringify(manifest.host_permissions).includes('chatgpt.com'));
  assert.ok(!JSON.stringify(manifest).includes('<all_urls>'));
  let click,active=true,locked=false,url=sample.url,binding,start;
  const handlers=[],requests=[];
  const chrome={action:{onClicked:{addListener(fn){click=fn;}},setBadgeText(){},setTitle(){}},runtime:{onMessage:{addListener(fn){handlers.push(fn);}}},
    storage:{local:{get:async()=>({enabled:true,token:'a'.repeat(64),port:7789}),set:async()=>{}},
      session:{get:async()=>({studyChatBinding:binding}),set:async value=>{binding=value.studyChatBinding;}}},
    tabs:{get:async()=>({url,active,windowId:1,title:'Fixture conversation'}),sendMessage:async(id,message)=>{start=message;}},
    scripting:{executeScript:async()=>{}},windows:{get:async()=>({focused:true})},idle:{queryState:async()=>locked?'locked':'idle'} };
  const readScript=name=>fs.readFileSync(new URL('../browser-extension/'+name,import.meta.url),'utf8');
  const context=vm.createContext({chrome,URL,AbortSignal,crypto:{randomUUID:()=> 'fixture-binding'},importScripts:name=>vm.runInContext(readScript(name),context),
    fetch:async(target,options)=>{const body=options.body?JSON.parse(options.body):null;requests.push({target,body});return{ok:true,json:async()=>target.endsWith('/chatgpt')?(body?{accepted:true}:{enabled:true,runId:'fixture-run'}):{state:'paused'}};}});
  vm.runInContext(readScript('background.js'),context);
  const handler=handlers.at(-1);
  const send = (id=1) => new Promise((resolve)=>handler({type:'study-observe',observation:sample},{tab:{id},frameId:0},resolve));
  await send(); assert.equal(requests[0].body.focused,true); assert.ok(requests[0].target.includes(':7789/')); assert.ok(!requests[0].body.url.includes('secret'));
  active=false;await send(2);assert.equal(requests.length,1); // 其他后台课不打断前台课。
  await send();assert.equal(requests[1].body.focused,false); // 当前课离开时发送一次暂停。
  active=true;locked=true;await send();assert.equal(requests[2].body.idleState,'locked');
  url='https://bank.example/';await send();assert.equal(requests.length,3);
  assert.equal(handler({type:'study-observe'},{tab:{id:1},frameId:1},()=>{}),undefined);

  locked=false;url='https://chatgpt.com/c/fixture-chat';
  const sendChat=(id=1)=>new Promise(resolve=>handlers[0]({...start,type:'study-chat-frame',messages:[]},{tab:{id},frameId:0},resolve));
  assert.equal((await sendChat()).state,'inactive');
  await click({id:1,url});assert.equal(start.type,'study-chat-start');assert.equal(requests.at(-1).body.action,'bind');
  assert.equal((await sendChat(2)).state,'inactive');
  active=false;assert.equal((await sendChat()).state,'paused');
  active=true;url='https://chatgpt.com/c/other-chat';assert.equal((await sendChat()).state,'paused');
  url='https://chatgpt.com/c/fixture-chat';assert.equal((await sendChat()).accepted,true);
  assert.equal(requests.at(-1).body.conversationId,'fixture-chat');
});

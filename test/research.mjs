import test from 'node:test';
import assert from 'node:assert/strict';
import { m2Fixture } from './m2-fixture.mjs';
import { startServer } from '../server/http/server.mjs';
import { researchInput, saveResearch, researchView, researchQueue, researchFailure, confirmResearch, requestResearch } from '../server/core/research.mjs';
import { buildResearch, researchErrorMessage,chatgptUsageNotice } from '../plugin/research.js';
import { saveModelSettings } from '../server/core/model-settings.mjs';
import { studyProgress } from '../server/core/progress.mjs';
import { applyEvent } from '../server/core/events.mjs';
import { apply } from '../plugin/worker.js';
import { panelHarness } from './panel-harness.mjs';
import { FOUNDATION_VERSION } from '../plugin/foundations.js';
import {certifyFixture} from './foundation-fixture.mjs';
import { subjectPresentationStatus } from '../server/core/subject-presentation.mjs';
import { validatePresentation } from '../plugin/subject-presentation.js';

const page = 'Vectors have coordinates. Linear combinations use vector addition and scalar multiplication. Projections are used in data analysis to reduce dimensions. This teaching fixture describes the prerequisite relation and its application.';
const presentation = {
  title: '波前观测室',
  stages: [
    { label: '记下刻度', line: '观测室的尺已经摆好，水面仍在漆黑里安静地等着。第一处振动落下以后，来过这里的波便能在记录中找到自己出发的位置。' },
    { label: '第一道波前', line: '振动沿介质一道道传来，观测窗依次照亮同相的几处。你第一次从这些位置认出一条波前，远处的暗处也有了可以追踪的边界。' },
    { label: '顺波写式', line: '你把一份波形的解释递进观测室，记录员在每个符号旁写下它所来自的刻度。尚未相合的几笔留在页边，等候下一次测量。' },
    { label: '测值相合', line: '一道结果通过了核验，纸上的曲线终于与所测的起伏相遇。波的去处已经可寻，记录中还有一小段空白留给视野以外的水面。\n——起伏有来路，刻度记其名。' },
    { label: '隔日复测', line: '日后再开观测窗，昔日的波纹仍能沿着旧题里的条件逐一重现。等窗口重新暗下去，留在卷中的关系依旧有自己的来处。' },
  ],
};
test('本次先修循环最多纠正一次，不重搜、不改已有图；纠正失败不返回可保存结果',async()=>{
  const f=m2Fixture();try{
    const input=researchInput(f.db,f.sessionId);
    for(const repaired of [true,false]){
      let calls=0,searches=0;
      const task=buildResearch(input,{model:async(system,user)=>{
        calls++;if(calls===1)return JSON.stringify({subject:'物理',confidence:.95,queries:['fixture']});
        const result=graph(input);result.edges=[{...result.edges[0],kind:'prerequisite'},{...result.edges[0],from:'b',to:'a',kind:'suggested-prerequisite'}];
        if(calls===3){assert.ok(JSON.parse(user).errors.some(e=>e.code==='prerequisite-cycle'));if(repaired)result.edges.pop();}
        return JSON.stringify(result);
      },web:{search:async()=>{searches++;return {sources:[{url:'https://ocw.mit.edu/fixture'}]};},fetch:async({url})=>({url,statusCode:200,body:{kind:'text',content:page}})}});
      if(repaired){const result=await task;assert.equal(result.edges.length,1);saveResearch(f.db,f.sessionId,result);}
      else await assert.rejects(task,/纠正后仍存在循环/);
      assert.equal(calls,3);assert.equal(searches,1);
    }
    assert.equal(f.db.prepare("SELECT count(*) n FROM events WHERE type='research.completed'").get().n,1);
  }finally{f.db.close();}
});

test('本地图无环但合并全局形成间接循环时，按规范化学科和名称在保存前纠正',async()=>{
  const f=m2Fixture();try{
    const input=researchInput(f.db,f.sessionId),globalGraph={nodes:[{id:'global-a',subject:'物理',title:'向量'},{id:'global-b',subject:'math',title:'降维'},{id:'bridge',subject:'math',title:'桥接概念'}],edges:[{from:'global-a',to:'bridge',kind:'prerequisite'},{from:'bridge',to:'global-b',kind:'suggested-prerequisite'}]};
    const original=JSON.stringify(globalGraph);let calls=0;
    const result=await buildResearch({...input,globalGraph},{model:async(system,user)=>{
      calls++;if(calls===1)return JSON.stringify({subject:'物理',confidence:.95,queries:['fixture']});
      const result=graph(input);result.nodes[1].subject='数学';result.edges=[{...result.edges[0],from:'b',to:'a',kind:calls===3?'connection':'prerequisite'}];
      if(calls===3){const error=JSON.parse(user).errors.find(e=>e.code==='prerequisite-cycle');assert.ok(error.path.some(n=>n.title==='桥接概念'));}
      return JSON.stringify(result);
    },web:{search:async()=>({sources:[{url:'https://ocw.mit.edu/fixture'}]}),fetch:async({url})=>({url,statusCode:200,body:{kind:'text',content:page}})}});
    assert.equal(calls,3);assert.equal(result.edges[0].kind,'connection');assert.equal(JSON.stringify(globalGraph),original);
  }finally{f.db.close();}
});

test('旧失败保留原始记录并附课程时间，界面折叠呈现；重试只排课程概览',async()=>{
  const f=m2Fixture();const input=researchInput(f.db,f.sessionId),raw='基础规划失败：model call aborted';
  applyEvent(f.db,{type:'research.failed',payload:{sessionId:f.sessionId,key:input.key,version:'course-map-v2',message:raw}});
  const {server,port}=await startServer({db:f.db,port:0}),ui=panelHarness({base:'http://127.0.0.1:'+port});
  try{
    const failure=researchView(f.db).failures[0];assert.equal(failure.legacyFoundation,true);assert.equal(failure.code,'model-aborted');assert.equal(failure.courseTitle,input.title);assert.ok(Number.isFinite(failure.at));
    await ui.settle();const details=ui.all(n=>n.type==='details'&&n.props['aria-label']==='知识导航未完成记录')[0];assert.ok(details);assert.ok(!details.props.open);assert.match(ui.text(details),/旧版完整基础补全/);assert.match(ui.text(details),/模型调用已中止/);assert.ok(!ui.text(details).includes('model call aborted'));
    await ui.click('重试知识导航');assert.equal(researchQueue(f.db,false).length,1);assert.equal(researchView(f.db).failures.length,0);
    assert.equal(JSON.parse(f.db.prepare("SELECT payload_json FROM events WHERE type='research.failed'").get().payload_json).message,raw);
    const execution=await(await fetch('http://127.0.0.1:'+port+'/panel/research/'+f.sessionId)).json();assert.ok(execution.globalGraph);assert.equal(execution.checkpoint,null);
    assert.match(researchErrorMessage(new Error('service /panel/research/x -> 400 {"error":"先修关系存在循环"}'),{provider:'fixture',model:'fixture'}),/本次结果未保存/);
  }finally{ui.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));f.db.close();}
});

test('订阅共享限额不推断总额度耗尽或重置时间；暂时不可用与DeepSeek余额错误分开',()=>{
  const message='The ChatGPT user has reached their Subscription Sharing usage limit. This account has no ChatGPT plan allowance left for app inference right now, or an app-specific limit applies';
  const text=researchErrorMessage(new Error(message),{provider:'chatgpt',model:'fixture'});assert.match(text,/可能是总用量或该应用的周限额/);assert.match(text,/不能据此判断/);assert.ok(!/明天|小时后|DeepSeek/.test(text));
  assert.equal(chatgptUsageNotice('subscription_sharing_usage_limit_exceeded'),text);assert.equal(chatgptUsageNotice('HTTP 429 too many requests'),null);
  assert.equal(chatgptUsageNotice(text),text);
  const unavailable=researchErrorMessage(new Error('subscription_sharing_usage_unavailable'),{provider:'chatgpt',model:'fixture'});assert.match(unavailable,/不等于额度已用尽/);
});
test('已保存的共享额度失败能正确显示，打开面板和读取队列不会自动重新消费',()=>{
  const f=m2Fixture();try{const input=researchInput(f.db,f.sessionId);requestResearch(f.db,f.sessionId);researchFailure(f.db,f.sessionId,input.key,'The ChatGPT user has reached their Subscription Sharing usage limit.');
    const view=researchView(f.db);assert.equal(view.failures[0].code,'chatgpt-sharing-limit');assert.match(view.failures[0].message,/应用的周限额/);assert.equal(view.failures[0].usageUrl,'https://chatgpt.com/settings/usage');assert.equal(researchQueue(f.db,false).length,0);
    assert.match(JSON.parse(f.db.prepare("SELECT payload_json FROM events WHERE type='research.failed' ORDER BY rowid DESC LIMIT 1").get().payload_json).message,/Subscription Sharing/);
  }finally{f.db.close();}
});
test('GPT归类成功后的搜索402标为搜索额度，不误报GPT额度且不继续建图', async () => {
  const f = m2Fixture(); let calls = 0;
  try {
    const input = researchInput(f.db, f.sessionId);
    let failure;
    try {
      await buildResearch(input, {
        model: async () => { calls++; return JSON.stringify({ subject: 'math', confidence: .99, queries: ['fixture'] }); },
        web: { search: async () => { throw new Error('DeepSeek API error (HTTP 402): Insufficient Balance'); }, fetch: async () => { throw new Error('must not fetch'); } },
      });
    } catch (error) { failure = error; }
    assert.equal(calls, 1);
    assert.equal(failure.researchStage, 'search');
    assert.match(researchErrorMessage(failure, { provider: 'chatgpt', model: 'fixture' }), /DeepSeek搜索服务余额不足/);
    assert.match(researchErrorMessage(new Error('Insufficient Balance'), { provider: 'chatgpt', model: 'fixture' }), /chatgpt \/ fixture/);
  } finally { f.db.close(); }
});
function graph(input, confidence = 0.95) {
  const support = [{ sourceId: 's1', quote: 'Vectors have coordinates.' }];
  return { key: input.key, subject: '物理', confidence, reason: '依据课程对几何箭头与坐标的讨论', sources: [
    { id: 's1', url: 'https://ocw.mit.edu/test-fixture', title: '测试教材', publisher: 'MIT', authority: '大学站点', content: page, fetchedAt: new Date().toISOString() }],
    nodes: [{ id: 'a', subject: '物理', title: '向量', description: '测试概念', courseQuote: input.text.slice(0, 30), support, foundationRoot:true, foundationReason:'本测试将向量定义作为入门边界' },
      { id: 'b', subject: '数据分析', title: '降维', description: '测试应用', support }],
    edges: [{ from: 'a', to: 'b', kind: 'application', reason: '投影用于降维（测试关系）', support }] };
}
test('原生模型与联网接口贯通，内容归类、引用、跨学科三维图及重复复用', async () => {
  const f = m2Fixture();
  const { server, port } = await startServer({ db: f.db, port: 0 });
  const base = 'http://127.0.0.1:' + port, previous = process.env.STUDY_SERVICE_URL;
  process.env.STUDY_SERVICE_URL = base;
  const defs = [], input = researchInput(f.db, f.sessionId);
  let models = 0, searches = 0, fetches = 0;
  saveModelSettings(f.db, { tasks: { navigation: { provider: 'chatgpt', model: 'fixture-gpt' } }, autoResearch: false });
  apply({ tools: { register: (d) => defs.push(d) }, effect() {},
    web: { async search() { searches++; return { sources: [{ url: 'https://ocw.mit.edu/test-fixture', title: '测试教材' }] }; },
      async fetch() { fetches++; return { url: 'https://ocw.mit.edu/test-fixture', statusCode: 200, body: { kind: 'text', content: page } }; } },
    llm: { stream({ system, provider, model }) { assert.equal(provider, 'chatgpt'); assert.equal(model, 'fixture-gpt'); models++; const value = system.startsWith('根据已看') ?
      { subject: '物理', confidence: 0.95, reason: '字幕讨论几何箭头与坐标', queries: ['测试课程大纲'], presentation } : system.startsWith('你负责')?certifyFixture(graph(input)).foundationPlan:system.startsWith('你是基础')?certifyFixture(graph(input)).foundationAudit:certifyFixture(graph(input));
      return (async function* () { yield { type: 'text-delta', text: JSON.stringify(value) }; })(); } } });
  const ui = panelHarness({ base });
  try {
    const tool = defs.find((d) => d.name === 'study_research_course');
    assert.equal((await tool.execute({ sessionId: f.sessionId }, {})).cached, false);
    assert.equal((await tool.execute({ sessionId: f.sessionId }, {})).cached, true);
    assert.deepEqual([models, searches, fetches], [2, 1, 1]);
    assert.equal(studyProgress(f.db)[0].axis, '物理');
    const map = researchView(f.db, '物理');
    assert.equal(map.nodes.length, 2);
    assert.equal(map.nodes.find((n) => n.subject === '数据分析').status, 'unseen');
    assert.equal(studyProgress(f.db).some((s) => s.axis === '数据分析'), false);
    await ui.settle();
    assert.ok(ui.text().includes(presentation.title));
    assert.ok(ui.text().includes('请 AI 更新文案'));
    ui.all((n) => n.props['aria-label'] === '查看物理知识树')[0].props.onClick();
    await ui.settle();
    assert.equal(ui.all((n)=>n.props['data-subject-root']==='数据分析').length,0);
    await ui.click('全部学科 · 同图');
    assert.ok(ui.text().includes('投影用于降维'));
    assert.equal(ui.all((n) => n.props['aria-label'] === '三维知识科技树').length, 1);
    assert.ok(ui.all((n) => n.type === 'a').some((n) => n.props.href === 'https://ocw.mit.edu/test-fixture'));
  } finally {
    ui.dispose(); server.closeAllConnections(); await new Promise((r) => server.close(r)); f.db.close();
    if (previous === undefined) delete process.env.STUDY_SERVICE_URL; else process.env.STUDY_SERVICE_URL = previous;
  }
});
test('已有学科可从总览使用配置模型起名，失败时保留上次文案', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = m2Fixture(), cleanup = [], calls = [];
  const { server, port } = await startServer({ db: f.db, port: 0 });
  const base = 'http://127.0.0.1:' + port, previous = process.env.STUDY_SERVICE_URL;
  process.env.STUDY_SERVICE_URL = base;
  saveModelSettings(f.db, { tasks: { navigation: { provider: 'chatgpt', model: 'fixture-naming' } }, autoResearch: false });
  const ui = panelHarness({ base });
  const waitFor = async state => {
    for (let i = 0; i < 200; i++) {
      if (subjectPresentationStatus(f.db).get('math')?.state === state) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('起名任务没有进入 ' + state);
  };
  try {
    await ui.settle();
    assert.ok(ui.text().includes('无穷宪章'));
    await ui.click('请 AI 起名');
    assert.ok(ui.text().includes('等待起名…'));
    const custom = { ...presentation, title: '几何推演室' };
    const oldCopy = { ...custom, stages: custom.stages.map(stage => ({ ...stage, line: stage.line.slice(0, 30) })) };
    assert.deepEqual(validatePresentation(oldCopy), oldCopy);
    assert.equal(validatePresentation(oldCopy, { newCopy: true }), null);
    apply({ tools: { register() {} }, effect(fn) { cleanup.push(fn()); }, llm: { async *stream(args) {
      calls.push(args);
      yield { type: 'text-delta', text: JSON.stringify(calls.length === 1 ? custom : oldCopy) };
    } } });
    t.mock.timers.tick(30000);
    await waitFor('completed');
    ui.tickPolls();
    await ui.settle();
    assert.ok(ui.text().includes(custom.title));
    assert.deepEqual([calls[0].provider, calls[0].model, JSON.parse(calls[0].messages[0].content[0].text).subject], ['chatgpt', 'fixture-naming', '数学']);
    await ui.click('请 AI 更新文案');
    t.mock.timers.tick(30000);
    await waitFor('failed');
    ui.tickPolls();
    await ui.settle();
    assert.ok(ui.text().includes(custom.title));
    assert.ok(ui.text().includes('文案格式不完整'));
    assert.equal(calls.length, 2);
    assert.equal(studyProgress(f.db)[0].courses[0].title, f.course.title);
  } finally {
    cleanup.forEach(fn => fn());
    ui.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.db.close();
    if (previous === undefined) delete process.env.STUDY_SERVICE_URL; else process.env.STUDY_SERVICE_URL = previous;
  }
});
test('未知新学科保存AI大类，提要节点继承其大类，跨学科节点单独归区',()=>{
  const f=m2Fixture();try{
    const input=researchInput(f.db,f.sessionId),data=graph(input);data.subject='新的交叉研究方向';data.area='engineering';
    data.nodes[0].subject=data.subject;data.nodes[1].subject='心理学';data.nodes[1].area='formal';
    const saved=saveResearch(f.db,f.sessionId,data);assert.equal(saved.area,'engineering');
    const view=researchView(f.db);assert.ok(view.nodes.filter(n=>n.subject===data.subject).every(n=>n.area==='engineering'));
    assert.equal(view.nodes.find(n=>n.subject==='心理学').area,'social');
  }finally{f.db.close();}
});

test('错误引用、循环先修与重复概念均拒绝，失败不写归属和结果', () => {
  const f = m2Fixture();
  try {
    const input = researchInput(f.db, f.sessionId), data = graph(input);
    data.nodes[0].support[0].quote = '来源没有的句子';
    assert.throws(() => saveResearch(f.db, f.sessionId, data), /无法核对/);
    const cycle = graph(input);
    cycle.edges = [{ ...cycle.edges[0], kind: 'prerequisite' }, { ...cycle.edges[0], from: 'b', to: 'a', kind: 'prerequisite' }];
    assert.throws(() => saveResearch(f.db, f.sessionId, cycle), /循环/);
    const duplicate = graph(input); duplicate.nodes.push({ ...duplicate.nodes[0], id: 'c' });
    assert.throws(() => saveResearch(f.db, f.sessionId, duplicate), /重复/);
    assert.equal(researchView(f.db).nodes.length, 0);
    assert.equal(studyProgress(f.db)[0].axis, 'math');
  } finally { f.db.close(); }
});
test('归属不确定需确认，已看状态有原文且跨学科节点不创建学习面板', () => {
  const f = m2Fixture();
  try {
    const result = saveResearch(f.db, f.sessionId, graph(researchInput(f.db, f.sessionId), 0.6));
    assert.equal(researchView(f.db).pending.length, 1);
    assert.equal(studyProgress(f.db)[0].axis, 'math');
    confirmResearch(f.db, result.key);
    assert.equal(studyProgress(f.db)[0].axis, '物理');
    assert.equal(researchView(f.db).pending.length, 0);
    assert.equal(researchInput(f.db, f.sessionId).maps[0].key, result.key);
    assert.equal(researchView(f.db).nodes[0].status, 'encountered');
  } finally { f.db.close(); }
});

test('显式试用任务不依赖正式自动队列，失败后可重试，完成后复用结果', () => {
  const f = m2Fixture();
  try {
    assert.equal(researchQueue(f.db, false).length, 0);
    requestResearch(f.db, f.sessionId); requestResearch(f.db, f.sessionId);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM events WHERE type='research.requested'").get().n, 1);
    assert.equal(researchQueue(f.db, false).length, 1);
    const input = researchInput(f.db, f.sessionId);
    researchFailure(f.db, f.sessionId, input.key);
    assert.equal(researchQueue(f.db, false).length, 0);
    assert.equal(researchView(f.db).failures.length, 1);
    requestResearch(f.db, f.sessionId);
    assert.equal(researchQueue(f.db, false).length, 1);
    assert.equal(researchView(f.db).failures.length, 0);
    assert.equal(researchView(f.db).queued[0].sessionId, f.sessionId);
    saveResearch(f.db, f.sessionId, graph(input));
    assert.equal(requestResearch(f.db, f.sessionId).cached, true);
  } finally { f.db.close(); }
});

test('分别检索教材和应用，交错选取来源并去除同页锚点重复', async () => {
  const f = m2Fixture();
  const fetched = [];
  try {
    const input = researchInput(f.db, f.sessionId);
    await buildResearch(input, {
      model: async (system) => JSON.stringify(system.startsWith('根据已看') ? {
        subject: '物理', confidence: 0.95, reason: 'fixture', queries: ['textbook', 'application'],
      } : graph(input)),
      web: {
        search: async ({ query }) => ({ sources: query === 'textbook'
          ? [{ url: 'https://ocw.mit.edu/textbook#one' }, { url: 'https://ocw.mit.edu/textbook#two' }, { url: 'https://ocw.mit.edu/other' }]
          : [{ url: 'https://www.stanford.edu/application' }] }),
        fetch: async ({ url }) => { fetched.push(url); return { url, statusCode: 200, body: { kind: 'text', content: page } }; },
      },
    });
    assert.deepEqual(fetched, ['https://ocw.mit.edu/textbook', 'https://www.stanford.edu/application', 'https://ocw.mit.edu/other']);
  } finally { f.db.close(); }
});

test('引文不匹配只用原资料修正一次，仍不匹配则拒绝', async () => {
  const f = m2Fixture();
  try {
    const input = researchInput(f.db, f.sessionId);
    for (const repair of [true, false]) {
      let calls = 0, searches = 0;
      const task = buildResearch(input, {
        model: async (system, user) => {
          calls++;
          if (system.startsWith('根据已看')) return JSON.stringify({ subject: '物理', confidence: .95, queries: ['fixture'] });
          const data = graph(input);
          if (calls === 2 || !repair) data.nodes[0].support = [{ sourceId: 's1', quote: '改写过的引文' }];
          if (calls === 3) assert.ok(JSON.parse(user).errors.some((e) => e.quote === '改写过的引文'));
          return JSON.stringify(data);
        },
        web: { search: async () => { searches++; return { sources: [{ url: 'https://ocw.mit.edu/fixture' }] }; },
          fetch: async ({ url }) => ({ url, statusCode: 200, body: { kind: 'text', content: page } }) },
      });
      if (repair) assert.equal((await task).nodes[0].support[0].quote, 'Vectors have coordinates.');
      else await assert.rejects(task, /修正后仍无法核对/);
      assert.deepEqual([calls, searches], [3, 1]);
    }
  } finally { f.db.close(); }
});

test('分别成立的先修图合并后也不允许出现循环', () => {
  const f = m2Fixture();
  try {
    const first = graph(researchInput(f.db, f.sessionId));
    first.edges[0].kind = 'prerequisite';
    saveResearch(f.db, f.sessionId, first);
    f.db.prepare('UPDATE contents SET text=text || ? WHERE session_id=?').run('新的已看内容', f.sessionId);
    const next = graph(researchInput(f.db, f.sessionId));
    next.edges[0] = { ...next.edges[0], kind: 'prerequisite', from: 'b', to: 'a' };
    assert.throws(() => saveResearch(f.db, f.sessionId, next), /循环/);
  } finally { f.db.close(); }
});
test('只自动处理真实采集，失败暂停重试，原样内容复用且新内容仍入队', () => {
  const f = m2Fixture();
  try {
    assert.equal(researchQueue(f.db).length, 0);
    applyEvent(f.db, { type: 'capture.imported', payload: { sessionId: f.sessionId } });
    assert.equal(researchQueue(f.db).length, 1);
    const input = researchInput(f.db, f.sessionId);
    researchFailure(f.db, f.sessionId, input.key);
    assert.equal(researchQueue(f.db).length, 0);
    saveResearch(f.db, f.sessionId, graph(input));
    assert.equal(researchView(f.db).failures.length, 0);
    assert.equal(researchQueue(f.db).length, 0);
    f.db.prepare('UPDATE contents SET text=text || ? WHERE session_id=?').run('新的内容', f.sessionId);
    assert.equal(researchQueue(f.db).length, 1);
  } finally { f.db.close(); }
});

test('一条检索失败仍使用另一条真实权威来源；全部失败时保留真实错误', async () => {
  const f = m2Fixture();
  try {
    const input = researchInput(f.db, f.sessionId);
    for (const allFailed of [false, true]) {
      let searches = 0, models = 0;
      const run = buildResearch(input, {
        model: async system => { models++; return JSON.stringify(system.startsWith('根据已看') ? { subject: '物理', confidence: .95, queries: ['empty', 'works'] } : graph(input)); },
        web: { search: async ({ query }) => { searches++; if (query === 'empty' || allFailed) throw new Error('原生搜索无可用结果'); return { sources: [{ url: 'https://ocw.mit.edu/fixture' }] }; },
          fetch: async ({ url }) => ({ url, statusCode: 200, body: { kind: 'text', content: page } }) },
      });
      if (allFailed) { await assert.rejects(run, /原生搜索无可用结果/); assert.equal(models, 1); }
      else { const result = await run; assert.equal(result.sources.length, 1); assert.equal(models, 2); }
      assert.equal(searches, 2);
    }
  } finally { f.db.close(); }
});

test('显式权威来源直接读取；已有图缓存保留，不再因旧版全图升级失败重新排队',async()=>{
  const f=m2Fixture();try{
    const input={...researchInput(f.db,f.sessionId),sourceHints:['https://ocw.mit.edu/fixture']};let searches=0;
    const result=await buildResearch(input,{model:async system=>JSON.stringify(system.startsWith('根据已看')?{subject:'物理',confidence:.95,queries:['fixture']}:graph(input)),web:{search:async()=>{searches++;throw new Error('must not search');},fetch:async({url})=>({url,statusCode:200,body:{kind:'text',content:page}})}});
    assert.equal(searches,0);assert.equal(result.sources.length,1);
    saveResearch(f.db,f.sessionId,graph(input));researchFailure(f.db,f.sessionId,input.key,'缺少前置链');
    assert.equal(researchView(f.db).failures.length,0);
    assert.equal(requestResearch(f.db,f.sessionId,{foundations:true,sourceHints:input.sourceHints}).cached,true);assert.equal(researchQueue(f.db,false).length,0);
    saveResearch(f.db,f.sessionId,certifyFixture(graph(input)));assert.equal(researchView(f.db).failures.length,0);
  }finally{f.db.close();}
});

test('正式与试用执行器均按各自设置读取自动队列，试用真实采集能自动完成归类建图', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const formal = m2Fixture(), trial = m2Fixture(), cleanups = [], seen = [];
  saveModelSettings(trial.db, { tasks: { navigation: { provider: 'fixture', model: 'trial-navigation' } }, autoResearch: true });
  applyEvent(trial.db, { type: 'capture.imported', payload: { sessionId: trial.sessionId } });
  const input = researchInput(trial.db, trial.sessionId);
  const a = await startServer({ db: formal.db, port: 0 }), b = await startServer({ db: trial.db, port: 0 });
  const originalFetch = globalThis.fetch, previous = process.env.STUDY_SERVICE_URL;
  process.env.STUDY_SERVICE_URL = 'http://127.0.0.1:7788';
  t.mock.method(globalThis, 'fetch', (url, options) => {
    seen.push(String(url));
    const routed = String(url).replace('http://127.0.0.1:7788', 'http://127.0.0.1:' + a.port).replace('http://127.0.0.1:7789', 'http://127.0.0.1:' + b.port);
    return originalFetch(routed, options);
  });
  const calls = [];
  try {
    apply({ tools: { register() {} }, effect(fn) { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); },
      get: () => ({ search: async () => ({ sources: [{ url: 'https://ocw.mit.edu/fixture' }] }), fetch: async ({ url }) => ({ url, statusCode: 200, body: { kind: 'text', content: page } }) }),
      llm: { stream(args) { calls.push(args); return (async function* () { yield { type: 'text-delta', text: JSON.stringify(args.system.startsWith('根据已看') ? { subject: '物理', confidence: .95,reason:'Synthetic classification', queries: ['fixture'] } : args.system.startsWith('你负责')?certifyFixture(graph(input)).foundationPlan:args.system.startsWith('你是基础')?certifyFixture(graph(input)).foundationAudit:certifyFixture(graph(input))) }; })(); } },
    });
    t.mock.timers.tick(30000);
    for (let i = 0; i < 300 && !researchView(trial.db).nodes.length; i++) await new Promise(r => setTimeout(r, 5));
    assert.ok(researchView(trial.db).nodes.length > 0);
    assert.equal(researchView(formal.db).nodes.length, 0);
    assert.equal(calls.length, 2); assert.ok(calls.every(c => c.provider === 'fixture' && c.model === 'trial-navigation'));
    for (const port of [7788, 7789]) assert.ok(seen.includes('http://127.0.0.1:' + port + '/panel/research/queue?automatic=true'));
  } finally {
    cleanups.forEach(fn => fn());
    for (const item of [a, b]) { item.server.closeAllConnections(); await new Promise(r => item.server.close(r)); }
    formal.db.close(); trial.db.close();
    if (previous === undefined) delete process.env.STUDY_SERVICE_URL; else process.env.STUDY_SERVICE_URL = previous;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db/open.mjs';
import { workspaceView, sessionView, startReview, answerFromPanel, finishFromPanel, cardHistory } from '../server/core/workspace.mjs';
import { createSession, recordAnswer, upsertCourse } from '../server/core/store.mjs';
import { saveDialogueGrade } from '../server/core/dialogue.mjs';
import { auditDb } from '../server/core/audit.mjs';
import { startServer } from '../server/http/server.mjs';
import { m2Fixture } from './m2-fixture.mjs';
import { panelHarness } from './panel-harness.mjs';
import { applyEvent } from '../server/core/events.mjs';

test('没有学习记录时，总览与知识树均不预设学科', async () => {
  const { db } = openDb(':memory:');
  const { server, port } = await startServer({ db, port: 0 });
  const ui = panelHarness({ base: `http://127.0.0.1:${port}` });
  try {
    assert.deepEqual(workspaceView(db).progress, []);
    await ui.settle();
    assert.ok(ui.text().includes('等待第一段学习信号'));
    assert.equal(ui.all((node) => node.props['aria-label'] === '学科进度滑轨').length, 0);
    await ui.click('知识树');
    assert.ok(ui.text().includes('等待第一棵知识树'));
  } finally { ui.dispose(); server.closeAllConnections(); await new Promise((r) => server.close(r)); db.close(); }
});

test('总览合并重复观看区间，显示未出题片段，并跳转到对应学科树', async () => {
  const f = m2Fixture();
  const lecture = { bvid: 'BV1ib411t7YR', page: 2, axis: '古代史', title: '古代史讲义' };
  const course = upsertCourse(f.db, { platform: 'bilibili', externalId: lecture.bvid, title: lecture.title, axis: lecture.axis });
  const sessionId = createSession(f.db, { courseId: course.id });
  applyEvent(f.db, { type: 'capture.queued', payload: { ...lecture, ranges: [[10, 50]] } });
  applyEvent(f.db, { type: 'capture.skipped', payload: { ...lecture, ranges: [[35, 61]] } });
  applyEvent(f.db, { type: 'capture.imported', payload: { ...lecture, sessionId, partTitle: '史料入门' } });
  applyEvent(f.db, { type: 'lesson.summarized', payload: { sessionId, summary: { coreIdeas: [{ title: '史料互证', meaning: '将独立来源相互对读' }] } } });
  upsertCourse(f.db, { platform: 'fixture', externalId: 'unwatched', title: '仅导入的课程', axis: 'language' });
  const progress = workspaceView(f.db).progress;
  const history = progress.find((item) => item.axis === '古代史');
  assert.equal(history.watched, 51);
  assert.equal(history.stage, 1);
  assert.equal(progress.some((item) => item.axis === 'language'), false);
  const { server, port } = await startServer({ db: f.db, port: 0, collectorOptions: { getVideo: async () => { throw new Error('fixture'); } } });
  const ui = panelHarness({ base: `http://127.0.0.1:${port}` });
  try {
    await ui.settle();
    assert.equal(ui.all((node) => node.props.role === 'tab' && node.props['aria-selected'])[0].children[0], '总览');
    assert.ok(ui.text().includes('灰烬纪年'));
    assert.ok(ui.text().includes('纸背余烬'));
    assert.ok(ui.all(node => node.props.className === 'study-atlas-epigraph')
      .some(node => ui.text(node) === '——纸已发黄，落笔时的处境仍有余温。'));
    const rail = ui.all((node) => node.props['aria-label'] === '学科进度滑轨')[0];
    const classes = new Set();
    const element = rail.props.ref.current;
    const cards = [0, 600].map((offsetLeft) => ({ offsetLeft }));
    Object.assign(element, { scrollLeft: 0, clientWidth: 600, scrollWidth: 1200, children: cards, firstElementChild: cards[0],
      scrollTo({ left }) { this.scrollLeft = left; },
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } });
    const pointer = { pointerType: 'mouse', button: 0, pointerId: 1, clientX: 300, currentTarget: element, preventDefault() {} };
    rail.props.onPointerDown(pointer);
    rail.props.onPointerMove({ ...pointer, clientX: 296 });
    assert.equal(element.scrollLeft, 0);
    rail.props.onPointerMove({ ...pointer, clientX: 150 });
    assert.equal(element.scrollLeft, 150);
    assert.ok(classes.has('is-dragging'));
    rail.props.onPointerUp({ ...pointer, type: 'pointerup', clientX: 150 });
    assert.equal(classes.size, 0);
    assert.equal(element.scrollLeft, 600);
    let clickSuppressed = false;
    const click = { detail: 1, preventDefault() { clickSuppressed = true; }, stopPropagation() {} };
    rail.props.onClickCapture(click);
    assert.equal(clickSuppressed, true);
    clickSuppressed = false;
    rail.props.onPointerDown(pointer);
    rail.props.onPointerUp(pointer);
    rail.props.onClickCapture(click);
    assert.equal(clickSuppressed, false);
    ui.all((node) => node.props['aria-label'] === '查看古代史知识树')[0].props.onClick();
    await ui.settle();
    assert.ok(ui.text().includes('古代史 · 知识树'));
    assert.ok(ui.text().includes('P2 · 史料入门'));
    assert.ok(ui.text().includes('史料互证'));
    await ui.click('总览');
    ui.all((node) => node.props['aria-label'] === '查看数学知识树')[0].props.onClick();
    await ui.settle();
    assert.equal(ui.all((node) => node.props['aria-label'] === '三维知识科技树').length, 1);
    assert.equal(ui.all((node) => node.props['aria-label'] === '当前课程')[0].props.value, f.course.id);
  } finally { ui.dispose(); server.closeAllConnections(); await new Promise((r) => server.close(r)); f.db.close(); }
});

test('持久化复习快照：重复开始复用，作答幂等，关库重开恢复；结束后按新到期取题', () => {
  const f = m2Fixture(); let db = f.db;
  try {
    const run = startReview(db); assert.equal(run.session.total, 3);
    assert.equal(startReview(db).session.id, run.session.id);
    assert.equal(JSON.stringify(run.session).includes('correctAnswer'), false);
    assert.throws(() => finishFromPanel(db, run.session.id));
    const before = workspaceView(db).xp.math;
    const cardId = run.session.cards[0].id, correct = db.prepare('SELECT answer FROM cards WHERE id=?').get(cardId).answer;
    answerFromPanel(db, run.session.id, { cardId, raw: correct });
    answerFromPanel(db, run.session.id, { cardId, raw: 'D' });
    assert.equal(workspaceView(db).xp.math, before + 15);
    assert.equal(workspaceView(db).progress.find((item) => item.axis === 'math').reviewed, 1);
    db.close(); db = openDb(f.file).db;
    const resumed = startReview(db); assert.equal(resumed.session.id, run.session.id); assert.equal(resumed.session.answered, 1);
    for (const card of resumed.session.cards.filter((c) => !c.answer)) answerFromPanel(db, run.session.id, { cardId: card.id, raw: db.prepare('SELECT answer FROM cards WHERE id=?').get(card.id).answer });
    const xp = workspaceView(db).xp.math; finishFromPanel(db, run.session.id); finishFromPanel(db, run.session.id);
    assert.equal(workspaceView(db).xp.math, xp); assert.equal(startReview(db).session, null);
    assert.ok(workspaceView(db, Date.now() + 8 * 86400000).due.length > 0);
    assert.ok(auditDb(db).ok);
  } finally { db.close(); }
});

test('拒绝跨会话/停用/无效答案；停用题从快照移除且可结束；不改原学习成绩', () => {
  const f = m2Fixture();
  try {
    const run = startReview(f.db).session;
    assert.throws(() => answerFromPanel(f.db, run.id, { cardId: f.cards[3], raw: '未在队列中' }));
    assert.throws(() => answerFromPanel(f.db, run.id, { cardId: f.cards[0], raw: 'Q' }));
    assert.throws(() => answerFromPanel(f.db, run.id, { cardId: f.cards[0], raw: '' }));
    for (const card of run.cards) f.db.prepare('UPDATE cards SET discarded=1,discard_reason=? WHERE id=?').run('fixture-stop', card.id);
    assert.throws(() => answerFromPanel(f.db, run.id, { cardId: f.cards[0], raw: 'A' }));
    assert.equal(sessionView(f.db, run.id).complete, true); finishFromPanel(f.db, run.id);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM answers WHERE session_id=?').get(f.sessionId).n, 3);
  } finally { f.db.close(); }
});

test('主观题状态、补答历史、错题与经验统计：待补充不算错题，正式失败才进入错题', () => {
  const f = m2Fixture();
  try {
    const first = answerFromPanel(f.db, f.sessionId, { cardId: f.cards[3], raw: '只说明横向' });
    const a = first.cards.find((c) => c.id === f.cards[3]).answer;
    const judgment = { assessment: 'partial', hit: [], recognized: '知道横向合成', gap: '纵向如何处理', followup: '纵向怎样确定位置？', note: '补充同一个关系', by: 'model:stub', turn: 0 };
    saveDialogueGrade(f.db, a.id, judgment);
    const state = sessionView(f.db, f.sessionId);
    assert.equal(state.pending, 1); assert.equal(state.cards.find((c) => c.id === f.cards[3]).answer.status, 'awaiting-followup');
    assert.equal(workspaceView(f.db).wrong.some((c) => c.id === f.cards[3]), false);
    const s = createSession(f.db, { courseId: f.course.id });
    const wrong = recordAnswer(f.db, { cardId: f.cards[3], sessionId: s, raw: '两个方向混着相加' });
    saveDialogueGrade(f.db, wrong.answerId, { ...judgment, assessment: 'incorrect' });
    assert.equal(sessionView(f.db, s).cards.length, 1);
    assert.equal(sessionView(f.db, s).legacyReview, true);
    assert.ok(workspaceView(f.db).wrong.some((c) => c.id === f.cards[3]));
    assert.equal(cardHistory(f.db, f.cards[3]).attempts.length, 2);
    assert.equal(workspaceView(f.db).days.length, 7);
    const other = upsertCourse(f.db, { platform: 'fixture', externalId: 'empty', title: '空课', axis: 'other' });
    assert.equal(startReview(f.db, other.id).session, null);
    assert.throws(() => startReview(f.db, 'unknown-course'));
  } finally { f.db.close(); }
});

test('HTTP队列与答案白名单；历史损坏记录可见且不泄露主观参考答案/评分点', async () => {
  const f = m2Fixture(); const { server, port } = await startServer({ db: f.db, port: 0 });
  const base = `http://127.0.0.1:${port}`;
  try {
    const run = await (await fetch(base + '/panel/review/start', { method: 'POST', body: '{}' })).json();
    const invalid = await fetch(`${base}/panel/sessions/${run.session.id}/answer`, { method: 'POST', body: JSON.stringify({ cardId: f.cards[3], raw: '越界' }) });
    assert.equal(invalid.status, 400);
    const raw = await (await fetch(base + '/panel/sessions/' + f.sessionId)).text();
    assert.ok(!raw.includes(f.sample.cards[3].answer)); assert.ok(!raw.includes('rubric'));
    const a = recordAnswer(f.db, { sessionId: f.sessionId, cardId: f.cards[3], raw: '历史记录' });
    // 保留旧坏记录，不把它变成程序通过或当作错题。
    f.db.prepare("UPDATE cards SET prompt_version='legacy' WHERE id=?").run(f.cards[3]);
    f.db.prepare("UPDATE answers SET graded_by='model:legacy',rubric_json='broken' WHERE id=?").run(a.answerId);
    const history = await (await fetch(base + `/panel/cards/${f.cards[3]}/history`)).json();
    assert.equal(history.attempts[0].status, 'audit-required');
    assert.equal((await fetch(base + '/panel/workspace')).status, 200);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); f.db.close(); }
});

test('面板真实回调+HTTP：点选提交、查看反馈、关闭重开进度、错题历史与经验页', async () => {
  const f = m2Fixture(); const { server, port } = await startServer({ db: f.db, port: 0 });
  const base = `http://127.0.0.1:${port}`; let ui = panelHarness({ base });
  try {
    await ui.settle(); await ui.click('开始 / 继续到期复习');
    const radio = ui.all((n) => n.type === 'input' && n.props.value === 'A')[0];
    radio.props.onChange(); await ui.settle(); await ui.click('提交回答');
    assert.ok(ui.text().includes('正确选项：'));
    const storage = ui.storage; ui.dispose(); ui = panelHarness({ base, storage }); await ui.settle();
    assert.ok(ui.text().includes('已作答 1/3'));
    await ui.click('上一题');
    assert.equal(ui.all((n) => n.type === 'input' && n.props.value === 'A')[0].props.disabled, true);
    await ui.click('错题'); await ui.click('答案与历史');
    assert.ok(ui.text().includes('原答：')); await ui.click('关闭历史');
    await ui.click('记录'); assert.ok(ui.text().includes('经验与近7天记录'));
  } finally { ui.dispose(); server.closeAllConnections(); await new Promise((r) => server.close(r)); f.db.close(); }
});

test('主观草稿失败后保留，提交后自动排队判卷，面板不再跳转DSH对话', async () => {
  const f = m2Fixture(); const { server, port } = await startServer({ db: f.db, port: 0 });
  const base = `http://127.0.0.1:${port}`; let ui = panelHarness({ base, failPost: true });
  try {
    await ui.settle(); await ui.click('学习');
    const area = ui.all((n) => n.type === 'textarea' && n.props['aria-label'] === '你的解释')[0];
    area.props.onChange({ target: { value: '我自己的解释，失败不能丢' } }); await ui.settle(); await ui.click('提交回答');
    assert.ok(ui.text().includes('模拟断网'));
    const storage = ui.storage; ui.dispose(); ui = panelHarness({ base, storage }); await ui.settle();
    assert.equal(ui.all((n) => n.type === 'textarea')[0].props.value, '我自己的解释，失败不能丢');
    await ui.click('提交回答');
    assert.ok(ui.text().includes('等待后台自动判卷'));
    assert.equal(ui.sent.length, 0);
    const pendingAnswer = sessionView(f.db, f.sessionId).cards.find((card) => card.kind === 'subjective').answer;
    assert.equal(pendingAnswer.grading.state, 'queued');
    assert.equal(ui.all((n) => n.type === 'button' && ui.text(n).includes('DSH对话')).length, 0);
    assert.equal(ui.calls.some((c) => c.url?.includes('/subjective/') && c.url.endsWith('/grade')), false);
  } finally { ui.dispose(); server.closeAllConnections(); await new Promise((r) => server.close(r)); f.db.close(); }
});

test('课程入口自动接续学习，复习单独恢复；切课程持久化且不串题，旧记录仍可打开', async () => {
  const f = m2Fixture(); const review = startReview(f.db).session;
  const empty = upsertCourse(f.db, { platform: 'fixture', externalId: 'empty-panel', title: '另一门课（尚无题目）', axis: 'math' });
  const { server, port } = await startServer({ db: f.db, port: 0 });
  const base = `http://127.0.0.1:${port}`;
  const storage = new Map([['study.m2.7788.session', review.id]]);
  let ui = panelHarness({ base, storage });
  const courseSelect = () => ui.all((n) => n.type === 'select' && n.props['aria-label'] === '当前课程')[0];
  try {
    await ui.settle(); await ui.click('学习');
    assert.equal(ui.all((n) => n.props['aria-label'] === '选择学习会话').length, 0);
    assert.equal(ui.storage.get('study.m2.7788.session'), f.sessionId);
    assert.ok(ui.text().includes('已作答 3/4'));
    assert.equal(ui.tree.props.style.maxWidth, undefined);
    assert.equal(ui.all((n) => n.props['aria-label'] === '当前课程进度').length, 1);
    await ui.click('复习');
    assert.equal(ui.storage.get('study.m2.7788.session'), review.id);
    assert.ok(ui.text().includes('已作答 0/3'));
    await ui.click('学习');
    assert.equal(ui.storage.get('study.m2.7788.session'), f.sessionId);
    courseSelect().props.onChange({ target: { value: empty.id } }); await ui.settle();
    assert.ok(ui.text().includes('这门课还没有题目'));
    assert.equal(ui.all((n) => n.type === 'textarea').length, 0);
    ui.dispose(); ui = panelHarness({ base, storage }); await ui.settle();
    assert.equal(courseSelect().props.value, empty.id);
    courseSelect().props.onChange({ target: { value: f.course.id } }); await ui.settle();
    await ui.click('记录'); await ui.click('查看 / 继续');
    assert.equal(ui.all((n) => n.props.role === 'tab' && n.props['aria-selected'])[0].children[0], '复习');
    assert.ok(ui.text().includes('从记录打开'));
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM answers').get().n, 3);
    assert.equal(ui.sent.length, 0);
  } finally { ui.dispose(); server.closeAllConnections(); await new Promise((r) => server.close(r)); f.db.close(); }
});

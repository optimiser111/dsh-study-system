// M1 验收断言 A1–A9。用独立的临时库跑，输出逐条 PASS/FAIL。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db/open.mjs';
import { buildContent, addSegments, attachContent, createSession, upsertCourse, saveSource, materializeForSession, recordAnswer, settle, dueCards, rates, pendingSubjective, applyModelGrade } from '../server/core/store.mjs';
import { isSpanValid } from '../server/core/span.mjs';
import { gradeObjective, gradeSubjective } from '../server/cards/grade.mjs';
import { rebuildLedger, xpByAxis, applyEvent } from '../server/core/events.mjs';
import { loadTextParts } from '../server/sources/fixture.mjs';
import { assessSubtitles } from '../server/sources/bilibili.mjs';
import { parseModelOutput, parseGradeOutput, segmentGate, normalizeGradeResult } from '../plugin/generate-core.js';
import { log, logFile } from '../server/core/log.mjs';
import { startServer } from '../server/http/server.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'fixtures');
const DAY = 86_400_000;

const results = [];
async function check(id, name, fn) {
  try {
    const detail = await fn();
    results.push({ id, name, pass: true, detail });
    console.log(`PASS  ${id}  ${name}${detail ? `  (${detail})` : ''}`);
  } catch (e) {
    results.push({ id, name, pass: false, detail: e.message });
    console.log(`FAIL  ${id}  ${name}  -> ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function mustThrow(fn, msg) {
  try {
    fn();
  } catch {
    return true;
  }
  throw new Error(msg);
}

function freshDb(tag) {
  const dir = path.join(ROOT, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `test-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.db`);
  return { ...openDb(file), file };
}

function ingest(db, fixtureName, axis = 'math') {
  const course = upsertCourse(db, { platform: 'fixture', externalId: fixtureName, title: fixtureName, axis });
  const sourceId = saveSource(db, { courseId: course.id, kind: 'pdf', status: 'ok' });
  const sessionId = createSession(db, { courseId: course.id, sourceId });
  const content = buildContent({
    sessionId,
    sourceKind: 'pdf',
    parts: loadTextParts(path.join(FIXTURES, fixtureName)),
  });
  attachContent(db, sessionId, content);
  const segments = addSegments(db, sessionId, content);
  return { sessionId, courseId: course.id, content, segments };
}

// ---------------------------------------------------------------- A1
await check('A1', 'lecture-01 → ≥3 题且 span 全部命中原文', () => {
  const { db } = freshDb('a1');
  const { sessionId, content } = ingest(db, 'lecture-01.txt');
  const payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cards-lecture-01.json'), 'utf8'));
  const result = materializeForSession(db, {
    sessionId,
    content,
    rawCards: payload.cards,
    model: payload.model,
    promptVersion: payload.promptVersion,
  });
  assert(result.kept.length >= 3, `only ${result.kept.length} cards kept`);
  assert(result.discarded.length === 1, `expected exactly 1 discarded (hallucinated), got ${result.discarded.length}`);
  assert(result.discarded[0].reason === 'span-not-found', `discard reason ${result.discarded[0].reason}`);

  const kept = db.prepare('SELECT * FROM cards WHERE segment_id IN (SELECT id FROM segments WHERE session_id = ?) AND discarded = 0').all(sessionId);
  for (const card of kept) {
    const ok = isSpanValid(
      { spanText: card.span_text, spanStart: card.span_start, spanEnd: card.span_end },
      content,
    );
    assert(ok, `span invalid on card ${card.id}`);
  }
  const r = rates(db, sessionId);
  return `kept=${result.kept.length} discarded=${result.discarded.length} discardRate=${r.discardRate}`;
});

// ---------------------------------------------------------------- A2
await check('A2', '自动弃权：判定函数返回 abstain（单元）+ 服务落痕（集成）', () => {
  // 单元：出题层的判定，不靠测试自己下结论
  assert(parseModelOutput('{"abstain":"这段是闲聊，信息不足以出题"}').abstain.includes('闲聊'), 'abstain not parsed');
  mustThrow(() => parseModelOutput('这里没有任何 JSON'), 'unparseable output must throw');
  mustThrow(() => parseModelOutput('{"cards":[]}'), 'empty cards must throw (no default fill)');
  const gate = segmentGate({ verdict: 'degenerate', chars: 900, cards: 0 });
  assert(gate.abstain && gate.reason === 'subtitle-quality:degenerate', 'quality gate did not abstain');
  const already = segmentGate({ verdict: 'ok', chars: 900, cards: 3 });
  assert(already.abstain && already.reason === 'already-generated', 'generated segment should be skipped');

  // 集成：服务端 /abstain 落痕，比率能算出来（只验管道，不冒充"模型真的弃权了"）
  const { db } = freshDb('a2');
  const { sessionId, content } = ingest(db, 'lecture-chat.txt');
  const result = materializeForSession(db, {
    sessionId,
    content,
    rawCards: [],
    model: 'deepseek-flash',
    promptVersion: 'm1-cards-v1',
  });
  assert(result.kept.length === 0, 'expected 0 cards');
  applyEvent(db, {
    type: 'abstained',
    payload: { sessionId, reason: '这段是闲聊，信息不足以出题' },
    dedupeKey: `abstain:${sessionId}`,
  });
  const r = rates(db, sessionId);
  assert(r.abstainRate > 0, 'abstain rate should be > 0');
  const payload = JSON.parse(db.prepare("SELECT payload_json FROM events WHERE type = 'abstained'").get().payload_json);
  assert(/闲聊/.test(payload.reason), 'abstained.reason missing');
  return `unit=ok plumbing=ok abstainRate=${r.abstainRate}`;
});

// ---------------------------------------------------------------- A3
await check('A3', '客观题判分确定性（同一答案 100 次结果一致）', () => {
  const card = { kind: 'objective', answer: 'A', options_json: JSON.stringify(['空间中的箭头', '有序数字列表']) };
  const first = gradeObjective(card, 'A');
  for (let i = 0; i < 100; i++) assert(gradeObjective(card, 'A') === first, 'non-deterministic grade');
  assert(first === true, 'expected correct');
  assert(gradeObjective(card, 'B') === false, 'expected wrong for B');
  assert(gradeObjective(card, '空间中的箭头') === true, 'expected option-text match');
  return '100/100 identical';
});

// ---------------------------------------------------------------- A4 / A7
await check('A4', '3 对 1 错 → 4 条 answers；重放一致；重复提交不重复发奖；隔日复习才算复习', () => {
  const { db } = freshDb('a4');
  const { sessionId, courseId, content } = ingest(db, 'lecture-01.txt');
  const payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cards-lecture-01.json'), 'utf8'));
  const { kept } = materializeForSession(db, {
    sessionId,
    content,
    rawCards: payload.cards.filter((c) => c.kind === 'objective'),
    model: payload.model,
    promptVersion: payload.promptVersion,
  });
  assert(kept.length >= 4, `need 4 objective cards, got ${kept.length}`);

  const cards = db.prepare('SELECT * FROM cards WHERE discarded = 0 ORDER BY created_at').all();
  const answers = [
    cards[0].answer, // 对
    cards[1].answer, // 对
    cards[2].answer, // 对
    'Z', // 错
  ];
  for (let i = 0; i < 4; i++) recordAnswer(db, { cardId: cards[i].id, sessionId, raw: answers[i] });

  const answerCount = db.prepare('SELECT COUNT(*) AS n FROM answers').get().n;
  assert(Number(answerCount) === 4, `expected 4 answers, got ${answerCount}`);

  const xp1 = xpByAxis(db);
  assert(Object.values(xp1).some((v) => v > 0), 'xp did not increase');

  const ledger1 = db.prepare('SELECT axis, delta, reason, event_id FROM xp_ledger ORDER BY event_id').all();
  rebuildLedger(db);
  const ledger2 = db.prepare('SELECT axis, delta, reason, event_id FROM xp_ledger ORDER BY event_id').all();
  assert(JSON.stringify(ledger1) === JSON.stringify(ledger2), 'ledger differs after replay');
  const xp2 = xpByAxis(db);
  assert(JSON.stringify(xp1) === JSON.stringify(xp2), 'xp differs after replay');

  // A7：同一 session 重复结算 → xp 不变
  settle(db, sessionId);
  const xpAfterFirst = xpByAxis(db);
  settle(db, sessionId);
  const xpAfterSecond = xpByAxis(db);
  assert(JSON.stringify(xpAfterFirst) === JSON.stringify(xpAfterSecond), 'xp changed on repeat settle');

  // 重复提交（1 秒后重试同一题）：不新增作答、不重复发奖、不重新调度
  const answersBefore = Number(db.prepare('SELECT COUNT(*) AS n FROM answers').get().n);
  const repsBefore = db.prepare('SELECT reps FROM reviews WHERE card_id = ?').get(cards[0].id).reps;
  const dup = recordAnswer(db, { cardId: cards[0].id, sessionId, raw: cards[0].answer, now: Date.now() + 1000 });
  assert(dup.duplicate === true, 'repeat answer was not treated as duplicate');
  assert(Number(db.prepare('SELECT COUNT(*) AS n FROM answers').get().n) === answersBefore, 'duplicate wrote another answer');
  assert(db.prepare('SELECT reps FROM reviews WHERE card_id = ?').get(cards[0].id).reps === repsBefore, 'duplicate rescheduled');
  assert(JSON.stringify(xpByAxis(db)) === JSON.stringify(xpAfterSecond), 'duplicate granted xp');

  // 合法隔日复习：新学习段 + 距上次 ≥ 1 天 → +15
  const session2 = createSession(db, { courseId });
  const reviewNow = Date.now() + 25 * 3600 * 1000;
  const r2 = recordAnswer(db, { cardId: cards[0].id, sessionId: session2, raw: cards[0].answer, now: reviewNow });
  assert(r2.reviewed === true, 'next-day answer was not treated as review');
  const xpAfterReview = xpByAxis(db);
  assert(xpAfterReview.math === xpAfterSecond.math + 15, `review should add 15, got ${xpAfterReview.math - xpAfterSecond.math}`);

  // 不足间隔（1 小时）：不能领复习奖励
  const session3 = createSession(db, { courseId });
  const r3 = recordAnswer(db, { cardId: cards[2].id, sessionId: session3, raw: cards[2].answer, now: Date.now() + 3600 * 1000 });
  assert(r3.reviewed === false, 'answer 1h later must not count as review');
  assert(xpByAxis(db).math === xpAfterReview.math + 10, 'short-interval answer should give first-time +10');

  return `xp=${JSON.stringify(xpByAxis(db))} ledger=${ledger1.length} dup=blocked review=+15 short=+10`;
});

// ---------------------------------------------------------------- A5
await check('A5', '错题 due=+1天；答对按 FSRS 拉开', () => {
  const { db } = freshDb('a5');
  const { sessionId, content } = ingest(db, 'lecture-01.txt');
  const payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cards-lecture-01.json'), 'utf8'));
  const { kept } = materializeForSession(db, {
    sessionId,
    content,
    rawCards: payload.cards.filter((c) => c.kind === 'objective'),
    model: payload.model,
    promptVersion: payload.promptVersion,
  });
  assert(kept.length >= 3, 'need >=3 cards');
  const now = Date.now();
  const cards = db.prepare('SELECT * FROM cards WHERE discarded = 0 ORDER BY created_at').all();

  recordAnswer(db, { cardId: cards[0].id, sessionId, raw: 'Z', now });          // 错
  recordAnswer(db, { cardId: cards[1].id, sessionId, raw: cards[1].answer, now }); // 对

  const wrong = db.prepare('SELECT * FROM reviews WHERE card_id = ?').get(cards[0].id);
  const right = db.prepare('SELECT * FROM reviews WHERE card_id = ?').get(cards[1].id);

  const wrongDays = (wrong.due_at - now) / DAY;
  const rightDays = (right.due_at - now) / DAY;
  assert(Math.abs(wrongDays - 1) < 0.1, `wrong due should be +1 day, got ${wrongDays.toFixed(2)}`);
  assert(rightDays > 1, `correct card should be pushed out, got ${rightDays.toFixed(2)} days`);
  return `wrong=+${wrongDays.toFixed(2)}d right=+${rightDays.toFixed(2)}d`;
});

// ---------------------------------------------------------------- A6
await check('A6', '关库重开 → 数据/经验/队列不变（核独立于视图）', () => {
  const a = freshDb('a6');
  const { sessionId, content } = ingest(a.db, 'lecture-01.txt');
  const payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cards-lecture-01.json'), 'utf8'));
  const { kept } = materializeForSession(a.db, {
    sessionId,
    content,
    rawCards: payload.cards.filter((c) => c.kind === 'objective'),
    model: payload.model,
    promptVersion: payload.promptVersion,
  });
  assert(kept.length > 0, 'no cards');
  const cards = a.db.prepare('SELECT * FROM cards WHERE discarded = 0').all();
  recordAnswer(a.db, { cardId: cards[0].id, sessionId, raw: cards[0].answer });
  const xpBefore = xpByAxis(a.db);
  const dueBefore = dueCards(a.db, Date.now() + DAY * 30).length;
  a.db.close();

  const b = openDb(a.file);
  const xpAfter = xpByAxis(b.db);
  const dueAfter = dueCards(b.db, Date.now() + DAY * 30).length;
  assert(JSON.stringify(xpBefore) === JSON.stringify(xpAfter), 'xp changed after reopen');
  assert(dueBefore === dueAfter, 'queue changed after reopen');
  b.db.close();
  return `xp=${JSON.stringify(xpAfter)} due=${dueAfter}`;
});

// ---------------------------------------------------------------- A8
await check('A8', '日志不出现 cookie/token', () => {
  const secret = 'SESSDATA=deadbeef%2C1799999999%2Cabc*def';
  log(`test line with ${secret} and bili_jct=0123456789abcdef`);
  const text = fs.readFileSync(logFile(), 'utf8');
  assert(!text.includes('deadbeef'), 'raw SESSDATA leaked into log');
  assert(!text.includes('0123456789abcdef'), 'raw bili_jct leaked into log');
  assert(text.includes('[REDACTED]'), 'redaction marker missing');
  return 'redacted';
});

// ---------------------------------------------------------------- A10
await check('A10', '主观题溯源：程序判不冒充模型；未判 ≠ 通过；模型造的点不算', () => {
  const { db } = freshDb('a10');
  const { sessionId, content } = ingest(db, 'lecture-01.txt');
  const payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cards-lecture-01.json'), 'utf8'));
  materializeForSession(db, {
    sessionId,
    content,
    rawCards: payload.cards,
    model: payload.model,
    promptVersion: payload.promptVersion,
  });
  const sub = db.prepare("SELECT * FROM cards WHERE kind = 'subjective' AND discarded = 0").get();
  assert(sub, 'no subjective card');

  const r = recordAnswer(db, { cardId: sub.id, sessionId, raw: '原点 自由 坐标 唯一' });
  const row = db.prepare('SELECT graded_by, rubric_json FROM answers WHERE id = ?').get(r.answerId);
  assert(row.graded_by === 'program:rubric-keyword', `graded_by lied: ${row.graded_by}`);
  const keyword = JSON.parse(row.rubric_json);
  assert(keyword.advisory === true, 'keyword grade must be marked advisory');

  const evt = JSON.parse(db.prepare("SELECT payload_json FROM events WHERE type = 'answer.recorded' AND payload_json LIKE '%subjective%'").get().payload_json);
  assert(evt.passed === null && evt.provisional === true, 'provisional pass leaked into the event');

  const pending = pendingSubjective(db, sessionId);
  assert(pending.length === 1, `expected 1 pending subjective answer, got ${pending.length}`);

  applyModelGrade(db, r.answerId, { hit: ['物理', '计算机'], passed: true, note: '2/4', by: 'model:deepseek-flash' });
  const row2 = db.prepare('SELECT graded_by, rubric_json FROM answers WHERE id = ?').get(r.answerId);
  assert(row2.graded_by === 'model:deepseek-flash', 'model grade not attributed');
  assert(JSON.parse(row2.rubric_json).hit === 2, 'model hit count wrong');
  assert(pendingSubjective(db, sessionId).length === 0, 'answered stayed pending');

  // 模型自造要点不算命中
  const norm = normalizeGradeResult({ hit: ['原点', '凭空的点'], passed: true, note: '' }, ['原点', '自由', '坐标', '唯一']);
  assert(norm.hit.length === 1 && norm.passed === false, 'partial rubric must not pass');
  // 盲判输出不可解析 → 抛错（调用方据此记 failed，不默认通过）
  mustThrow(() => parseGradeOutput('{"foo":1}'), 'grade output without hit must throw');
  mustThrow(() => parseGradeOutput('抱歉我无法判定'), 'non-JSON grade output must throw');
  return 'program:rubric-keyword → model:deepseek-flash，未判不通过';
});

// ---------------------------------------------------------------- A11
await check('A11', '字幕质量闸：退化字幕被拒绝、正常测试文本可通过、并如实暴露统计层的边界', () => {
  const garbage = Array.from({ length: 20 }, (_, i) => ({ from: i * 3, to: (i + 1) * 3, text: '呵呵那鹏还是邻啊啊' }));
  const g = assessSubtitles(garbage);
  assert(g.verdict === 'degenerate', `expected degenerate, got ${g.verdict} (dupRate=${g.dupRate})`);

  const parts = loadTextParts(path.join(FIXTURES, 'lecture-01.txt'));
  const real = parts.flatMap((p, i) =>
    (p.text.match(/.{1,12}/g) || []).slice(0, 40).map((t, k) => ({ from: (i * 40 + k) * 3, to: (i * 40 + k + 1) * 3, text: t })),
  );
  const good = assessSubtitles(real);
  assert(good.verdict === 'ok', `normal fixture rejected: ${good.verdict}`);

  assert(assessSubtitles([]).verdict === 'no-subtitles', 'empty cues must be rejected');

  // 已知边界（不是通过项）：语义错但统计正常 —— 闸会放过，只能靠弃权+抽检
  const semantic = Array.from({ length: 20 }, (_, i) => ({
    from: i * 3, to: (i + 1) * 3, text: `第${i}讲讲的是矩阵乘法与向量空间的关系`,
  }));
  const blind = assessSubtitles(semantic);
  assert(blind.verdict === 'ok', 'statistical gate should NOT claim to catch semantic errors');
  return `degenerate=${g.verdict} real=${good.verdict} semantic-boundary=passes-by-design`;
});

// ---------------------------------------------------------------- A12
await check('A12', '未判 ≠ 通过：主观题盲判前 passed=null，盲判后追加可追溯事件', () => {
  const { db } = freshDb('a12');
  const { sessionId, content } = ingest(db, 'lecture-01.txt');
  const payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cards-lecture-01.json'), 'utf8'));
  materializeForSession(db, { sessionId, content, rawCards: payload.cards, model: payload.model, promptVersion: payload.promptVersion });
  const sub = db.prepare("SELECT * FROM cards WHERE kind = 'subjective' AND discarded = 0").get();
  assert(sub, 'no subjective card');

  const r = recordAnswer(db, { cardId: sub.id, sessionId, raw: '原点 自由 坐标 唯一' });
  assert(r.passed === null, `pending subjective must not be passed, got ${JSON.stringify(r.passed)}`);
  assert(r.status === 'pending-model', `status should be pending-model, got ${r.status}`);
  const evt = JSON.parse(
    db.prepare("SELECT payload_json FROM events WHERE type = 'answer.recorded'").get().payload_json,
  );
  assert(evt.passed === null && evt.provisional === true, 'event claimed a verdict it does not have');

  const before = Number(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'answer.regraded'").get().n);
  const xpBefore = xpByAxis(db);
  applyModelGrade(db, r.answerId, { hit: ['原点'], passed: false, note: '只提了一个点', by: 'model:deepseek-flash' });
  const after = Number(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'answer.regraded'").get().n);
  assert(after === before + 1, 'regrade event missing');
  assert(JSON.stringify(xpByAxis(db)) === JSON.stringify(xpBefore), 'regrade changed xp');

  const dup = recordAnswer(db, { cardId: sub.id, sessionId, raw: '再答一次' });
  assert(dup.duplicate === true && dup.passed === false, 'duplicate after grading should report the graded verdict');
  return 'pending → 事件 → 已判，xp 不变';
});

// ---------------------------------------------------------------- A13
await check('A13', '严格布尔：模型回 "false" 字符串不能被当成通过', () => {
  mustThrow(() => parseGradeOutput('{"hit":["原点"],"passed":"false"}'), 'string "false" was accepted');
  mustThrow(() => parseGradeOutput('{"hit":["原点"],"passed":1}'), 'number passed was accepted');
  mustThrow(
    () => normalizeGradeResult({ hit: ['原点'], passed: 'false' }, ['原点']),
    'normalizeGradeResult accepted a string',
  );
  const ok = normalizeGradeResult({ hit: ['原点', '凭空的点'], passed: true }, ['原点', '自由']);
  assert(ok.hit.length === 1 && ok.passed === false, 'partial rubric must not pass');
  const full = normalizeGradeResult({ hit: ['原点', '自由', '自由'], passed: false }, ['原点', '自由']);
  assert(full.hit.length === 2 && full.passed === true, 'all required points must pass regardless of model impression');
  return 'string/number rejected, boolean accepted';
});

// ---------------------------------------------------------------- A14
await check('A14', '统计口径：缺答案不算 span 失败', () => {
  const { db } = freshDb('a14');
  const { sessionId, content } = ingest(db, 'lecture-01.txt');
  materializeForSession(db, {
    sessionId,
    content,
    rawCards: [
      { kind: 'objective', question: 'q1', options: ['a', 'b', 'c', 'd'], answer: 'A', quote: '选定坐标轴后,程序可以用按轴顺序排列的数组存储向量。' },
      { kind: 'subjective', question: 'q2', answer: '', rubric: ['要点'], quote: '箭头的长度和指向共同刻画移动的大小与方向' },
      { kind: 'objective', question: 'q3', options: ['a', 'b', 'c', 'd'], answer: 'A', quote: '这句原文里不存在' },
    ],
    model: 'deepseek-flash',
    promptVersion: 'test',
  });
  const r = rates(db, sessionId);
  assert(r.discarded === 2, `expected 2 discarded, got ${r.discarded}`);
  assert(r.discardedByReason['empty-answer'] === 1, 'empty-answer not counted separately');
  assert(r.discardedByReason['span-not-found'] === 1, 'span-not-found not counted');
  // 比率按 4 位小数四舍五入，断言留到 1e-3
  assert(Math.abs(r.spanFailRate - 1 / 3) < 1e-3, `spanFailRate wrong: ${r.spanFailRate}`);
  assert(Math.abs(r.missingAnswerRate - 1 / 3) < 1e-3, `missingAnswerRate wrong: ${r.missingAnswerRate}`);
  return JSON.stringify(r.discardedByReason);
});

// ---------------------------------------------------------------- A15
await check('A15', '模型判卷幂等：相反结果重试不覆盖，事件失败时整笔回滚', () => {
  const { db } = freshDb('a15');
  try {
    const { sessionId, courseId, content } = ingest(db, 'lecture-01.txt');
    const payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cards-lecture-01.json'), 'utf8'));
    materializeForSession(db, { sessionId, content, rawCards: payload.cards, model: payload.model, promptVersion: payload.promptVersion });
    const sub = db.prepare("SELECT * FROM cards WHERE kind = 'subjective' AND discarded = 0").get();
    const xpBefore = JSON.stringify(xpByAxis(db));

    for (const passed of [true, false]) {
      const sid = passed ? sessionId : createSession(db, { courseId });
      const answer = recordAnswer(db, { cardId: sub.id, sessionId: sid, raw: '原点 自由 坐标 唯一' });
      const first = { hit: passed ? JSON.parse(sub.rubric_json) : [], passed, note: 'first result', by: 'model:first' };
      const saved = applyModelGrade(db, answer.answerId, first);
      const rowBefore = JSON.stringify(db.prepare('SELECT * FROM answers WHERE id = ?').get(answer.answerId));
      const eventBefore = JSON.stringify(db.prepare('SELECT * FROM events WHERE dedupe_key = ?').get(`regrade:${answer.answerId}`));

      for (const retry of [first, { hit: [], passed: !passed, note: 'opposite result', by: 'model:retry' }]) {
        const result = applyModelGrade(db, answer.answerId, retry);
        assert(JSON.stringify(result) === JSON.stringify(saved), 'retry did not return the first result');
        assert(JSON.stringify(db.prepare('SELECT * FROM answers WHERE id = ?').get(answer.answerId)) === rowBefore, 'retry changed answer or grader');
        assert(JSON.stringify(db.prepare('SELECT * FROM events WHERE dedupe_key = ?').get(`regrade:${answer.answerId}`)) === eventBefore, 'retry changed grade event');
      }
      const event = JSON.parse(db.prepare('SELECT payload_json FROM events WHERE dedupe_key = ?').get(`regrade:${answer.answerId}`).payload_json);
      assert(event.passed === saved.passed, 'answer and event disagree');
      const count = db.prepare('SELECT COUNT(*) n FROM events WHERE dedupe_key = ?').get(`regrade:${answer.answerId}`).n;
      assert(Number(count) === 1, 'retry produced extra grade events');
    }

    const sid = createSession(db, { courseId });
    const pending = recordAnswer(db, { cardId: sub.id, sessionId: sid, raw: '等待判卷' });
    const pendingRow = JSON.stringify(db.prepare('SELECT * FROM answers WHERE id = ?').get(pending.answerId));
    db.exec(`CREATE TEMP TRIGGER reject_grade_event BEFORE INSERT ON events
      WHEN NEW.type = 'answer.regraded' BEGIN SELECT RAISE(ABORT, 'injected event failure'); END;`);
    mustThrow(() => applyModelGrade(db, pending.answerId, { hit: [], passed: false, by: 'model:test' }), 'event failure was ignored');
    assert(JSON.stringify(db.prepare('SELECT * FROM answers WHERE id = ?').get(pending.answerId)) === pendingRow, 'failed event left an updated answer');
    assert(!db.prepare('SELECT id FROM events WHERE dedupe_key = ?').get(`regrade:${pending.answerId}`), 'failed transaction left a grade event');
    db.exec('DROP TRIGGER reject_grade_event');
    applyModelGrade(db, pending.answerId, { hit: [], passed: false, by: 'model:test' });
    assert(JSON.stringify(xpByAxis(db)) === xpBefore, 'grading or retry changed xp');
    return 'pass/fail first-result preserved; same/opposite retries stable; rollback and retry verified';
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------- A9
await check('A9', '服务独立可读：HTTP /xp 取得到数据', async () => {
  const { db, file } = freshDb('a9');
  const { sessionId, content } = ingest(db, 'lecture-01.txt');
  const payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cards-lecture-01.json'), 'utf8'));
  const { kept } = materializeForSession(db, {
    sessionId,
    content,
    rawCards: payload.cards.filter((c) => c.kind === 'objective'),
    model: payload.model,
    promptVersion: payload.promptVersion,
  });
  const card = db.prepare('SELECT * FROM cards WHERE discarded = 0').all()[0];
  recordAnswer(db, { cardId: card.id, sessionId, raw: card.answer });

  const { server, port } = await startServer({ db, port: 0 });
  const body = await new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}/xp`, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
  server.close();
  db.close();
  const parsed = JSON.parse(body);
  assert(parsed.xp && Object.values(parsed.xp).some((v) => v > 0), 'no xp over http');
  return `GET /xp -> ${body}`;
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
if (failed.length) {
  console.log('FAILED: ' + failed.map((f) => f.id).join(', '));
  process.exitCode = 1;
}

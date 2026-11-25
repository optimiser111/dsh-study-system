import { randomUUID, createHash } from 'node:crypto';
import { normalize, NORMALIZER_VERSION, normalizeEditor, EDITOR_NORMALIZER_VERSION } from './normalize.mjs';
import { CHATGPT_SOURCE } from '../capture/chatgpt.mjs';
import { CODEX_SOURCE } from '../capture/codex.mjs';
import { locate } from './span.mjs';
import { applyEvent, rebuildLedger } from './events.mjs';
import { gradeObjective, gradeSubjective } from '../cards/grade.mjs';
import { schedule, deserialize, serialize } from '../review/fsrs.mjs';
import { segmentWarnings } from '../sources/warnings.mjs';
import { evaluateGrade, rubricPoints } from '../../plugin/grading.js';
import { validateLessonSummary, assessmentError } from '../../plugin/lesson-core.js';
import { dialogueState } from './dialogue.mjs';
import { normalizeSubject } from './subjects.mjs';

const DAY = 86_400_000;

// ---------- 课程 / 会话 / 内容 ----------

export function upsertCourse(db, { platform, externalId, title, axis }) {
  const found = externalId
    ? db.prepare('SELECT * FROM courses WHERE platform = ? AND external_id = ?').get(platform, externalId)
    : null;
  if (found) return found;
  const id = randomUUID();
  db.prepare(
    'INSERT INTO courses (id, platform, external_id, title, axis, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, platform, externalId ?? null, title, normalizeSubject(axis) || axis, Date.now());
  return db.prepare('SELECT * FROM courses WHERE id = ?').get(id);
}

export function createSession(db, { courseId, sourceId = null, startedAt = Date.now() }) {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO sessions (id, course_id, source_id, started_at) VALUES (?, ?, ?, ?)',
  ).run(id, courseId, sourceId, startedAt);
  return id;
}

export function saveSource(db, { courseId, kind, status, quality = null, detail = null }) {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO sources (id, course_id, kind, status, fetched_at, quality_json, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, courseId, kind, status, Date.now(), quality ? JSON.stringify(quality) : null, detail);
  return id;
}

/**
 * 把原始片段拼成 Content：每片单独归一化，片间用 \n 连接。
 * 返回的 text 就是 span 的唯一坐标系。
 */
export function buildContent({ sessionId, sourceKind, parts }) {
  const preserveFormatting = ['desktop-editor-text', CHATGPT_SOURCE, CODEX_SOURCE].includes(sourceKind);
  const normalized = parts.map((p) => ({ ts: p.ts, text: preserveFormatting ? normalizeEditor(p.text) : normalize(p.text).text })).filter((p) => p.text);
  let text = '';
  const chunks = [];
  for (const part of normalized) {
    if (text) text += '\n';
    const spanStart = text.length;
    text += part.text;
    chunks.push({
      ts: part.ts,
      text: part.text,
      spanStart,
      spanEnd: text.length,
      source: sourceKind,
    });
  }
  return { sessionId, text, chunks, normalizerVersion: preserveFormatting ? EDITOR_NORMALIZER_VERSION : NORMALIZER_VERSION, meta: {} };
}

export function attachContent(db, sessionId, content) {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO contents (id, session_id, text, normalizer_version, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, sessionId, content.text, content.normalizerVersion, Date.now());
  db.prepare('UPDATE sessions SET content_id = ? WHERE id = ?').run(id, sessionId);
  return id;
}

export function loadContent(db, sessionId) {
  const row = db
    .prepare(
      `SELECT c.* FROM contents c JOIN sessions s ON s.content_id = c.id WHERE s.id = ?`,
    )
    .get(sessionId);
  if (!row) return null;
  return {
    sessionId,
    text: row.text,
    normalizerVersion: row.normalizer_version,
    chunks: [],
    meta: {},
  };
}

// ---------- 切段 ----------

/**
 * 切段计划（纯函数）。有 ts 就按时间切（默认 8 分钟），没有就按字数切（默认 2000 字）。
 * 同时给出每段对应的 cue 下标区间，供按段做字幕质检。
 */
export function planSegments(content, { targetSeconds = 480, targetChars = 2000 } = {}) {
  const timed = content.chunks.some((c) => typeof c.ts === 'number');
  const groups = [];
  let current = [];
  let acc = 0;
  let groupStart = 0;
  let cueStart = 0;

  for (let i = 0; i < content.chunks.length; i++) {
    const chunk = content.chunks[i];
    if (current.length === 0) {
      groupStart = chunk.spanStart;
      cueStart = i;
    }
    current.push(chunk);
    if (timed) {
      const prev = current.length > 1 ? current[current.length - 2] : null;
      if (prev && typeof chunk.ts === 'number' && typeof prev.ts === 'number') acc += chunk.ts - prev.ts;
    } else {
      acc += chunk.text.length;
    }
    const limit = timed ? targetSeconds : targetChars;
    if (acc >= limit) {
      groups.push({ cueStart, cueEnd: i + 1, spanStart: groupStart, spanEnd: chunk.spanEnd });
      current = [];
      acc = 0;
    }
  }
  if (current.length) {
    groups.push({
      cueStart,
      cueEnd: content.chunks.length,
      spanStart: groupStart,
      spanEnd: current[current.length - 1].spanEnd,
    });
  }
  return groups;
}

export function addSegments(db, sessionId, content, opts = {}) {
  const groups = planSegments(content, opts);
  const ids = [];
  groups.forEach((group, index) => {
    const id = randomUUID();
    db.prepare(
      'INSERT INTO segments (id, session_id, seq, source_kind, text, span_start, span_end) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      sessionId,
      index,
      content.chunks[group.cueStart].source,
      content.text.slice(group.spanStart, group.spanEnd),
      group.spanStart,
      group.spanEnd,
    );
    ids.push(id);
  });
  return ids;
}

export function updateSourceQuality(db, sourceId, quality) {
  db.prepare('UPDATE sources SET quality_json = ? WHERE id = ?').run(JSON.stringify(quality), sourceId);
}

// ---------- 出题结果落地（含 span 硬校验） ----------

/**
 * rawCards 是模型（或录制响应）的原始输出。每条必须带 quote（引用的原文）。
 * span 找不到 → 落库为 discarded=1 并计入丢弃率，绝不降级成警告。
 */
export function materializeCards(db, { segmentId, content, rawCards, model, promptVersion, assessment = null }) {
  const segment = db.prepare('SELECT * FROM segments WHERE id = ?').get(segmentId);
  const kept = [];
  const discarded = [];

  for (const raw of rawCards) {
    const quote = String(raw.quote ?? '').trim();
    const at = quote ? locate(content, quote) : null;
    const id = randomUUID();
    const base = {
      id,
      segmentId,
      kind: raw.kind === 'subjective' ? 'subjective' : 'objective',
      question: String(raw.question ?? '').trim(),
      options: Array.isArray(raw.options) ? raw.options : null,
      answer: String(raw.answer ?? ''),
      rubric: Array.isArray(raw.rubric) ? raw.rubric : null,
      topic: raw.topic ?? null,
      difficulty: Number.isInteger(raw.difficulty) ? raw.difficulty : null,
      spanText: at ? at.spanText : quote,
      spanStart: at ? at.spanStart : -1,
      spanEnd: at ? at.spanEnd : -1,
    };
    let rubricInvalid = false;
    if (base.kind === 'subjective') {
      try { rubricPoints(base.rubric); } catch { rubricInvalid = true; }
    }
    const discardReason = !at
      ? 'span-not-found'
      : !base.question
        ? 'empty-question'
        : !base.answer
          ? 'empty-answer'
          : rubricInvalid ? 'invalid-rubric' : assessment ? assessmentError(raw, assessment.summary, { singleTask: ['m1-cards-v6', 'm1-cards-v7'].includes(promptVersion) }) : null;

    db.prepare(
      `INSERT INTO cards (id, segment_id, kind, question, options_json, answer, span_text, span_start, span_end,
        source_kind, topic, difficulty, rubric_json, model, prompt_version, normalizer_version, created_at,
        discarded, discard_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      segmentId,
      base.kind,
      base.question,
      base.options ? JSON.stringify(base.options) : null,
      base.answer,
      base.spanText,
      base.spanStart,
      base.spanEnd,
      segment.source_kind,
      base.topic,
      base.difficulty,
      base.rubric ? JSON.stringify(base.rubric) : null,
      model,
      promptVersion,
      content.normalizerVersion,
      Date.now(),
      discardReason ? 1 : 0,
      discardReason,
    );

    if (discardReason) discarded.push({ reason: discardReason, raw });
    else {
      kept.push(id);
      if (assessment) applyEvent(db, { type: 'card.assessed', dedupeKey: `assessment:${id}`, payload: {
        cardId: id, summaryId: assessment.id, targetId: raw.targetId, skill: raw.skill,
        assessmentReason: raw.assessmentReason, misconception: raw.misconception,
      } });
    }
  }

  if (kept.length) {
    applyEvent(db, {
      type: 'card.generated',
      payload: { segmentId, count: kept.length },
      dedupeKey: `cards:${segmentId}`,
    });
  }
  for (const d of discarded) {
    applyEvent(db, {
      type: 'card.discarded',
      payload: { segmentId, reason: d.reason },
      dedupeKey: `discard:${segmentId}:${d.reason}:${JSON.stringify(d.raw).length}`,
    });
  }
  return { kept, discarded };
}

/**
 * 把一张卡片列表按 span 落到对应的 segment 上再逐段落库。
 * 找不到 span 的卡片落到第一段并记为 discarded（丢弃率要能算出来）。
 */
export function materializeForSession(db, { sessionId, content, rawCards, model, promptVersion, assessment = null }) {
  const segments = db
    .prepare('SELECT * FROM segments WHERE session_id = ? ORDER BY seq')
    .all(sessionId);
  if (!segments.length) throw new Error('session has no segments');

  const grouped = new Map(segments.map((s) => [s.id, []]));
  for (const raw of rawCards) {
    const quote = String(raw.quote ?? '').trim();
    const at = quote ? content.text.indexOf(quote) : -1;
    const owner =
      (at >= 0 && segments.find((s) => at >= s.span_start && at < s.span_end)) || segments[0];
    grouped.get(owner.id).push(raw);
  }

  const out = { kept: [], discarded: [] };
  for (const [segmentId, list] of grouped) {
    if (!list.length) continue;
    const result = materializeCards(db, { segmentId, content, rawCards: list, model, promptVersion, assessment });
    out.kept.push(...result.kept);
    out.discarded.push(...result.discarded);
  }
  return out;
}

// ---------- 答题 / 判分 / 复习 ----------
function axisOfCard(db, cardId) {
  const row = db
    .prepare(
      `SELECT c.axis FROM cards k
       JOIN segments g ON g.id = k.segment_id
       JOIN sessions s ON s.id = g.session_id
       JOIN courses c ON c.id = s.course_id
       WHERE k.id = ?`,
    )
    .get(cardId);
  return row?.axis ?? 'other';
}

export const REVIEW_INTERVAL_MS = 24 * 60 * 60 * 1000;

function lastReviewAtOf(row) {
  if (!row || !row.state_json) return 0;
  try {
    const state = JSON.parse(row.state_json);
    return state.last_review ? new Date(state.last_review).getTime() : 0;
  } catch {
    return 0;
  }
}

/**
 * 一次作答的完整提交：判分 → 作答记录 → 事件 → 账本重放 → FSRS 调度，全在一个事务里。
 *
 * 业务身份：**同一张卡在同一个 session 里只算一次作答**。
 *  - 重复请求（重试 / 双击）返回既有结果，不新增作答、不再发奖、不重新调度；
 *  - 复习奖励只在「距上次复习 ≥ 1 天」时成立（契约 §4），否则按首次作答计。
 */
export function recordAnswer(db, { cardId, sessionId, raw, rubric = null, now = Date.now(), grader = null }) {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) throw new Error(`no such card: ${cardId}`);
  if (card.discarded) throw new Error('card was discarded; refusing to answer');

  const prior = db
    .prepare('SELECT * FROM answers WHERE card_id = ? AND session_id = ? ORDER BY created_at LIMIT 1')
    .get(cardId, sessionId);
  if (prior) {
    const priorRubric = prior.rubric_json ? JSON.parse(prior.rubric_json) : null;
    const stillPending = Boolean(priorRubric && priorRubric.advisory);
    return {
      duplicate: true,
      answerId: prior.id,
      correct: prior.correct === null ? null : Boolean(prior.correct),
      rubric: priorRubric,
      passed: prior.correct === null ? (stillPending ? null : Boolean(priorRubric && priorRubric.passed)) : Boolean(prior.correct),
      status: stillPending ? 'pending-model' : prior.correct === null ? (priorRubric && priorRubric.passed ? 'passed' : 'failed') : prior.correct ? 'correct' : 'wrong',
      reviewed: false,
      ...(card.kind === 'subjective' && card.prompt_version === 'm1-cards-v7'
        ? ((state) => ({ status: state.status, passed: state.passed }))(dialogueState(db, prior.id)) : {}),
    };
  }

  const existingReview = db.prepare('SELECT * FROM reviews WHERE card_id = ?').get(cardId);
  const lastReviewAt = lastReviewAtOf(existingReview);
  const reviewed = Boolean(existingReview) && lastReviewAt > 0 && now - lastReviewAt >= REVIEW_INTERVAL_MS;

  let correct = null;
  let rubricResult = null;
  let gradedBy;

  if (card.kind === 'objective') {
    correct = gradeObjective(card, raw);
    gradedBy = 'program:objective';
  } else {
    const points = rubric ?? (card.rubric_json ? JSON.parse(card.rubric_json) : []);
    if (grader && grader.by && grader.result) {
      // 模型盲判：结果由插件宿主半用 ctx.llm 产出后传进来，这里只负责落账
      rubricResult = grader.result;
      gradedBy = grader.by;
    } else {
      rubricResult = { ...gradeSubjective(raw, points), method: 'keyword-contains', advisory: true };
      gradedBy = 'program:rubric-keyword';
    }
  }

  // 主观题在模型盲判之前**没有**通过与否可言：advisory 结论不能变成通过
  const advisory = Boolean(rubricResult && rubricResult.advisory);
  const passed =
    card.kind === 'objective' ? correct : advisory ? null : Boolean(rubricResult && rubricResult.passed);
  const status =
    card.kind === 'objective'
      ? correct
        ? 'correct'
        : 'wrong'
      : advisory
        ? 'pending-model'
        : passed
          ? 'passed'
          : 'failed';
  const answerId = randomUUID();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      'INSERT INTO answers (id, card_id, session_id, raw, correct, rubric_json, graded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      answerId,
      cardId,
      sessionId,
      String(raw),
      card.kind === 'objective' ? (correct ? 1 : 0) : null,
      rubricResult ? JSON.stringify(rubricResult) : null,
      gradedBy,
      now,
    );

    applyEvent(db, {
      type: 'answer.recorded',
      payload: {
        cardId,
        kind: card.kind,
        correct: card.kind === 'objective' ? correct : passed,
        reviewed,
        axis: axisOfCard(db, cardId),
        // 主观题的程序判分只是"参考结论"，不冒充模型判定
        passed: card.kind === 'objective' ? passed : rubricResult && !rubricResult.advisory ? passed : null,
        provisional: Boolean(rubricResult && rubricResult.advisory),
        gradedBy,
      },
      at: now,
      dedupeKey: `answer:${cardId}:${sessionId}`,
    });

    // 客观题进复习队列：答错 → again（FSRS 给 1 天），答对 → 拉开间隔
    if (card.kind === 'objective') {
      const state = existingReview ? deserialize(existingReview.state_json) : null;
      const next = schedule(state, correct ? 'good' : 'again', now);
      db.prepare(
        `INSERT INTO reviews (card_id, stability, difficulty, due_at, reps, lapses, last_rating, state_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(card_id) DO UPDATE SET stability=excluded.stability, difficulty=excluded.difficulty,
           due_at=excluded.due_at, reps=excluded.reps, lapses=excluded.lapses,
           last_rating=excluded.last_rating, state_json=excluded.state_json`,
      ).run(
        cardId,
        next.stability,
        next.difficulty,
        next.due,
        next.reps,
        next.lapses,
        correct ? 'good' : 'again',
        serialize(next.card),
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { duplicate: false, answerId, correct, rubric: rubricResult, passed, status, reviewed };
}

/** 结算：同一个 session 重复结算不会改变任何数值（A7）。 */
export function settle(db, sessionId, now = Date.now()) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) throw new Error(`no such session: ${sessionId}`);
  const res = applyEvent(db, {
    type: 'session.end',
    payload: { sessionId },
    at: now,
    dedupeKey: `settle:${sessionId}`,
  });
  db.prepare('UPDATE sessions SET ended_at = COALESCE(ended_at, ?) WHERE id = ?').run(now, sessionId);
  rebuildLedger(db, now);
  return { deduped: res.deduped };
}

/** 主观题待盲判：还是程序关键词结论、没被模型判过的作答 */
export function pendingSubjective(db, sessionId) {
  const rows = db
    .prepare(
      `SELECT a.id AS answerId, a.raw, k.question, k.rubric_json,k.prompt_version
       FROM answers a
       JOIN cards k ON k.id = a.card_id
       WHERE a.session_id = ? AND k.kind = 'subjective' AND a.graded_by NOT LIKE 'model:%'
       ORDER BY a.created_at`,
    )
    .all(sessionId);
  return rows.map((r) => ({
    answerId: r.answerId,
    raw: r.raw,
    question: r.question,
    rubric: r.rubric_json ? JSON.parse(r.rubric_json) : [],
    ...(r.prompt_version === 'm1-cards-v7' ? { dialogue: dialogueState(db, r.answerId) } : {}),
  })).filter((r) => !r.dialogue || r.dialogue.status === 'pending-model');
}

/** 模型盲判结果写回。首个正式结果生效；重复请求返回原结果，不覆盖答案或事件。 */
export function applyModelGrade(db, answerId, { hit = [], passed = false, note = '', by }) {
  if (typeof passed !== 'boolean') throw new Error('passed must be a boolean');
  if (!by || !String(by).startsWith('model:')) throw new Error('grade must be attributed to a model');
  // 先取得写锁再检查，避免两个连接都把同一作答当成未判。
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM answers WHERE id = ?').get(answerId);
    if (!row) throw new Error(`no such answer: ${answerId}`);
    if (row.graded_by?.startsWith('model:')) {
      let existing;
      try { existing = JSON.parse(row.rubric_json); } catch { /* below */ }
      if (!existing || existing.method !== 'blind-model' || existing.advisory !== false ||
          typeof existing.passed !== 'boolean' || !Array.isArray(existing.points)) {
        const error = new Error(`invalid stored model grade for answer ${answerId}; audit required`);
        error.code = 'INVALID_STORED_GRADE';
        throw error;
      }
      db.exec('COMMIT');
      return existing;
    }
    const card = db.prepare('SELECT rubric_json FROM cards WHERE id = ?').get(row.card_id);
    const rubric = card && card.rubric_json ? JSON.parse(card.rubric_json) : [];
    const evaluated = evaluateGrade(hit, rubric);
    const result = {
      hit: evaluated.hit.length,
      total: rubric.length,
      points: evaluated.hit,
      passed: evaluated.passed,
      gradingRule: evaluated.gradingRule,
      coverage: evaluated.coverage,
      missingRequired: evaluated.missingRequired,
      note,
      method: 'blind-model',
      advisory: false,
    };
    db.prepare('UPDATE answers SET rubric_json = ?, graded_by = ? WHERE id = ?').run(
      JSON.stringify(result),
      by,
      answerId,
    );
    const event = applyEvent(db, {
      type: 'answer.regraded',
      payload: {
        answerId,
        cardId: row.card_id,
        sessionId: row.session_id,
        hit: result.hit,
        total: result.total,
        passed: result.passed,
        points: result.points,
        gradingRule: result.gradingRule,
        by,
      },
      dedupeKey: `regrade:${answerId}`,
    });
    // 如果历史记录已有事件却没有正式判定，拒绝静默覆盖，回滚本次修改。
    if (event.deduped) throw new Error(`grade event already exists for ungraded answer: ${answerId}`);
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function dueCards(db, now = Date.now()) {  return db
    .prepare(
      `SELECT k.*, r.due_at, r.reps, r.lapses FROM reviews r
       JOIN cards k ON k.id = r.card_id
       WHERE r.due_at <= ? AND k.discarded = 0
       ORDER BY r.due_at`,
    )
    .all(now);
}

export function rates(db, sessionId) {
  const total = db
    .prepare(
      `SELECT COUNT(*) AS n FROM cards k JOIN segments g ON g.id = k.segment_id WHERE g.session_id = ?`,
    )
    .get(sessionId).n;
  const discarded = db
    .prepare(
      `SELECT COUNT(*) AS n FROM cards k JOIN segments g ON g.id = k.segment_id
       WHERE g.session_id = ? AND k.discarded = 1`,
    )
    .get(sessionId).n;
  const segments = db
    .prepare('SELECT COUNT(*) AS n FROM segments WHERE session_id = ?')
    .get(sessionId).n;
  const abstained = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE type = 'abstained' AND payload_json LIKE ?`)
    .get(`%${sessionId}%`).n;

  // 丢弃要按原因分开：span 找不到 ≠ 模型没给答案
  const byReason = Object.fromEntries(
    db
      .prepare(
        `SELECT COALESCE(k.discard_reason, 'unknown') AS reason, COUNT(*) AS n
         FROM cards k JOIN segments g ON g.id = k.segment_id
         WHERE g.session_id = ? AND k.discarded = 1
         GROUP BY reason`,
      )
      .all(sessionId)
      .map((r) => [r.reason, Number(r.n)]),
  );
  const spanFails = byReason['span-not-found'] ?? 0;

  return {
    segments,
    cards: total,
    discarded,
    discardedByReason: byReason,
    discardRate: total ? Number((discarded / total).toFixed(4)) : 0,
    spanFailRate: total ? Number((spanFails / total).toFixed(4)) : 0,
    missingAnswerRate: total ? Number(((byReason['empty-answer'] ?? 0) / total).toFixed(4)) : 0,
    abstainRate: segments ? Number((abstained / segments).toFixed(4)) : 0,
  };
}

export { DAY };

/** 只读复核列表：保留稳定 ID、完整来源段以及所有丢弃记录。 */
export function reviewCards(db) {
  return db.prepare(`SELECT k.*, g.seq, g.text AS segment_text, g.span_start AS segment_start,
      s.id AS session_id, c.title AS course, c.external_id, src.quality_json
    FROM cards k JOIN segments g ON g.id=k.segment_id
    JOIN sessions s ON s.id=g.session_id JOIN courses c ON c.id=s.course_id
    LEFT JOIN sources src ON src.id=s.source_id
    ORDER BY s.started_at, g.seq, k.created_at, k.id`).all().map((row) => {
    let quality;
    try { quality = JSON.parse(row.quality_json)?.segments?.[row.seq]; } catch { /* legacy */ }
    const warnings = segmentWarnings({ source_kind: row.source_kind, text: row.segment_text, span_start: row.segment_start }, quality);
    const { quality_json, ...card } = row;
    return { ...card, warnings, reviewPriority: warnings.length ? 'check-source' : 'normal' };
  });
}

export const contentHash = (text) => createHash('sha256').update(text).digest('hex');

export function loadLessonSummary(db, sessionId, promptVersion) {
  const content = loadContent(db, sessionId);
  if (!content) return null;
  for (const event of db.prepare("SELECT id,payload_json FROM events WHERE type='lesson.summarized' AND json_extract(payload_json,'$.sessionId')=? ORDER BY created_at DESC").all(sessionId)) {
    const payload = JSON.parse(event.payload_json);
    if (payload.contentHash === contentHash(content.text) && (!promptVersion || payload.promptVersion === promptVersion)) return {
      id: event.id, ...payload,
      assessmentCompleted: !!db.prepare('SELECT id FROM events WHERE dedupe_key=?').get(`lesson-assessed:${event.id}`),
    };
  }
  return null;
}

export function saveLessonSummary(db, { sessionId, summary, model, promptVersion }) {
  if (typeof model !== 'string' || !model || typeof promptVersion !== 'string' || !promptVersion) throw new Error('summary provenance is required');
  const content = loadContent(db, sessionId);
  if (!content) throw new Error('session has no content');
  validateLessonSummary(summary, content.text);
  const hash = contentHash(content.text);
  applyEvent(db, { type: 'lesson.summarized', dedupeKey: `lesson:${sessionId}:${promptVersion}:${hash}`,
    payload: { sessionId, summary, model, promptVersion, contentHash: hash } });
  return loadLessonSummary(db, sessionId, promptVersion);
}

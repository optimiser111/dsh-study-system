#!/usr/bin/env node
// M1 的 CLI 链路：无 UI，先把 内容 → 出题 → 判卷 → 入账 → 入队 跑通。
import fs from 'node:fs';
import path from 'node:path';
import { openDb, resolveDataDir } from './db/open.mjs';
import { fetchVideo, fetchSubtitle, assessSubtitles } from './sources/bilibili.mjs';
import { loadTextParts } from './sources/fixture.mjs';
import {
  addSegments,
  attachContent,
  buildContent,
  createSession,
  dueCards,
  materializeForSession,
  planSegments,
  rates,
  recordAnswer,
  saveSource,
  settle,
  updateSourceQuality,
  upsertCourse,
} from './core/store.mjs';
import { levelByAxis, xpByAxis } from './core/events.mjs';
import { startServer } from './http/server.mjs';
import { log } from './core/log.mjs';
import { auditDb } from './core/audit.mjs';
import { getCollectorKey } from './capture/key.mjs';

const [, , command, ...rest] = process.argv;
const databasePath = command === 'serve' && rest[1] ? path.resolve(rest[1]) : undefined;
const { db, file } = openDb(databasePath);

const print = (o) => console.log(JSON.stringify(o, null, 1));

async function cmdImport(bvid, page = 1, axis = 'math') {
  const video = await fetchVideo(bvid);
  const course = upsertCourse(db, {
    platform: 'bilibili',
    externalId: bvid,
    title: video.title,
    axis,
  });
  const subtitle = await fetchSubtitle(bvid, page);
  if (!subtitle.ok) {
    const sourceId = saveSource(db, {
      courseId: course.id,
      kind: 'bilibili-cc',
      status: 'degraded',
      quality: subtitle.quality,
    });
    log(`degraded bvid=${bvid} p=${page} verdict=${subtitle.quality.verdict}`);
    print({ ok: false, degraded: true, sourceId, quality: subtitle.quality });
    return;
  }
  const sourceId = saveSource(db, {
    courseId: course.id,
    kind: 'bilibili-cc',
    status: 'ok',
    quality: subtitle.quality,
  });
  const sessionId = createSession(db, { courseId: course.id, sourceId });
  const content = buildContent({
    sessionId,
    sourceKind: 'bilibili-cc',
    parts: subtitle.cues.map((c) => ({ ts: c.from, text: c.text })),
  });
  attachContent(db, sessionId, content);
  const segments = addSegments(db, sessionId, content);

  // 质量闸按"段"算，不拿整门课的平均值糊过去（Codex 复核第 4 条）
  const plan = planSegments(content);
  const segmentsQuality = plan.map((group) =>
    assessSubtitles(subtitle.cues.slice(group.cueStart, group.cueEnd)),
  );
  const quality = { overall: subtitle.quality, segments: segmentsQuality };
  updateSourceQuality(db, sourceId, quality);

  print({
    ok: true,
    sessionId,
    courseId: course.id,
    segments,
    quality,
    db: file,
  });
}

function cmdIngest(fixtureFile, axis = 'math') {
  const course = upsertCourse(db, {
    platform: 'fixture',
    externalId: path.basename(fixtureFile),
    title: path.basename(fixtureFile),
    axis,
  });
  const sourceId = saveSource(db, { courseId: course.id, kind: 'pdf', status: 'ok' });
  const sessionId = createSession(db, { courseId: course.id, sourceId });
  const content = buildContent({
    sessionId,
    sourceKind: 'pdf',
    parts: loadTextParts(fixtureFile),
  });
  attachContent(db, sessionId, content);
  const segments = addSegments(db, sessionId, content);
  print({ ok: true, sessionId, courseId: course.id, segments, chars: content.text.length });
}

function cmdCards(sessionId, jsonFile, model = 'deepseek-flash', promptVersion = 'm1-cards-v1') {
  const content = db
    .prepare('SELECT text, normalizer_version FROM contents WHERE session_id = ?')
    .get(sessionId);
  if (!content) throw new Error('session has no content');
  const payload = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  const result = materializeForSession(db, {
    sessionId,
    content: { text: content.text, normalizerVersion: content.normalizer_version },
    rawCards: payload.cards,
    model: payload.model || model,
    promptVersion: payload.promptVersion || promptVersion,
  });
  print({ sessionId, kept: result.kept.length, discarded: result.discarded.length, ...rates(db, sessionId) });
}

function cmdAnswer(sessionId, cardId, answer) {
  const result = recordAnswer(db, { cardId, sessionId, raw: answer });
  print({ ...result, xp: xpByAxis(db) });
}

function main() {
  switch (command) {
    case 'capture-key':
      // 仅在用户主动执行时显示到本机终端；不进日志、模型或面板响应。
      console.log(getCollectorKey(db, true)); break;
    case 'init':
      print({ ok: true, db: file, dataDir: resolveDataDir() });
      break;
    case 'import':
      return cmdImport(rest[0], Number(rest[1] || 1), rest[2] || 'math');
    case 'ingest':
      return cmdIngest(rest[0], rest[1] || 'math');
    case 'cards':
      return cmdCards(rest[0], rest[1], rest[2], rest[3]);
    case 'answer':
      return cmdAnswer(rest[0], rest[1], rest.slice(2).join(' '));
    case 'settle':
      print({ ...settle(db, rest[0]), xp: xpByAxis(db) });
      break;
    case 'xp':
      print({ xp: xpByAxis(db), level: levelByAxis(db) });
      break;
    case 'due':
      print({ due: dueCards(db).map((c) => ({ id: c.id, question: c.question, due_at: c.due_at })) });
      break;
    case 'sessions':
      print(db.prepare(`SELECT s.id,c.title,s.started_at,s.ended_at,
        (SELECT COUNT(*) FROM cards k JOIN segments g ON g.id=k.segment_id WHERE g.session_id=s.id AND k.discarded=0) cards
        FROM sessions s JOIN courses c ON c.id=s.course_id ORDER BY s.started_at DESC`).all());
      break;
    case 'quiz':
      print(db.prepare(`SELECT k.id,k.kind,k.question,k.options_json FROM cards k JOIN segments g ON g.id=k.segment_id
        WHERE g.session_id=? AND k.discarded=0 ORDER BY g.seq,k.created_at,k.id`).all(rest[0]).map((c) => ({
          id: c.id, kind: c.kind, question: c.question, options: c.options_json ? JSON.parse(c.options_json) : undefined,
        })));
      break;
    case 'review-start': {
      const due = dueCards(db);
      if (!due.length) { print({ due: [], message: '没有到期复习' }); break; }
      const courseId = db.prepare('SELECT s.course_id FROM segments g JOIN sessions s ON s.id=g.session_id WHERE g.id=?').get(due[0].segment_id).course_id;
      const sessionId = createSession(db, { courseId });
      const cards = due.filter((c) => db.prepare('SELECT s.course_id FROM segments g JOIN sessions s ON s.id=g.session_id WHERE g.id=?').get(c.segment_id).course_id === courseId);
      print({ sessionId, cards: cards.map((c) => ({ id: c.id, question: c.question, options: c.options_json ? JSON.parse(c.options_json) : undefined })) });
      break;
    }
    case 'audit': {
      const result = auditDb(db); print(result); if (!result.ok) process.exitCode = 1; break;
    }
    case 'export': {
      if (!rest[0]) throw new Error('export requires an output JSON path');
      const output = { exportedAt: new Date().toISOString(), schemaVersion: 1, tables: {} };
      for (const table of ['courses', 'sources', 'contents', 'sessions', 'segments', 'cards', 'reviews', 'answers', 'events', 'xp_ledger']) {
        output.tables[table] = db.prepare(`SELECT * FROM ${table}`).all();
      }
      fs.writeFileSync(rest[0], JSON.stringify(output, null, 2), { flag: 'wx' });
      print({ exported: path.resolve(rest[0]) }); break;
    }
    case 'serve': {
      const port = Number(rest[0] || 7788);
      startServer({ db, port }).then(({ port: actual }) => {
        console.log(JSON.stringify({ ok: true, url: `http://127.0.0.1:${actual}`, db: file }));
      });
      break;
    }
    default:
      console.log('usage: cli.mjs <init|import|ingest|cards|sessions|quiz|answer|settle|xp|due|review-start|audit|export|serve> ...');
      process.exitCode = 2;
  }
}

main();

import http from 'node:http';
import { LocalAudio } from '../audio/manager.mjs';
import { modelSettings, saveModelSettings } from '../core/model-settings.mjs';
import { xpByAxis, levelByAxis, applyEvent } from '../core/events.mjs';
import {
  dueCards,
  recordAnswer,
  settle,
  loadContent,
  materializeForSession,
  pendingSubjective,
  applyModelGrade,
  reviewCards,
  createSession,
  loadLessonSummary,
  saveLessonSummary,
  contentHash,
} from '../core/store.mjs';
import { segmentWarnings } from '../sources/warnings.mjs';
import { sourceRevision } from '../core/version.mjs';
import { GRADING_RULE } from '../../plugin/grading.js';
import { PROMPT_VERSION } from '../../plugin/generate-core.js';
import { dialogueState, replyToFollowup, saveDialogueGrade } from '../core/dialogue.mjs';
import { workspaceView, sessionView, startReview, answerFromPanel, finishFromPanel, cardHistory } from '../core/workspace.mjs';
import { knowledgeMap, setKnowledgeCurrent, assessKnowledge, checkKnowledge } from '../core/knowledge.mjs';
import { Collector } from '../capture/collector.mjs';
import { getCollectorKey, validCollectorKey } from '../capture/key.mjs';
import { DesktopCapture } from '../capture/desktop.mjs';
import { ReadingCapture } from '../capture/reading.mjs';
import { publishEditorConfig } from '../capture/editor.mjs';
import { gradingQueue, requestGrading, claimGrading, finishGrading } from '../core/grading-queue.mjs';
import { researchQueue, requestResearch, researchInput, saveResearch, saveResearchCheckpoint, researchFailure, researchView, confirmResearch, assessResearchKnowledge, checkResearchKnowledge, assignResearchSubjectArea } from '../core/research.mjs';
import { requestExploration, explorationQueue, claimExploration, explorationInput, finishExploration } from '../core/node-exploration.mjs';
import { requestSubjectPresentation, subjectPresentationQueue, claimSubjectPresentation, finishSubjectPresentation, subjectPresentationStatus } from '../core/subject-presentation.mjs';
import { captureAction, captureReadiness, generationQueue, generationState, claimGeneration, finishGeneration } from '../core/capture-controls.mjs';

function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (c) => { bytes += c.length; if (bytes > maxBytes) { reject(new Error('request body too large')); return; } chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid json body'));
      }
    });
    req.on('error', reject);
  });
}

/** 面板经HTTP读写，数据由server验证并写入。 */
export function startServer({ db, port = 0, collectorOptions = {}, desktopOptions = {}, audioOptions = {}, readingOptions = {}, editorOptions = {}, chatOptions = {} }) {
  const revision = sourceRevision();
  const collector = new Collector(db, collectorOptions);
  const audio = collector.audio || ((audioOptions.enabled ?? ([7788, 7789].includes(port) && process.platform === 'win32'))
    ? new LocalAudio(db, { getSubtitle: collector.getSubtitle, mode: () => collector.settings.audioMode, ...audioOptions }) : null);
  collector.audio = audio;
  const desktop = new DesktopCapture(collector, desktopOptions);
  const reading=new ReadingCapture(db,{enabled:[7788,7789].includes(port)&&process.platform==='win32',...readingOptions});collector.reading=reading;
  publishEditorConfig(db,port);
  let workerSeenAt = 0;
  let workerError = null;
  let modelCatalog = { providers: [], updatedAt: 0, requestedAt: Date.now() };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, payload) => {
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        // 面板从 DSH Web 页面(另一个源)读这些只读接口
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type,authorization',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
      });
      res.end(JSON.stringify(payload));
    };
    if (req.method === 'OPTIONS') return send(204, {});
    try {
      if (url.pathname === '/collector/chatgpt') {
        const origin = req.headers.origin;
        if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) return send(403, { error: 'browser extension required' });
        let key = chatOptions.key;
        try { key ??= getCollectorKey(db); } catch { /* A file database is required for pairing. */ }
        if (!validCollectorKey(key, req.headers.authorization)) return send(401, { error: 'collector pairing required' });
        if (req.method === 'GET') return send(200, collector.settings.enabled ? reading.chatStatus() : { enabled: false });
        if (req.method !== 'POST') return send(405, { error: 'GET or POST required' });
        try {
          const body = await readBody(req, 400000);
          return send(200, collector.settings.enabled ? reading.receiveChat(body) : { accepted: false, state: 'inactive' });
        }
        catch { return send(400, { error: 'invalid conversation observation' }); }
      }
      if(url.pathname==='/collector/editor'){
        // Native extension only. Web pages cannot obtain editor status or send
        // material, even if they run on localhost and know the endpoint.
        if(req.headers.origin)return send(403,{error:'native editor bridge only'});
        let key=editorOptions.key;try{key??=getCollectorKey(db);}catch{}
        if(!validCollectorKey(key,req.headers.authorization))return send(401,{error:'collector pairing required'});
        if(req.method==='GET')return send(200,reading.editorStatus());
        if(req.method==='POST'){try{return send(200,await reading.receiveEditor(await readBody(req,160000)));}catch{return send(400,{error:'invalid editor observation'});}}
        return send(405,{error:'GET or POST required'});
      }
      if (url.pathname === '/collector/observe') {
        if (req.method !== 'POST') return send(405, { error: 'POST required' });
        if (!validCollectorKey(getCollectorKey(db), req.headers.authorization)) return send(401, { error: 'collector pairing required' });
        try {
          const body = await readBody(req, 8192);
          const view = collector.observe(body);
          return send(200, { ok: true, state: view.state, enabled: view.config.enabled });
        } catch { return send(400, { error: 'invalid collector observation' }); }
      }
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, revision, gradingRule: GRADING_RULE, requiredPromptVersion: PROMPT_VERSION, database: db.prepare('PRAGMA database_list').all().find((d) => d.name === 'main')?.file });
      if (req.method === 'GET' && url.pathname === '/review') return send(200, { cards: reviewCards(db) });
      if (url.pathname.startsWith('/panel/')) {
        const origin=req.headers.origin;
        const desktopPanel = !origin || origin === 'dsh-app://app';
        if(origin){let trusted=false;try{const o=new URL(origin);trusted=(['http:','https:'].includes(o.protocol)&&['127.0.0.1','localhost','[::1]'].includes(o.hostname))||o.protocol==='dsh-app:';}catch{}
          if(!trusted)return send(403,{error:'学习面板仅接受本机宿主访问'});
        }
        try {
          if(url.pathname==='/panel/reading/settings'&&req.method==='GET')return send(200,{mode:collector.settings.captureMode||'auto',available:reading.enabled});
          if(url.pathname==='/panel/reading/settings'&&req.method==='POST'){const body=await readBody(req,2048);collector.configure({captureMode:body.mode});return send(200,{mode:collector.settings.captureMode});}
          if(url.pathname==='/panel/reading/select'&&req.method==='POST'){
            const body=await readBody(req,2048);
            if(reading.view().mode==='codex'&&!desktopPanel)return send(403,{error:'请在 DSH 桌面学习面板选择 Codex 会话。'});
            return send(200,await reading.select(body.id));
          }
          if (url.pathname === '/panel/models/settings' && req.method === 'GET') return send(200, modelSettings(db));
          if (url.pathname === '/panel/models/settings' && req.method === 'POST') return send(200, saveModelSettings(db, await readBody(req, 8192)));
          if (url.pathname === '/panel/audio' && req.method === 'GET') return send(200, audio?.view() || { mode: collector.settings.audioMode, state: 'unavailable', ready: false, pending: 0 });
          if (url.pathname === '/panel/audio/settings' && req.method === 'POST') {
            if (collector.settings.enabled) throw new Error('请先结束采集，再更改内容来源');
            const body = await readBody(req, 4096); collector.configure({ audioMode: body.mode });
            return send(200, { mode: collector.settings.audioMode });
          }
          if (url.pathname === '/panel/models/catalog' && req.method === 'GET') return send(200, modelCatalog);
          if (url.pathname === '/panel/models/catalog/request' && req.method === 'POST') {
            modelCatalog.requestedAt = Date.now(); return send(200, { requested: true });
          }
          if (url.pathname === '/panel/models/catalog' && req.method === 'POST') {
            const body = await readBody(req);
            if (!Array.isArray(body.providers)) throw new Error('模型目录格式错误');
            modelCatalog = { ...modelCatalog, providers: body.providers.map((p) => ({ id: String(p.id), name: String(p.name || p.id),
              models: p.models.map((m) => ({ id: String(m.id), name: String(m.name || m.id) })), ...(p.error ? { error: String(p.error).slice(0, 200) } : {}) })), updatedAt: Date.now() };
            return send(200, { ok: true });
          }
          if (req.method === 'GET' && url.pathname === '/panel/grading/queue') return send(200, { items: gradingQueue(db) });
          const gradingRoute = url.pathname.match(/^\/panel\/grading\/([^/]+)\/(claim|finish)$/);
          if (req.method === 'POST' && gradingRoute) return send(200, gradingRoute[2] === 'claim' ? claimGrading(db, gradingRoute[1]) : finishGrading(db, gradingRoute[1], await readBody(req)));
          const answerAction = url.pathname.match(/^\/panel\/answers\/([^/]+)\/(followup|grade)$/);
          if (req.method === 'POST' && answerAction) {
            if (answerAction[2] === 'followup') replyToFollowup(db, answerAction[1], await readBody(req));
            return send(200, requestGrading(db, answerAction[1]));
          }
          if (req.method === 'POST' && url.pathname === '/panel/subject-presentation/request') {
            return send(200, requestSubjectPresentation(db, (await readBody(req, 2048)).subject));
          }
          if (req.method === 'GET' && url.pathname === '/panel/subject-presentation/queue') {
            return send(200, { items: subjectPresentationQueue(db) });
          }
          const presentationRoute = url.pathname.match(/^\/panel\/subject-presentation\/([^/]+)\/(claim|result)$/);
          if (req.method === 'POST' && presentationRoute) {
            const [, id, action] = presentationRoute;
            return send(200, action === 'claim' ? claimSubjectPresentation(db, id) : finishSubjectPresentation(db, id, await readBody(req, 8192)));
          }
          if(req.method==='GET'&&url.pathname==='/panel/exploration/queue')return send(200,{items:explorationQueue(db)});
          const exploreNode=url.pathname.match(/^\/panel\/research\/nodes\/([^/]+)\/explore$/);
          if(exploreNode&&req.method==='POST')return send(200,requestExploration(db,exploreNode[1],researchView(db)));
          const exploreRoute=url.pathname.match(/^\/panel\/exploration\/([^/]+)(?:\/(claim|result))?$/);
          if(exploreRoute){
            if(req.method==='GET'&&!exploreRoute[2])return send(200,explorationInput(db,exploreRoute[1],researchView(db)));
            if(req.method==='POST'&&exploreRoute[2]==='claim')return send(200,claimExploration(db,exploreRoute[1]));
            if(req.method==='POST'&&exploreRoute[2]==='result')return send(200,finishExploration(db,exploreRoute[1],await readBody(req),researchView(db)));
          }
          if (req.method === 'GET' && url.pathname === '/panel/research/queue') return send(200, { items: researchQueue(db, url.searchParams.get('automatic') !== 'false') });
          const checkpointRoute=url.pathname.match(/^\/panel\/research\/([^/]+)\/checkpoint$/);
          if(checkpointRoute&&req.method==='POST')return send(200,saveResearchCheckpoint(db,checkpointRoute[1],await readBody(req)));
          const researchRequest = url.pathname.match(/^\/panel\/research\/([^/]+)\/request$/);
          if (req.method === 'POST' && researchRequest) return send(200, requestResearch(db, researchRequest[1], await readBody(req)));
          if (req.method === 'GET' && url.pathname === '/panel/research') return send(200, researchView(db, url.searchParams.get('axis')));
          if (req.method === 'POST' && url.pathname === '/panel/research/subject-area') return send(200, assignResearchSubjectArea(db, await readBody(req, 2048)));
          const researchAssessment = url.pathname.match(/^\/panel\/research\/nodes\/([^/]+)\/(assessment|check)$/);
          if (researchAssessment && req.method === 'POST') return send(200, researchAssessment[2] === 'assessment'
            ? assessResearchKnowledge(db, researchAssessment[1], await readBody(req)) : checkResearchKnowledge(db, researchAssessment[1], await readBody(req)));
          if (req.method === 'POST' && url.pathname === '/panel/research/request') {
            const { courseId, foundations } = await readBody(req);
            const session = db.prepare(`SELECT s.id FROM sessions s JOIN contents t ON t.id=s.content_id
              WHERE s.course_id=? ORDER BY EXISTS(SELECT 1 FROM events e WHERE e.type='capture.batch-prepared'
              AND json_extract(e.payload_json,'$.sessionId')=s.id) DESC,s.started_at DESC LIMIT 1`).get(courseId);
            if (!session) throw new Error('这门课尚无可分析的字幕');
            return send(200, requestResearch(db, session.id, { foundations }));
          }
          if (req.method === 'POST' && url.pathname === '/panel/research/confirm') return send(200, confirmResearch(db, (await readBody(req)).key));
          const researchRoute = url.pathname.match(/^\/panel\/research\/([^/]+)$/);
          if (researchRoute && req.method === 'GET') {
            const input=researchInput(db,researchRoute[1],{includeCheckpoint:false}),graph=researchView(db);
            const subjectsWithPresentation = [...subjectPresentationStatus(db)].filter(([, copy]) => copy.presentation).map(([subject]) => subject);
            return send(200,{...input,subjectsWithPresentation,globalGraph:{nodes:graph.nodes.map(({id,subject,title,area,automaticArea})=>({id,subject,title,area:automaticArea??area})),edges:graph.edges.filter(e=>['prerequisite','suggested-prerequisite'].includes(e.kind)).map(({from,to,kind})=>({from,to,kind}))}});
          }
          if (researchRoute && req.method === 'POST') {
            const body = await readBody(req);
            if (body.failed) { researchFailure(db, researchRoute[1], body.key, body.message); return send(200, { ok: true }); }
            return send(200, saveResearch(db, researchRoute[1], body));
          }
          if (req.method === 'POST' && url.pathname === '/panel/generation/worker') {
            const body = await readBody(req);
            if (body.state === 'failed') workerError = String(body.message || '执行器启动失败').slice(0, 500);
            else { workerSeenAt = Date.now(); workerError = null; }
            return send(200, { ok: true });
          }
          if (req.method === 'GET' && url.pathname === '/panel/capture') {
            const reader = reading.view();
            if (reader.mode === 'codex' && !desktopPanel) { reader.candidates = []; reader.target = null; }
            return send(200, { ...collector.view(), reading:reader, audio: audio?.view() || null, desktop: desktop.view(), generation: generationState(db), controls: captureReadiness(db, collector), executor: { lastSeenAt: workerSeenAt, connected: Date.now() - workerSeenAt < 90000, error: workerError } });
          }
          if (req.method === 'GET' && url.pathname === '/panel/generation/queue') return send(200, { items: generationQueue(db) });
          const generationClaim = url.pathname.match(/^\/panel\/generation\/([^/]+)\/claim$/);
          if (req.method === 'POST' && generationClaim) return send(200, claimGeneration(db, generationClaim[1]));
          const generationResult = url.pathname.match(/^\/panel\/generation\/([^/]+)$/);
          if (req.method === 'POST' && generationResult) {
            const body = await readBody(req);
            return send(200, finishGeneration(db, generationResult[1], body.failed, body.token, body));
          }
          const captureActionRoute = url.pathname.match(/^\/panel\/capture\/(start|stop|questions)$/);
          if (req.method === 'POST' && captureActionRoute) {
            if(captureActionRoute[1]==='start'&&collector.settings.captureMode==='codex'&&!desktopPanel)return send(403,{error:'请在 DSH 桌面学习面板开始 Codex 采集。'});
            return send(200, await captureAction(db, collector, captureActionRoute[1], desktop));
          }
          if (req.method === 'POST' && url.pathname === '/panel/capture/config') return send(200, collector.configure(await readBody(req)));
          const captureRetry = url.pathname.match(/^\/panel\/capture\/([^/]+)\/retry$/);
          if (req.method === 'POST' && captureRetry) return send(200, await collector.prepare(captureRetry[1], true));
          if (req.method === 'GET' && url.pathname === '/panel/knowledge') return send(200, knowledgeMap(db, url.searchParams.get('courseId') || null));
          if (req.method === 'POST' && url.pathname === '/panel/knowledge/current') return send(200, setKnowledgeCurrent(db, await readBody(req)));
          const nodeRoute = url.pathname.match(/^\/panel\/knowledge\/([^/]+)\/(assessment|check)$/);
          if (req.method === 'POST' && nodeRoute) {
            const body = await readBody(req);
            return send(200, nodeRoute[2] === 'assessment' ? assessKnowledge(db, nodeRoute[1], body) : checkKnowledge(db, nodeRoute[1], body));
          }
          if (req.method === 'GET' && url.pathname === '/panel/workspace') return send(200, workspaceView(db));
          if (req.method === 'POST' && url.pathname === '/panel/review/start') {
            const body = await readBody(req); return send(200, startReview(db, body.courseId || null));
          }
          const sessionRoute = url.pathname.match(/^\/panel\/sessions\/([^/]+)(?:\/(answer|finish))?$/);
          if (sessionRoute) {
            if (req.method === 'GET' && !sessionRoute[2]) return send(200, sessionView(db, sessionRoute[1]));
            if (req.method === 'POST' && sessionRoute[2] === 'answer') {
              const body = await readBody(req);
              const saved = answerFromPanel(db, sessionRoute[1], body);
              const answer = saved.cards.find((card) => card.id === body.cardId);
              if (answer?.kind === 'subjective' && answer.answer?.status === 'pending-model') requestGrading(db, answer.answer.id);
              return send(200, sessionView(db, sessionRoute[1]));
            }
            if (req.method === 'POST' && sessionRoute[2] === 'finish') return send(200, finishFromPanel(db, sessionRoute[1]));
          }
          const historyRoute = url.pathname.match(/^\/panel\/cards\/([^/]+)\/history$/);
          if (req.method === 'GET' && historyRoute) return send(200, cardHistory(db, historyRoute[1]));
        } catch (err) { return send(400, { error: err.message }); }
      }
      if (req.method === 'POST' && url.pathname === '/sessions') {
        const body = await readBody(req);
        if (!db.prepare('SELECT id FROM courses WHERE id=?').get(body.courseId)) return send(404, { error: 'no such course' });
        return send(201, { sessionId: createSession(db, { courseId: body.courseId }) });
      }
      if (req.method === 'GET' && url.pathname === '/wrong') {
        return send(200, {
          wrong: db
            .prepare(
              `SELECT k.id, k.question, COUNT(*) AS wrongs, MAX(a.created_at) AS last_at
               FROM answers a JOIN cards k ON k.id = a.card_id
               WHERE a.correct = 0 AND k.discarded = 0
               GROUP BY k.id ORDER BY wrongs DESC, last_at DESC LIMIT 20`,
            )
            .all(),
        });
      }
      if (req.method === 'GET' && url.pathname === '/stats') {
        const row = db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM cards WHERE discarded = 0) AS cards,
                    (SELECT COUNT(*) FROM cards WHERE discarded = 1) AS discarded,
                    (SELECT COUNT(*) FROM answers) AS answers,
                    (SELECT COUNT(*) FROM reviews) AS reviews`,
          )
          .get();
        return send(200, row);
      }
      if (req.method === 'GET' && url.pathname === '/xp') {
        return send(200, { xp: xpByAxis(db), level: levelByAxis(db) });
      }

      // 出题工具用：列出某次学习里的段、每段字幕质检结论、是否已出过题
      const segmentsMatch = url.pathname.match(/^\/sessions\/([^/]+)\/segments$/);
      if (req.method === 'GET' && segmentsMatch) {
        const sessionId = segmentsMatch[1];
        const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
        if (!session) return send(404, { error: 'no such session' });
        const source = session.source_id
          ? db.prepare('SELECT quality_json FROM sources WHERE id = ?').get(session.source_id)
          : null;
        let quality = {};
        try {
          quality = source && source.quality_json ? JSON.parse(source.quality_json) : {};
        } catch {
          quality = {};
        }
        const segments = db
          .prepare('SELECT id, seq, text, span_start, span_end, source_kind FROM segments WHERE session_id = ? ORDER BY seq')
          .all(sessionId)
          .map((s) => ({
            id: s.id,
            seq: s.seq,
            sourceKind: s.source_kind,
            chars: s.text.length,
            text: s.text,
            verdict: (quality.segments && quality.segments[s.seq] && quality.segments[s.seq].verdict) || 'unknown',
            quality: (quality.segments && quality.segments[s.seq]) || null,
            warnings: segmentWarnings(s, quality.segments?.[s.seq]),
            cards: db
              .prepare('SELECT COUNT(*) AS n FROM cards WHERE segment_id = ? AND discarded = 0')
              .get(s.id).n,
          }));
        return send(200, { sessionId, segments, overall: quality.overall || null });
      }

      // 主观题盲判：待判列表 + 结果写回
      const lessonMatch = url.pathname.match(/^\/sessions\/([^/]+)\/lesson$/);
      if (lessonMatch) {
        const sessionId = lessonMatch[1];
        const requestedVersion = url.searchParams.get('promptVersion');
        if (req.method === 'GET' && requestedVersion && requestedVersion !== PROMPT_VERSION) {
          return send(409, { error: `outdated generation plugin; reload ${PROMPT_VERSION}` });
        }
        const content = loadContent(db, sessionId);
        if (!content) return send(404, { error: 'no content for session' });
        if (req.method === 'GET') return send(200, { lesson: loadLessonSummary(db, sessionId, url.searchParams.get('promptVersion')) });
        if (req.method === 'POST') {
          const body = await readBody(req);
          try { return send(200, { lesson: saveLessonSummary(db, { ...body, sessionId }) }); }
          catch (err) { return send(400, { error: err.message }); }
        }
      }
      const pendingMatch = url.pathname.match(/^\/sessions\/([^/]+)\/subjective-pending$/);
      if (req.method === 'GET' && pendingMatch) {
        return send(200, { items: pendingSubjective(db, pendingMatch[1]) });
      }
      const gradeMatch = url.pathname.match(/^\/subjective\/([^/]+)\/grade$/);
      const dialogueMatch = url.pathname.match(/^\/subjective\/([^/]+)\/dialogue(?:\/(reply|grade))?$/);
      if (dialogueMatch) {
        try {
          if (req.method === 'GET' && !dialogueMatch[2]) return send(200, dialogueState(db, dialogueMatch[1]));
          if (req.method === 'POST' && dialogueMatch[2]) {
            const body = await readBody(req);
            return send(200, dialogueMatch[2] === 'reply' ? replyToFollowup(db, dialogueMatch[1], body) : saveDialogueGrade(db, dialogueMatch[1], body));
          }
        } catch (err) { return send(409, { error: err.message }); }
      }
      if (req.method === 'POST' && gradeMatch) {
        const body = await readBody(req);
        const card = db.prepare('SELECT k.prompt_version FROM answers a JOIN cards k ON k.id=a.card_id WHERE a.id=?').get(gradeMatch[1]);
        if (card?.prompt_version === 'm1-cards-v7') return send(409, { error: 'use dialogue grading for this answer' });
        const result = applyModelGrade(db, gradeMatch[1], body);
        return send(200, result);
      }

      // 出题工具用：模型产出的原始题目落库（span 校验在服务端做）
      if (req.method === 'POST' && url.pathname === '/cards') {
        const body = await readBody(req);
        if (body.promptVersion !== PROMPT_VERSION) return send(409, { error: `outdated generation plugin; reload ${PROMPT_VERSION}` });
        const content = loadContent(db, body.sessionId);
        if (!content) return send(404, { error: 'no content for session' });
        const summaryEvent = db.prepare("SELECT payload_json FROM events WHERE id=? AND type='lesson.summarized'").get(body.summaryId || '');
        if (!summaryEvent) return send(409, { error: 'lesson summary is required before questions; reload the updated plugin' });
        const lesson = JSON.parse(summaryEvent.payload_json);
        if (lesson.sessionId !== body.sessionId || lesson.contentHash !== contentHash(content.text) || lesson.promptVersion !== body.promptVersion) {
          return send(409, { error: 'lesson summary does not match this content/version' });
        }
        if (!Array.isArray(body.cards) || body.cards.length > 4) return send(400, { error: 'one lesson assessment may contain at most four questions' });
        db.exec('BEGIN IMMEDIATE');
        let result;
        try {
          if (db.prepare('SELECT id FROM events WHERE dedupe_key=?').get(`lesson-assessed:${body.summaryId}`)) {
            db.exec('COMMIT');
            return send(200, { kept: 0, discarded: 0, discardReasons: [], skipped: 'lesson-already-assessed' });
          }
          result = materializeForSession(db, {
          sessionId: body.sessionId,
          content,
          rawCards: body.cards || [],
          model: body.model || 'deepseek-flash',
          promptVersion: body.promptVersion || 'm1-cards-v1',
          assessment: { id: body.summaryId, summary: lesson.summary },
          });
          if (result.kept.length) applyEvent(db, { type: 'assessment.completed',
            dedupeKey: `lesson-assessed:${body.summaryId}`,
            payload: { sessionId: body.sessionId, summaryId: body.summaryId, cardIds: result.kept },
          });
          db.exec('COMMIT');
        } catch (err) { db.exec('ROLLBACK'); throw err; }
        return send(200, {
          kept: result.kept.length,
          discarded: result.discarded.length,
          discardReasons: result.discarded.map((d) => d.reason),
        });
      }

      // 弃权也要留痕（A2 验的是"自动弃权"，不是测试自己造一个事件）
      if (req.method === 'POST' && url.pathname === '/abstain') {
        const body = await readBody(req);
        const res = applyEvent(db, {
          type: 'abstained',
          payload: { sessionId: body.sessionId, segmentId: body.segmentId ?? null, reason: body.reason || 'unspecified' },
          dedupeKey: `abstain:${body.segmentId || body.sessionId}`,
        });
        return send(200, { recorded: !res.deduped });
      }
      if (req.method === 'GET' && url.pathname === '/due') {
        return send(200, {
          due: dueCards(db).map((c) => ({
            id: c.id,
            kind: c.kind,
            question: c.question,
            due_at: c.due_at,
          })),
        });
      }
      if (req.method === 'POST' && url.pathname === '/answer') {
        const body = await readBody(req);
        const result = recordAnswer(db, {
          cardId: body.cardId,
          sessionId: body.sessionId,
          raw: body.raw ?? '',
        });
        return send(200, result);
      }
      if (req.method === 'POST' && url.pathname === '/settle') {
        const body = await readBody(req);
        return send(200, settle(db, body.sessionId));
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(e.code === 'INVALID_STORED_GRADE' ? 409 : 500, { error: e.message, ...(e.code ? { code: e.code } : {}) });
    }
  });

  const captureTimer = setInterval(() => {
    try { collector.tick(); if(reading.selectedForRun)reading.poll().catch(()=>{});else desktop.poll().catch(() => {}); collector.drain().catch(() => {}); } catch { /* 请求接口仍可报告状态。 */ }
  }, 5000);
  captureTimer.unref();
  server.on('close', () => { clearInterval(captureTimer); desktop.stop(); reading.shutdown(); audio?.shutdown(); });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, collector, desktop, audio, reading }));
  });
}

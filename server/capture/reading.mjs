import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { applyEvent } from '../core/events.mjs';
import {EDITOR_SOURCE,isEditorWindow,editorFrame,editorParts} from './editor.mjs';
import {CHATGPT_SOURCE,CHATGPT_ENGINE,CHATGPT_MIN_ANSWER_CHARS,chatIdentity,chatMessages,chatParts,textLength} from './chatgpt.mjs';
import { CODEX_SOURCE, CODEX_ENGINE, listCodexThreads, readCodexThread } from './codex.mjs';
import { upsertCourse, saveSource, createSession, buildContent, attachContent, addSegments, planSegments, updateSourceQuality } from '../core/store.mjs';

const rows=(db,type)=>db.prepare('SELECT payload_json,created_at FROM events WHERE type=? ORDER BY rowid DESC').all(type).map(r=>({...JSON.parse(r.payload_json),at:r.created_at}));
const digest=s=>createHash('sha256').update(s).digest('hex');
const isConversation = mode => mode === 'chatgpt' || mode === 'codex';
const canonical=s=>s.normalize('NFKC').toLowerCase().replace(/\s+/gu,'').replace(/[，,。；;：:！？!?“”"'‘’]/gu,'');
export function readingLines(frame) {
  const lines=(frame.lines||[]).filter(l=>typeof l.text==='string').map(l=>({...l,text:l.text.normalize('NFKC').replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu,'').trim()}))
    .filter(l=>l.text.replace(/\s/g,'').length>=6&&!/^(file|edit|view|tools|help|search|zoom|文件|编辑|查看|工具|帮助|搜索|缩放)$/i.test(l.text));
  // Split horizontal bands at full-width headings; within each band read columns.
  const wide=lines.filter(l=>l.width>frame.width*.68).sort((a,b)=>a.y-b.y),out=[];let from=-Infinity;
  for(const boundary of [...wide,{y:Infinity}]){
    const band=lines.filter(l=>!wide.includes(l)&&l.y>=from&&l.y<boundary.y);
    const left=band.filter(l=>l.x+l.width<frame.width*.58),right=band.filter(l=>l.x>frame.width*.48);
    const columns=left.length>=4&&right.length>=4;
    band.sort((a,b)=>columns?((a.x>frame.width*.48?1:0)-(b.x>frame.width*.48?1:0)||a.y-b.y||a.x-b.x):a.y-b.y||a.x-b.x);
    out.push(...band);if(Number.isFinite(boundary.y))out.push(boundary);from=boundary.y+.01;
  }return out;
}
export class NativeReadingProbe {
  constructor(){this.child=null;this.requests=new Map();this.seq=0;}
  request(action,window){
    if(!this.child){
      const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Mta','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./reading-probe.ps1',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;
      createInterface({input:child.stdout}).on('line',line=>{try{const r=JSON.parse(line),pending=this.requests.get(r.id);if(!pending)return;clearTimeout(pending.timer);this.requests.delete(r.id);r.ok?pending.resolve(r.value):pending.reject(new Error(r.error));}catch{}});
      child.stderr.resume();child.on('error',()=>this.fail('本机阅读识别程序未能启动'));child.on('exit',()=>{if(this.child===child)this.fail('本机阅读识别程序已退出');});
    }
    const id=++this.seq;return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.fail('阅读窗口响应超时，请切回文档后重试。');},15000);timer.unref();
      this.requests.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,action,window})+'\n',error=>{if(error)this.fail('本机阅读识别通道已断开');});
    });
  }
  fail(message){const child=this.child;this.child=null;for(const p of this.requests.values()){clearTimeout(p.timer);p.reject(new Error(message));}this.requests.clear();child?.kill();}
  shutdown(){this.fail('阅读识别已停止');}
}
export class ReadingCapture {
  constructor(db,{enabled=process.platform==='win32',probe=null,now=Date.now,codex={list:listCodexThreads,read:readCodexThread}}={}){
    this.db=db;this.enabled=enabled;this.now=now;this.native=probe?null:new NativeReadingProbe();this.probe=probe||((...args)=>this.native.request(...args));
    this.codex=codex;
    this.running=false;this.selectedForRun=false;this.pending=null;this.candidates=[];this.state=enabled?'idle':'unavailable';this.error=null;this.run=null;this.lastAt=null;this.lastHash=null;this.editorLatest=null;
    const previous=rows(db,'reading.started')[0];
    if(previous&&!rows(db,'reading.finished').some(r=>r.runId===previous.runId)){
      this.run={...previous,frames:rows(db,'reading.frame').filter(r=>r.runId===previous.runId).reverse(),seconds:rows(db,'reading.checkpoint').find(r=>r.runId===previous.runId)?.seconds||0};this.state='interrupted';this.selectedForRun=true;
      this.run.editor=rows(db,'reading.editor-locked').find(r=>r.runId===previous.runId)||null;
      if(isConversation(previous.mode))this.run.chat=rows(db,'reading.chat-locked').find(r=>r.runId===previous.runId)||null;
    }
  }
  view(){const frames=this.run?.frames||[],mode=this.run?.mode,chat=isConversation(mode);return {available:this.enabled,state:this.state,error:this.error,mode:chat?mode:null,target:chat?(this.run.chat?{title:this.run.chat.title,kind:mode}:null):this.run?.window?{id:this.run.window.id,title:this.run.editor?.documentLabel||this.run.window.title,process:this.run.window.process,kind:isEditorWindow(this.run.window)?'editor':'document'}:null,
    candidates:this.candidates.map(({id,title,process,updatedAt})=>({id,title,process,updatedAt})),characters:frames.reduce((n,f)=>n+f.lines.reduce((sum,l)=>sum+textLength(l.text),0),0),frames:frames.length,seconds:this.run?.seconds||0,
    ...(chat?{answerCharacters:frames.flatMap(f=>f.lines).filter(l=>l.role==='assistant').reduce((n,l)=>n+textLength(l.text),0)}:{})};}
  async start(runId,mode='auto'){
    this.selectedForRun=false;
    if(isConversation(mode)){
      const candidates = mode === 'codex' ? await this.codex.list() : [];
      this.run={runId,startedAt:this.now(),mode,frames:[],seconds:0,chat:null};
      applyEvent(this.db,{type:'reading.started',payload:{runId,startedAt:this.run.startedAt,mode},dedupeKey:'reading-start:'+runId});
      this.running=true;this.selectedForRun=true;this.state=mode==='codex'?'codex-select':'chatgpt-waiting';this.error=null;this.lastAt=null;this.candidates=candidates;
      return true;
    }
    if(!this.enabled)return false;
    const listed=await this.probe('list');this.candidates=listed.windows||[];this.error=null;this.lastAt=null;
    const strict=this.candidates.filter(w=>w.strict&&w.rank<(listed.videoRank??9999));
    if(mode==='auto'&&!strict.length){this.native?.shutdown();return false;}
    this.run={runId,startedAt:this.now(),frames:[],seconds:0,window:null};this.running=true;this.selectedForRun=true;this.state='select-window';this.editorLatest=null;
    const choices=mode==='auto'?strict:this.candidates.filter(w=>w.strict);
    if(choices.length===1)this.select(choices[0].id);
    return true;
  }
  select(id){
    if(this.run?.mode==='codex')return this.selectCodex(id);
    if(!this.running||this.run?.window||this.run?.mode==='chatgpt')throw new Error('请先结束本轮采集，再更换阅读窗口。');
    const target=this.candidates.find(w=>w.id===id);if(!target)throw new Error('阅读窗口不存在，请结束后重新开始采集。');
    this.run.window={id:target.id,processId:target.processId,started:target.started,title:target.title,process:target.process,kind:target.kind};this.state='waiting-document';this.lastHash=null;
    applyEvent(this.db,{type:'reading.started',payload:{runId:this.run.runId,startedAt:this.run.startedAt,window:this.run.window},dedupeKey:'reading-start:'+this.run.runId});
    return this.view();
  }
  async selectCodex(id) {
    const run = this.run;
    if (!this.running || run.chat || this.pending) throw new Error('本轮正在读取或已选定会话，请结束后再更换。');
    const target = this.candidates.find(candidate => candidate.id === id);
    if (!target) throw new Error('Codex 会话不在本轮候选列表中。');
    this.state = 'codex-loading';
    this.error = null;
    this.pending = (async () => {
      const lines = await this.codex.read(target.id);
      if (!this.running || this.run !== run) return;
      if (!lines.length) throw new Error('这段 Codex 会话中还没有已完成的回答。');
      const chat = { runId: run.runId, conversationKey: digest(target.id), title: target.title };
      const frame = { runId: run.runId, lines, engine: CODEX_ENGINE, capturedAt: this.now() };
      this.db.exec('BEGIN IMMEDIATE');
      try {
        applyEvent(this.db, { type: 'reading.chat-locked', payload: chat, dedupeKey: 'reading-chat:' + run.runId });
        applyEvent(this.db, { type: 'reading.frame', payload: frame, dedupeKey: 'reading-codex:' + run.runId });
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      run.chat = chat;
      run.frames.push(frame);
      this.candidates = [];
      this.state = 'codex-ready';
    })();
    try { await this.pending; }
    catch (error) {
      if (this.running && this.run === run) {
        this.state = 'codex-select';
        this.error = String(error.message).slice(0, 220);
      }
    } finally { this.pending = null; }
    return this.view();
  }
  editorStatus(){const enabled=Boolean(this.running&&this.selectedForRun&&isEditorWindow(this.run?.window));return {enabled,...(enabled?{runId:this.run.runId,windowId:this.run.window.id}:{})};}
  chatStatus(){
    const enabled=Boolean(this.running&&this.selectedForRun&&this.run?.mode==='chatgpt');
    return enabled?{enabled,runId:this.run.runId}:{enabled};
  }
  receiveChat(body){
    const status=this.chatStatus(),run=this.run;
    if(!status.enabled||body?.runId!==status.runId)return {accepted:false,state:'inactive'};
    const identity=chatIdentity(body),conversationKey=digest(identity.conversationId);
    if(run.chat&&(run.chat.conversationKey!==conversationKey||run.chat.bindingId!==identity.bindingId))return {accepted:false,state:'other-conversation'};
    if(body.action==='bind'){
      if(!run.chat){
        const chat={runId:run.runId,bindingId:identity.bindingId,conversationKey,title:String(body.title||'ChatGPT 对话').replace(/[\r\n\t]/g,' ').trim().slice(0,240)||'ChatGPT 对话'};
        applyEvent(this.db,{type:'reading.chat-locked',payload:chat,dedupeKey:'reading-chat:'+run.runId});
        run.chat=chat;
      }
      this.state='chatgpt-reading';this.lastAt=this.now();
      return {accepted:true,state:this.state};
    }
    if(body.action!=='frame'||!run.chat) return {accepted:false,state:'unbound'};
    const messages=chatMessages(body.messages),old=new Map(run.frames.flatMap(f=>f.lines).map(l=>[l.id,l]));
    const changed=messages.some(l=>old.has(l.id)&&(old.get(l.id).text!==l.text||old.get(l.id).role!==l.role));
    if(changed){this.running=false;this.state='chatgpt-edited';return {accepted:false,state:this.state};}
    const novel=messages.filter(l=>!old.has(l.id)),now=this.now();
    if([...old.values(),...novel].reduce((n,l)=>n+l.text.length,0)>100000){this.running=false;this.state='material-limit';return {accepted:false,state:this.state};}
    if(novel.length){
      const item={runId:run.runId,lines:novel,engine:CHATGPT_ENGINE,capturedAt:now};
      applyEvent(this.db,{type:'reading.frame',payload:item,at:now});run.frames.push(item);
    }
    this.lastAt=now;this.state=messages.length?'chatgpt-reading':'chatgpt-no-messages';
    return {accepted:true,state:this.state};
  }
  async receiveEditor(body){
    const run=this.run;
    if(!this.editorStatus().enabled||body?.runId!==run.runId||body?.windowId!==run.window.id)return {accepted:false};
    if(body.state==='editor-too-large'){this.state='editor-too-large';this.editorLatest=null;return {accepted:false};}
    const frame=editorFrame(body),check=await this.probe('check',run.window);
    if(this.run!==run||!this.running||check.state!=='captured'||check.window?.id!==run.window.id)return {accepted:false};
    // Bind the extension window, document URI hash and document version. Window
    // titles alone are insufficient (dirty markers/custom VS Code title formats).
    if(run.editor&&(frame.clientId!==run.editor.clientId||frame.documentId!==run.editor.documentId)){
      this.editorLatest=null;this.state='document-changed';this.lastAt=null;return {accepted:false};
    }
    if(run.editor&&frame.documentVersion!==run.editor.documentVersion){this.editorLatest=null;this.state='document-edited';this.lastAt=null;return {accepted:false};}
    if(!run.editor){
      const locked={runId:run.runId,clientId:frame.clientId,documentId:frame.documentId,documentVersion:frame.documentVersion,documentLabel:frame.documentLabel,language:frame.language};
      applyEvent(this.db,{type:'reading.editor-locked',payload:locked,dedupeKey:'reading-editor:'+run.runId});run.editor=locked;
    }
    this.editorLatest={...frame,window:check.window,receivedAt:this.now()};return {accepted:true};
  }
  async poll(){
    if(!this.running||!this.run||this.pending)return;
    if(this.run.mode==='codex')return;
    if(this.run.mode==='chatgpt'){
      if(this.run.chat&&this.lastAt!==null&&this.now()-this.lastAt>12000)this.state='chatgpt-paused';
      return;
    }
    this.pending=(async()=>{
      try{
        if(!this.run.window){
          const listed=await this.probe('list');if(!this.running)return;this.candidates=listed.windows||[];
          const strict=this.candidates.filter(w=>w.strict&&w.rank<(listed.videoRank??9999));if(strict.length===1)this.select(strict[0].id);return;
        }
        const editor=isEditorWindow(this.run.window);
        let frame;
        if(editor){
          const check=await this.probe('check',this.run.window);if(!this.running)return;
          if(check.state!=='captured')frame=check;
          else if(this.editorLatest&&this.now()-this.editorLatest.receivedAt<=6000)frame=this.editorLatest;
          else frame={state:['document-changed','document-edited','editor-too-large'].includes(this.state)?this.state:'editor-disconnected'};
        }else frame=await this.probe('capture',this.run.window);
        if(!this.running)return;
        const now=this.now(),elapsed=this.lastAt===null?0:(now-this.lastAt)/1000;this.lastAt=now;this.state=frame.state;this.error=null;
        if(frame.state!=='captured'){this.lastAt=null;return;}
        // The native boundary checks foreground, title and process identity before
        // and after OCR; mocks and future adapters must provide the same identity.
        if(frame.window?.id!==this.run.window.id||(!editor&&frame.window?.title!==this.run.window.title)){this.state='document-changed';this.lastAt=null;return;}
        if(elapsed>=0&&elapsed<=12)this.run.seconds+=elapsed;
        this.state='reading';const lines=editor?frame.lines:readingLines(frame),hash=digest(editor?JSON.stringify(lines):lines.map(l=>canonical(l.text)).join('\n'));
        if(hash===this.lastHash)return;
        const keyOf=l=>editor?JSON.stringify([l.line,l.text]):canonical(l.text);
        const previous=this.run.frames.flatMap(f=>f.lines.map(keyOf)).join('\n'),seen=new Set(this.run.frames.flatMap(f=>f.lines.map(keyOf)));
        const novel=lines.filter(l=>{const key=keyOf(l);if(!key||seen.has(key)||!editor&&key.length>=18&&previous.replace(/\n/g,'').includes(key))return false;seen.add(key);return true;});
        if(!novel.length){this.lastHash=hash;return;}
        if(this.view().characters+novel.reduce((n,l)=>n+l.text.length,0)>100000){this.state='material-limit';this.running=false;return;}
        const item={runId:this.run.runId,lines:novel,width:frame.width,height:frame.height,language:frame.language,engine:frame.engine,capturedAt:now,
          ...(editor?{documentId:frame.documentId,documentLabel:frame.documentLabel,documentVersion:frame.documentVersion}:{})};
        applyEvent(this.db,{type:'reading.frame',payload:item,dedupeKey:'reading-frame:'+this.run.runId+':'+hash,at:now});this.run.frames.push(item);this.lastHash=hash;
        applyEvent(this.db,{type:'reading.checkpoint',payload:{runId:this.run.runId,seconds:this.run.seconds},at:now});
      }catch(error){if(this.running){this.state='failed';this.error=String(error.message).slice(0,220);this.lastAt=null;}}
    })();try{await this.pending;}finally{this.pending=null;}
  }
  async stop(){
    // The extension sends every two seconds; include its final already-verified
    // snapshot even when the five-second capture timer has not fired yet.
    if(this.running&&isEditorWindow(this.run?.window)&&this.editorLatest)await this.poll();
    this.running=false;await this.pending?.catch(()=>{});this.editorLatest=null;this.native?.shutdown();this.candidates=[];
    if(!this.run)return null;
    const previous=rows(this.db,'reading.finished').find(r=>r.runId===this.run.runId);if(previous){this.selectedForRun=false;return previous;}
    const lines=this.run.frames.flatMap(f=>f.lines),characters=lines.reduce((n,l)=>n+l.text.replace(/\s/g,'').length,0);
    const mode=this.run.mode,codex=mode==='codex',chat=isConversation(mode),editor=isEditorWindow(this.run.window);
    const kind=codex?CODEX_SOURCE:chat?CHATGPT_SOURCE:editor?EDITOR_SOURCE:'desktop-ocr';
    const eligibleCharacters=chat?lines.filter(l=>l.role==='assistant').reduce((n,l)=>n+textLength(l.text),0):characters;
    if(eligibleCharacters<(chat?CHATGPT_MIN_ANSWER_CHARS:200)){
      const reason=chat?'本轮采集到 '+eligibleCharacters+' 个回答字符，至少需要 200 个。请打开含已完成回答的对话重新采集。':'仅采集到 '+characters+' 个有效字符，至少需要200字材料；请继续阅读后再试。';
      const result={runId:this.run.runId,characters,reason};applyEvent(this.db,{type:'reading.finished',payload:result,dedupeKey:'reading-finish:'+this.run.runId});this.state='insufficient';this.selectedForRun=false;return result;
    }
    const window=this.run.window,title=chat?this.run.chat.title:editor?this.run.editor.documentLabel:window.title.replace(/\s*[-—|]\s*(Microsoft Edge|Google Chrome|Mozilla Firefox|Adobe Acrobat.*|WPS.*)$/i,'').trim();
    const sourceKey=chat?this.run.chat.conversationKey:digest(editor?window.process+':'+this.run.editor.documentId:window.process+':'+title),jobId=randomUUID();this.db.exec('BEGIN IMMEDIATE');
    try{
      const course=upsertCourse(this.db,{platform:chat?mode:'desktop-reading',externalId:sourceKey,title,axis:'待识别'});
      const quality={verdict:'ok',needsReview:!editor,characters,engine:codex?CODEX_ENGINE:chat?CHATGPT_ENGINE:editor?'vscode-editor-api':'windows-ocr'};
      const sourceId=saveSource(this.db,{courseId:course.id,kind,status:'ok',quality:{overall:quality},detail:JSON.stringify({runId:this.run.runId,windowTitle:title,frames:this.run.frames.map(f=>({at:f.capturedAt,lineCount:f.lines.length,language:f.language})),needsReview:!editor,scope:codex?'recent-completed-turns':chat?'visible-chat-messages':editor?'visible-editor-lines':'visible-window-only',screenshotsStored:false,
        ...(editor?{documentId:this.run.editor.documentId,documentVersion:this.run.editor.documentVersion,language:this.run.editor.language,lineNumbers:lines.map(l=>l.line).sort((a,b)=>a-b)}:{})})});
      const sessionId=createSession(this.db,{courseId:course.id,sourceId,startedAt:this.run.startedAt});
      const content=buildContent({sessionId,sourceKind:kind,parts:chat?chatParts(lines,codex?'Codex':'ChatGPT'):editor?editorParts(this.run.frames):lines.map(l=>({text:l.text}))});attachContent(this.db,sessionId,content);addSegments(this.db,sessionId,content);
      updateSourceQuality(this.db,sourceId,{overall:quality,segments:planSegments(content).map(()=>quality)});
      const job={jobId,source:'reading',sourceKey,kind,title,axis:course.axis,seconds:this.run.seconds,startedAt:this.run.startedAt,endedAt:this.now(),characters};
      applyEvent(this.db,{type:'capture.queued',payload:job,dedupeKey:'capture-close:'+jobId});
      applyEvent(this.db,{type:'capture.imported',payload:{jobId,sessionId,courseId:course.id,sourceKey,sourceKind:kind,characters},dedupeKey:'capture-import:'+jobId});
      const result={runId:this.run.runId,jobId,sessionId,courseId:course.id,characters,seconds:this.run.seconds};applyEvent(this.db,{type:'reading.finished',payload:result,dedupeKey:'reading-finish:'+this.run.runId});
      this.db.exec('COMMIT');this.state='ready';this.selectedForRun=false;return result;
    }catch(error){this.db.exec('ROLLBACK');this.state='failed';this.error='阅读材料未能保存，请再次点击结束采集。';throw error;}
  }
  shutdown(){this.running=false;this.native?.shutdown();}
}

import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {openDb} from '../server/db/open.mjs';import {ReadingCapture} from '../server/capture/reading.mjs';
import {EDITOR_SOURCE,editorFrame,isEditorWindow} from '../server/capture/editor.mjs';
import {Collector,captureJobs} from '../server/capture/collector.mjs';import {captureAction,captureReadiness,generationQueue} from '../server/core/capture-controls.mjs';
import {loadContent,buildContent} from '../server/core/store.mjs';import {isSpanValid} from '../server/core/span.mjs';import {startServer} from '../server/http/server.mjs';
const {visibleContent}=createRequire(import.meta.url)('../vscode-reading/visible-content.cjs');
const window={id:'code42',process:'Code',processId:42,started:'100',title:'example.py - Course - Visual Studio Code',kind:'editor',rank:0,strict:true};
const code=['# Compare values with an explicit threshold instead of relying on their display formatting.',
  'def choose(values):','\tresult = []','\tfor Value in values:','\t\tif Value > 12.5:', '\t\t\tresult.append(Value)', '\t\telse:','\t\t\tresult.append(-Value)', '\treturn result','',
  'def report(values):','    Result = choose(values)','    result = [item for item in Result if item >= 0]','    return result','# The result filters negative values after applying the transformation.'];
const content=(indices=code.map((_,i)=>i))=>({clientId:'client-code',documentId:'a'.repeat(64),documentLabel:'example.py · Course',documentVersion:1,language:'python',state:'captured',lines:indices.map(i=>({line:i+1,text:code[i]}))});
function fixture(){const {db}=openDb(':memory:');let now=10000,nativeState='captured',captures=0;
  const reading=new ReadingCapture(db,{enabled:true,now:()=>now,probe:async action=>{if(action==='capture')captures++;return action==='list'?{windows:[window],videoRank:999}:{state:nativeState,window};}}),collector=new Collector(db);collector.reading=reading;
  return {db,reading,collector,advance(){now+=5000;},native(state){nativeState=state;},get captures(){return captures;},send(body=content()){return reading.receiveEditor({...body,runId:reading.run.runId,windowId:window.id});},close(){reading.shutdown();db.close();}};
}
test('VS Code adapter reads only visible text editor lines, preserves exact syntax and skips folded lines',()=>{
  const requested=[],doc={uri:{scheme:'file',path:'/course/example.py',toString:()=> 'file:///course/example.py'},version:1,languageId:'python',lineAt:i=>{requested.push(i);return {text:code[i]};},getText:()=>{throw Error('must not read whole file');}};
  const editor={document:doc,visibleRanges:[{start:{line:1,character:0},end:{line:4,character:0}},{start:{line:8,character:0},end:{line:10,character:0}}]};
  const vscode={window:{state:{focused:true},activeTextEditor:editor,visibleTextEditors:[editor]},workspace:{getWorkspaceFolder:()=>({name:'Course'})}};
  const frame=visibleContent(vscode);assert.deepEqual(requested,[1,2,3,8,9]);assert.equal(frame.lines[1].text,'\tresult = []');assert.equal(frame.lines.at(-1).text,'');assert.ok(!JSON.stringify(frame).includes('file:///'));
  vscode.window.state.focused=false;assert.equal(visibleContent(vscode),null);vscode.window.state.focused=true;vscode.window.visibleTextEditors=[];assert.equal(visibleContent(vscode),null);
  vscode.window.visibleTextEditors=[editor];doc.uri.scheme='output';assert.equal(visibleContent(vscode),null);
});
test('VS Code code stays case sensitive, position-aware and correctly ordered through save, span validation and generation batching',async()=>{
  const f=fixture();try{
    await captureAction(f.db,f.collector,'start');assert.equal(f.reading.editorStatus().enabled,true);
    assert.equal((await f.send(content([4,5,6,7,8,9,10,11,12,13,14]))).accepted,true);await f.reading.poll();
    const count=f.reading.view().characters;await f.send(content([4,5,6,7,8,9,10,11,12,13,14]));f.advance();await f.reading.poll();assert.equal(f.reading.view().characters,count);
    await f.send(content([0,1,2,3,4,5]));f.advance();await f.reading.poll();
    await captureAction(f.db,f.collector,'stop');assert.equal(f.captures,0);assert.equal(captureReadiness(f.db,f.collector).canGenerate,true);
    const job=captureJobs(f.db)[0],saved=loadContent(f.db,job.sessionId);assert.equal(job.sourceKind,EDITOR_SOURCE);assert.equal(saved.normalizerVersion,2);
    assert.ok(saved.text.includes(code.join('\n')));assert.equal((saved.text.match(/def choose/g)||[]).length,1);assert.ok(saved.text.includes('Result = choose'));assert.ok(saved.text.includes('\n\treturn result\n\n'));
    const quote='\t\t\tresult.append(-Value)',at=saved.text.indexOf(quote);assert.equal(isSpanValid({spanText:quote,spanStart:at,spanEnd:at+quote.length},saved),true);
    await captureAction(f.db,f.collector,'questions');const batch=loadContent(f.db,generationQueue(f.db)[0].sessionId);assert.equal(batch.text,saved.text);assert.equal(batch.normalizerVersion,2);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM cards').get().n,0);
  }finally{f.close();}
});
test('VS Code rejects unselected windows, changed files/versions, stale or paused frames; restart never reads the editor',async()=>{
  const f=fixture();try{
    await captureAction(f.db,f.collector,'start');assert.equal((await f.reading.receiveEditor({...content(),runId:'old',windowId:window.id})).accepted,false);
    f.native('paused');assert.equal((await f.send()).accepted,false);assert.equal(f.reading.view().characters,0);f.native('captured');await f.send();await f.reading.poll();const first=f.reading.view().characters;
    assert.equal((await f.send({...content(),documentId:'b'.repeat(64)})).accepted,false);await f.reading.poll();assert.equal(f.reading.view().state,'document-changed');assert.equal(f.reading.view().characters,first);
    await f.send();await f.reading.poll();assert.equal(f.reading.view().state,'reading');
    await f.send({...content(),documentVersion:2});await f.reading.poll();assert.equal(f.reading.view().state,'document-edited');assert.equal(f.reading.view().characters,first);
    const recovered=new ReadingCapture(f.db,{enabled:true,probe:()=>{throw Error('no read on restart');}});await recovered.poll();assert.equal(recovered.view().state,'interrupted');assert.equal(recovered.editorStatus().enabled,false);
    const result=await recovered.stop();assert.ok(result.sessionId);assert.ok(loadContent(f.db,result.sessionId).text.includes('\tresult = []'));recovered.shutdown();
    f.reading.running=false;assert.equal((await f.send()).accepted,false);
  }finally{f.close();}
});
test('VS Code preserves repeated short lines and gap boundaries without fabricating hidden code; old prose normalization stays v1',async()=>{
  const f=fixture();try{
    await captureAction(f.db,f.collector,'start');const data=content();data.lines=[{line:1,text:'function Example() {'},{line:2,text:'  if (Value) {'},{line:3,text:'    return "Ａ  B";'},{line:4,text:'  }'},{line:5,text:'}'},{line:20,text:'# '+ 'unseen code stays omitted; '.repeat(12)},{line:21,text:'}' }];
    await f.send(data);await f.reading.poll();await f.reading.stop();const saved=loadContent(f.db,captureJobs(f.db)[0].sessionId);assert.ok(saved.text.includes('"Ａ  B"'));assert.equal(saved.text.split('\n').filter(s=>s==='}').length,2);assert.ok(saved.text.includes('行 20–21'));assert.ok(!saved.text.includes('行 1–21'));
    const prose=buildContent({sessionId:'old',sourceKind:'desktop-ocr',parts:[{text:'Ａ  B\n C'}]});assert.equal(prose.normalizerVersion,1);assert.equal(prose.text,'A B C');
  }finally{f.close();}
  assert.ok(isEditorWindow({process:'Code - Insiders'}));assert.throws(()=>editorFrame({...content(),lines:[{line:2,text:'ok'},{line:1,text:'bad'}]}));
});
test('VS Code HTTP bridge requires pairing, rejects browser origins, and cannot accept text after stopping',async()=>{
  const f=fixture(),key='d'.repeat(64),host=await startServer({db:f.db,port:0,readingOptions:{enabled:true,probe:f.reading.probe},editorOptions:{key}}),base='http://127.0.0.1:'+host.port;
  const request=(method='GET',body,headers={})=>fetch(base+'/collector/editor',{method,headers:{authorization:'Bearer '+key,'content-type':'application/json',...headers},body:body?JSON.stringify(body):undefined});
  try{
    assert.equal((await fetch(base+'/collector/editor')).status,401);assert.equal((await request('GET',null,{origin:'http://127.0.0.1:9999'})).status,403);assert.equal((await(await request()).json()).enabled,false);
    await captureAction(f.db,host.collector,'start');const status=await(await request()).json();const body={...content(),runId:status.runId,windowId:status.windowId};
    assert.equal((await(await request('POST',body)).json()).accepted,true);await host.reading.poll();await captureAction(f.db,host.collector,'stop');assert.equal((await(await request('POST',body)).json()).accepted,false);
    assert.equal((await request('POST',{...body,runId:'old'})).status,200);const segment=await(await fetch(base+'/sessions/'+captureJobs(f.db)[0].sessionId+'/segments')).json();assert.ok(segment.segments[0].warnings.some(w=>w.code==='editor-excerpt'));
  }finally{host.server.closeAllConnections();await new Promise(r=>host.server.close(r));f.close();}
});

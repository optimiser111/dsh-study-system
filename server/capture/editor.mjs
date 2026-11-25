import fs from 'node:fs';
import path from 'node:path';
import {getCollectorKey} from './key.mjs';

export const EDITOR_SOURCE='desktop-editor-text';
export const isEditorWindow=window=>window?.kind==='editor'||/^(Code|Code - Insiders|code-insiders)$/i.test(window?.process||'');

export function publishEditorConfig(db,port){
  if(process.platform!=='win32'||![7788,7789].includes(port))return;
  const folder=path.join(process.env.APPDATA,'study-system');fs.mkdirSync(folder,{recursive:true});
  const target=path.join(folder,'vscode-reading-'+port+'.json');
  fs.writeFileSync(target,JSON.stringify({port,key:getCollectorKey(db,true)}),{mode:0o600});
}

export function editorFrame(body){
  if(!body||typeof body.clientId!=='string'||body.clientId.length>80||typeof body.documentId!=='string'||!/^[a-f0-9]{64}$/.test(body.documentId)
    ||typeof body.documentLabel!=='string'||!body.documentLabel.trim()||body.documentLabel.length>300||typeof body.language!=='string'||body.language.length>80
    ||!Number.isInteger(body.documentVersion)||body.documentVersion<1||!Array.isArray(body.lines)||!body.lines.length||body.lines.length>400)throw Error('无效的编辑器片段');
  let characters=0,previous=0;
  const lines=body.lines.map(line=>{
    if(!Number.isInteger(line.line)||line.line<=previous||line.line>10000000||typeof line.text!=='string'||/[\r\n\0]/.test(line.text))throw Error('无效的编辑器行');
    previous=line.line;characters+=line.text.length;if(characters>30000)throw Error('编辑器片段过长');
    return {line:line.line,text:line.text};
  });
  return {clientId:body.clientId,documentId:body.documentId,documentLabel:body.documentLabel,documentVersion:body.documentVersion,
    language:body.language,lines,engine:'vscode-editor-api',state:'captured'};
}

export function editorParts(frames){
  const byLine=new Map();for(const frame of frames)for(const line of frame.lines)byLine.set(line.line,line);
  const ordered=[...byLine.values()].sort((a,b)=>a.line-b.line),groups=[];
  for(const line of ordered){const group=groups.at(-1);if(group&&line.line===group.at(-1).line+1)group.push(line);else groups.push([line]);}
  const meta=frames[0];
  return groups.map(group=>{
    const code=group.map(l=>l.text).join('\n'),ticks='`'.repeat(Math.max(3,...[...code.matchAll(/`+/g)].map(m=>m[0].length+1)));
    return {text:`[VS Code 可见片段 · ${meta.documentLabel} · ${meta.language} · 行 ${group[0].line}–${group.at(-1).line}]\n${ticks}${/^[\w+-]+$/.test(meta.language)?meta.language:''}\n${code}\n${ticks}`};
  });
}

const {createHash}=require('node:crypto');
// visibleRanges describes vertical visibility. Never call getText() without a
// range or read the document from disk. Folded/hidden lines are not expanded.
function visibleContent(vscode) {
  const editor=vscode.window.activeTextEditor;
  if(!vscode.window.state.focused||!editor||!vscode.window.visibleTextEditors.includes(editor))return null;
  const document=editor.document;
  if(!['file','untitled','vscode-remote'].includes(document.uri.scheme))return null;
  const lines=new Map();let characters=0;
  for(const range of editor.visibleRanges){
    const last=range.end.line-(range.end.character===0&&range.end.line>range.start.line?1:0);
    for(let index=range.start.line;index<=last;index++){
      if(lines.has(index))continue;
      // Whole visible lines preserve indentation and include horizontally
      // clipped text; this is intentionally documented as line capture.
      const text=document.lineAt(index).text;
      characters+=text.length;
      if(lines.size>=400||characters>30000)return {state:'editor-too-large'};
      lines.set(index,{line:index+1,text});
    }
  }
  if(!lines.size)return null;
  const label=document.uri.path.split('/').pop()||'Untitled';
  const folder=vscode.workspace.getWorkspaceFolder(document.uri)?.name;
  return {state:'captured',documentId:createHash('sha256').update(document.uri.toString()).digest('hex'),
    documentLabel:folder?label+' · '+folder:label,language:document.languageId,documentVersion:document.version,
    lines:[...lines.values()].sort((a,b)=>a.line-b.line),engine:'vscode-editor-api'};
}
module.exports={visibleContent};

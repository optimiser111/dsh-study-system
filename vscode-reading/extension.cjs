const fs=require('node:fs');const path=require('node:path');const http=require('node:http');const {randomUUID}=require('node:crypto');
const {visibleContent}=require('./visible-content.cjs');
function request(port,key,method,route,body){return new Promise((resolve,reject)=>{
  const data=body?JSON.stringify(body):null;
  const req=http.request({host:'127.0.0.1',port,method,path:route,timeout:1800,
    headers:{authorization:'Bearer '+key,...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{})}},res=>{
      let result='';res.on('data',chunk=>{result+=chunk;if(result.length>16000)req.destroy(Error('Response too large'));});
      res.on('end',()=>{try{if(res.statusCode!==200)throw Error('Local service unavailable');resolve(JSON.parse(result));}catch(e){reject(e);}});
    });req.on('timeout',()=>req.destroy(Error('Local service timeout')));req.on('error',reject);req.end(data);
});}
function activate(context){
  const vscode=require('vscode'),clientId=randomUUID();let busy=false,disposed=false,lastError=null;
  const testPort=context.extensionMode===vscode.ExtensionMode.Test?Number(process.env.STUDY_READING_TEST_PORT):0;
  const ports=Number.isInteger(testPort)&&testPort>0&&testPort<65536?[testPort]:[7788,7789];
  async function tick(){
    if(busy||disposed)return;busy=true;
    try{await Promise.all(ports.map(async port=>{
      try{
        const config=JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,'study-system','vscode-reading-'+port+'.json'),'utf8'));
        if(config.port!==port||typeof config.key!=='string'||!/^[a-f0-9]{64}$/.test(config.key))return;
        const status=await request(port,config.key,'GET','/collector/editor');
        if(disposed||!status.enabled||!vscode.window.state.focused)return;
        const content=visibleContent(vscode);if(!content)return;
        await request(port,config.key,'POST','/collector/editor',{...content,clientId,runId:status.runId,windowId:status.windowId});lastError=null;
      }catch(error){lastError=String(error.message).slice(0,200);/* DSH may be closed. Never start it, show popups or send to a remote host. */}
    }));}finally{busy=false;}
  }
  const timer=setInterval(tick,2000);timer.unref();tick();
  context.subscriptions.push({dispose(){disposed=true;clearInterval(timer);}});
  // Also exposes the same guarded tick to the isolated extension-host test.
  return {tick,status:()=>({lastError,ports,focused:vscode.window.state.focused,extensionMode:context.extensionMode,clientId})};
}
module.exports={activate};

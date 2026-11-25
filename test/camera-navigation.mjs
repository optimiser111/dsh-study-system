import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3 } from 'three';
import { zoomCamera, panCamera, pointerAnchor, updateMapCamera } from '../plugin/camera-navigation.js';
import { panelHarness } from './panel-harness.mjs';
import { m2Fixture } from './m2-fixture.mjs';
import { startServer } from '../server/http/server.mjs';
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-8,`${a} != ${b}`);

test('鼠标定点缩放适用于平移后及各深度，极限处不漂移，反向缩放恢复',()=>{
  const ui=panelHarness(),{projectPoint}=ui.mapMath,origin=[140,-200,80],viewport=[1280,720];
  for(const position of [[600,200,-500],[-300,0,700],[400,-300,300]]){
    const view={yaw:.7,pitch:-.55,zoom:1.2,distance:4000,panX:.12,panY:-.08};
    const before=projectPoint(position,view,origin,.8,viewport),anchor=[before.x/viewport[0],before.y/viewport[1]];
    let next=zoomCamera(view,-180,0,anchor),after=projectPoint(position,next,origin,.8,viewport);
    close(after.x,before.x);close(after.y,before.y);
    const restored=zoomCamera(next,180,0,anchor);close(restored.zoom,view.zoom);close(restored.panX,view.panX);close(restored.panY,view.panY);
    next=zoomCamera({...view,zoom:3.49},-10000,0,anchor);const atLimit=zoomCamera(next,-10000,0,anchor);assert.equal(atLimit,next);
  }
  assert.equal(zoomCamera({zoom:1},-10,1).zoom,zoomCamera({zoom:1},-160).zoom);ui.dispose();
});

test('WebGL与SVG在光标缩放、平移、旋转和不同窗口尺寸下投影一致',()=>{
  const ui=panelHarness(),{projectPoint}=ui.mapMath,camera=new PerspectiveCamera();camera.matrixAutoUpdate=false;camera.matrixWorldAutoUpdate=false;
  const origin=[200,-400,-100],points=[[500,-200,400],[-500,100,-600],[120,-800,160]];
  for(const viewport of [[700,500],[1800,900]]){
    let view={yaw:-.4,pitch:-.65,zoom:1,distance:5000};view=panCamera(view,80,-30,viewport);view=zoomCamera(view,-220,0,[.72,.23]);
    updateMapCamera(camera,view,origin,.7,viewport);
    for(const point of points){const svg=projectPoint(point,view,origin,.7,viewport),gl=new Vector3(point[0],-point[1],-point[2]).project(camera);
      close((gl.x+1)*viewport[0]/2,svg.x);close((1-gl.y)*viewport[1]/2,svg.y);
    }
  }
  ui.dispose();
});

test('指针坐标使用画布而非子标签原点；中键回调平移而不旋转、选点或写学习记录',async()=>{
  assert.deepEqual(pointerAnchor({getBoundingClientRect:()=>({left:100,top:50,width:400,height:200})},{clientX:400,clientY:100}),[.75,.25]);
  const f=m2Fixture(),{server,port}=await startServer({db:f.db,port:0}),ui=panelHarness({base:'http://127.0.0.1:'+port});
  const eventCount=f.db.prepare('SELECT COUNT(*) n FROM events').get().n;
  try{
    await ui.settle();await ui.click('知识树');
    const svg=()=>ui.all(n=>n.type==='svg'&&n.props.ref)[0],dom=svg().props.ref.current;
    dom.getBoundingClientRect=()=>({left:100,top:50,width:920,height:600});
    const nodes=()=>ui.all(n=>n.props['data-knowledge-node']);
    const coords=n=>n.props.transform.match(/translate\(([^,]+),([^\)]+)\)/).slice(1).map(Number);
    const chosen=nodes().find(n=>n.props['data-knowledge-node']==='derivatives'),p=coords(chosen);
    dom.listeners.get('wheel').handler({deltaY:-180,deltaMode:0,clientX:p[0]+100,clientY:p[1]+50,preventDefault(){},stopPropagation(){}});await ui.settle();
    const anchored=coords(nodes().find(n=>n.props['data-knowledge-node']==='derivatives'));close(anchored[0],p[0]);close(anchored[1],p[1]);
    const before=new Map(nodes().map(n=>[n.props['data-knowledge-node'],coords(n)])),selected=ui.all(n=>n.props['aria-label']==='选择知识点')[0].props.value;
    let prevented=false;svg().props.onPointerDown({button:1,pointerId:10,clientX:400,clientY:300,currentTarget:dom,preventDefault(){prevented=true;},stopPropagation(){}});assert.ok(prevented);assert.ok(dom.hasPointerCapture(10));
    svg().props.onPointerMove({pointerId:10,clientX:475,clientY:325,preventDefault(){}});await ui.settle();
    for(const n of nodes()){const old=before.get(n.props['data-knowledge-node']),now=coords(n);close(now[0]-old[0],75);close(now[1]-old[1],25);}
    svg().props.onPointerCancel({pointerId:10,currentTarget:dom});assert.ok(!dom.hasPointerCapture(10));
    nodes()[0].props.onClick();await ui.settle();assert.equal(ui.all(n=>n.props['aria-label']==='选择知识点')[0].props.value,selected);
    let aux=false;svg().props.onAuxClick({button:1,preventDefault(){aux=true;},stopPropagation(){}});assert.ok(aux);
    await ui.click('立体全景');assert.ok(ui.text().includes('ZOOM 100%'));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM events').get().n,eventCount);
  }finally{ui.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));f.db.close();}
});

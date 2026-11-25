import test from 'node:test';
import assert from 'node:assert/strict';
import { panelHarness } from './panel-harness.mjs';
import { subjectArea, directConnections, edgeKey,rootKey,rootEdge } from '../plugin/subject-areas.js';
import {nodeAppearance,UNCONFIRMED_COLOR} from '../plugin/node-appearance.js';

test('立体布局具有非共面体积、稳定顺序、向上先修和纯学科过滤，不改变输入', () => {
  const ui=panelHarness(), {layoutResearchGraph,projectPoint}=ui.mapMath;
  const nodes=Array.from({length:18},(_,i)=>({id:'n'+i,title:'概念'+i,subject:i<9?'语言学':'地理学',status:'assumed',foundationRoot:i%9<3}));
  const edges=nodes.filter((n,i)=>i%9>=3).map(n=>({from:'n'+(Number(n.id.slice(1))-3),to:n.id,kind:'prerequisite'}));
  edges.push({from:'n0',to:'n17',kind:'application'});
  const input={nodes,edges}, snapshot=JSON.stringify(input), graph=layoutResearchGraph(input);
  const positions=graph.nodes.map(n=>n.position), [a,b,c]=positions, sub=(p,q)=>p.map((x,i)=>x-q[i]);
  const u=sub(b,a),v=sub(c,a),normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
  assert.ok(positions.some(p=>Math.abs(sub(p,a).reduce((s,x,i)=>s+x*normal[i],0))>100),'节点不能共面');
  assert.ok(Math.max(...positions.map(p=>p[2]))-Math.min(...positions.map(p=>p[2]))>150);
  for(const e of graph.edges.filter(e=>e.kind==='prerequisite')) assert.ok(graph.nodes.find(n=>n.id===e.to).position[1]<graph.nodes.find(n=>n.id===e.from).position[1]);
  const selected=layoutResearchGraph(input,'语言学');assert.equal(selected.nodes.length,9);assert.ok(selected.nodes.every(n=>n.subject==='语言学'));
  assert.ok(selected.edges.every(e=>selected.nodes.some(n=>n.id===e.from)&&selected.nodes.some(n=>n.id===e.to)));
  const reverse=layoutResearchGraph({nodes:[...nodes].reverse(),edges:[...edges].reverse()});
  for(const n of graph.nodes) assert.deepEqual(n.position,reverse.nodes.find(p=>p.id===n.id).position);
  assert.notDeepEqual(projectPoint(positions[0],{yaw:0,pitch:0,zoom:1}),projectPoint(positions[0],{yaw:1,pitch:.7,zoom:1}));
  assert.equal(JSON.stringify(input),snapshot);ui.dispose();
});

test('大类区域有实际间隔，区内保留学科根系、跨区连线；分区筛选不改学科',()=>{
  const ui=panelHarness(),{layoutResearchGraph}=ui.mapMath;
  const names=['math','统计学','心理学','经济学','播音与主持艺术','语音学','医学','教育技术学'];
  const nodes=names.map((subject,i)=>({id:'n'+i,subject,title:subject,status:'encountered'}));
  const edges=[{from:'n0',to:'n2',kind:'application'},{from:'n4',to:'n6',kind:'connection'}];
  const data=layoutResearchGraph({nodes,edges});assert.equal(data.areas.length,4);
  const root=id=>data.roots.find(r=>r.subject===id);
  assert.equal(root('math').area,'formal');assert.equal(root('心理学').area,'social');
  assert.equal(root('教育技术学').area,'social');assert.equal(root('播音与主持艺术').area,'humanities');
  const gap=(a,b)=>Math.hypot(a.position[0]-b.position[0],a.position[2]-b.position[2]);
  assert.ok(gap(root('math'),root('心理学'))>gap(root('math'),root('统计学'))*2);
  for(const a of data.areas)for(const b of data.areas)if(a!==b)assert.ok(gap(a,b)>a.radius+b.radius+100,'大类边界不能重叠');
  assert.equal(data.edges.length,2);
  const social=layoutResearchGraph({nodes,edges},'','social');assert.deepEqual(new Set(social.nodes.map(n=>n.subject)),new Set(['心理学','经济学','教育技术学']));
  assert.equal(layoutResearchGraph({nodes,edges},'心理学').nodes.length,1);
  assert.equal(subjectArea('未列出的交叉方向','engineering').id,'engineering');
  assert.equal(subjectArea('未列出的交叉方向','not-a-category').id,'unclassified');
  assert.equal(subjectArea('心理学','formal').id,'social');ui.dispose();
  assert.equal(subjectArea('信号处理','unclassified').id,'engineering');
});

test('点击高亮仅包含直接入边和出边、全部关系类型，排除二跳；孤点只高亮自身',()=>{
  const nodes=['a','b','c','d','isolated'].map(id=>({id})),edges=[
    {from:'a',to:'b',kind:'prerequisite'},{from:'b',to:'c',kind:'connection'},{from:'d',to:'a',kind:'application'},
    {from:'a',to:'b',kind:'suggested-prerequisite'}];
  const before=JSON.stringify({nodes,edges}),h=directConnections(nodes,edges,'a');
  assert.deepEqual(h.nodes,new Set(['a','b','d']));assert.equal(h.edges.size,3);assert.ok(!h.edges.has(edgeKey(edges[1])));
  assert.deepEqual(directConnections(nodes,edges,'isolated').nodes,new Set(['isolated']));
  assert.equal(directConnections(nodes,edges,null),null);assert.equal(directConnections(nodes,edges,'missing'),null);
  assert.equal(JSON.stringify({nodes,edges}),before);
});

test('初次及深挖的未确认前置为灰色无光晕，选择/当前定位/根标记不能当作掌握证据',()=>{
  for(const status of ['unseen','assumed'])for(const origin of ['course-map','node-exploration','catalog-prerequisite']){
    const node={status,origin,isCurrent:true,foundationRoot:true,tone:'#ff6600'},before=JSON.stringify(node),style=nodeAppearance(node);
    assert.equal(style.color,UNCONFIRMED_COLOR);assert.equal(style.glow,false);assert.equal(JSON.stringify(node),before);
  }
  for(const status of ['encountered','evidence','checked','self-confirmed','needs-review']){const style=nodeAppearance({status,tone:'#6ce7c2'});assert.equal(style.pending,false);assert.equal(style.color,'#6ce7c2');assert.equal(style.glow,true);}
});

test('根系点击只高亮根的直接节点和根连线，排除子孙和其他根；节点点击也能标出直接相连根',()=>{
  const nodes=['a','b','c','x'].map(id=>({id})),edges=[{from:'a',to:'b',kind:'prerequisite'},{from:'b',to:'c',kind:'prerequisite'}],roots=[{subject:'数学',children:['a']},{subject:'物理',children:['x']}];
  const snapshot=JSON.stringify({nodes,edges,roots}),highlight=directConnections(nodes,edges,rootKey(roots[0]),roots);
  assert.equal(highlight.rootSelected,true);assert.deepEqual(highlight.nodes,new Set(['a']));assert.deepEqual(highlight.roots,new Set(['root:数学']));assert.deepEqual(highlight.edges,new Set([edgeKey(rootEdge(roots[0],'a'))]));
  const selected=directConnections(nodes,edges,'a',roots);assert.deepEqual(selected.nodes,new Set(['a','b']));assert.ok(selected.roots.has('root:数学'));assert.ok(!selected.nodes.has('c'));assert.equal(JSON.stringify({nodes,edges,roots}),snapshot);
});

test('深挖新增前置后自动重排基础在下，跨科全局层级在单学科筛选时保留',()=>{
  const ui=panelHarness(),layout=ui.mapMath.layoutResearchGraph;
  const nodes=[{id:'target',title:'高级方法',subject:'人工智能',status:'encountered'},{id:'middle',title:'中间基础',subject:'math',status:'assumed'},{id:'base',title:'基础',subject:'math',status:'unseen'},{id:'other',title:'其他分支',subject:'历史学',status:'self-confirmed'}];
  const edges=[{from:'base',to:'middle',kind:'prerequisite'}],before=layout({nodes,edges});
  const expanded={nodes:[...nodes,{id:'primitive',title:'更深基础',subject:'math',status:'unseen'}],edges:[...edges,{from:'primitive',to:'base',kind:'suggested-prerequisite'},{from:'middle',to:'target',kind:'suggested-prerequisite'}]},after=layout(expanded);
  const y=(data,id)=>data.nodes.find(n=>n.id===id).position[1];
  assert.ok(y(after,'primitive')>y(after,'base'));assert.ok(y(after,'base')>y(after,'middle'));assert.ok(y(after,'middle')>y(after,'target'));assert.ok(y(after,'target')<y(before,'target'));
  assert.equal(y(layout(expanded,'人工智能'),'target'),y(after,'target'));assert.equal(y(layout(expanded,'math'),'middle'),y(after,'middle'));assert.equal(after.nodes.find(n=>n.id==='other').status,'self-confirmed');
  const mathRoot=after.roots.find(r=>r.subject==='math');assert.deepEqual(mathRoot.children,['primitive']);ui.dispose();
});

import { createKnowledgeScene } from './knowledge-scene.js';
import { SUBJECT_AREAS, subjectArea, directConnections, edgeKey,rootKey,rootEdge } from './subject-areas.js';
import { nodeAppearance,UNCONFIRMED_COLOR } from './node-appearance.js';
import { zoomCamera, panCamera, pointerAnchor } from './camera-navigation.js';
import { subjectTheme } from './subject-presentation.js';
window.__ModuleLoader__.load({
  id: 'dsh-study-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    let BASE = 'http://127.0.0.1:7788';
    try { if (localStorage.getItem('study.m2.validation') === 'true') BASE = 'http://127.0.0.1:7789'; } catch { /* 默认正式服务 */ }
    let openConversation = null;
    let hostConnection = null;
    let startupRequest = null, startupRetryAt = 0;
    async function ensureService(base) {
      if (startupRequest) return startupRequest;
      if (Date.now() < startupRetryAt) throw new Error('正在恢复本地学习服务，请稍候。');
      startupRequest = (async () => {
        if (!hostConnection?.rpc?.call) throw new Error('DSH宿主连接尚未就绪，请稍候重试。');
        let timer;let response;
        try{response=await Promise.race([hostConnection.rpc.call('/study-services','start',{port:base.slice(-4)}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('恢复本地学习服务超时，请稍后刷新。')),15000);})]);}finally{clearTimeout(timer);}
        if (!response.ok) throw new Error(response.error?.message || '自动启动未成功，请检查学习插件是否已加载。');
      })().catch((error) => { startupRetryAt = Date.now() + 10000; throw error; })
        .finally(() => { startupRequest = null; });
      return startupRequest;
    }
    const saved = (key, fallback = '') => { try { return localStorage.getItem('study.m2.' + BASE.slice(-4) + '.' + key) || fallback; } catch { return fallback; } };
    const persist = (key, value) => { try { localStorage.setItem('study.m2.' + BASE.slice(-4) + '.' + key, value); } catch { /* 服务端记录仍然可恢复 */ } };
    async function api(path, body, base = BASE, signal) {
      const options = body === undefined ? { cache: 'no-store' } : {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      };
      const request=async()=>{
        const deadline=AbortSignal.timeout(12000),requestSignal=signal?AbortSignal.any([signal,deadline]):deadline;
        try{
          const response=await fetch(base+path,{...options,signal:requestSignal});
          const value=await response.json();if(!response.ok)throw new Error(value.error||'请求失败：'+response.status);return value;
        }catch(error){if(deadline.aborted&&!signal?.aborted)throw new Error('本地学习服务响应超时，请刷新查看状态。');throw error;}
      };
      try { return await request(); }
      catch(error) {
        if(signal?.aborted||error.name!=='TypeError')throw error;
        await ensureService(base);
        return request();
      }
    }
    function useRemote(path, revision) {
      const [state, setState] = React.useState({ loading: !!path });
      const base=BASE;
      React.useEffect(() => {
        if (!path) { setState({ loading: false }); return; }
        let alive = true, latest = 0,inFlight=false;
        const controller=new AbortController();
        const pull = async () => {
          if(!alive||inFlight)return;inFlight=true;
          const sequence = ++latest;
          try { const data = await api(path, undefined, base,controller.signal); if (alive && sequence === latest) setState({ loading: false, data, base, path }); }
          catch (error) { if (alive && sequence === latest) setState((old) => ({ ...(old.base === base && old.path === path ? old : {}), base, path, loading: false, error: error.message })); }
          finally{inFlight=false;}
        };
        pull(); const timer = setInterval(pull, 5000);
        return () => { alive = false;controller.abort(); clearInterval(timer); };
      }, [path, revision,base]);
      return state.base === BASE && state.path === path ? state : { loading: !!path };
    }
    const box = { border: '1px solid var(--dsw-alias-border,rgba(128,128,128,.28))', borderRadius: 10, padding: 16, marginBottom: 14 };
    const muted = { opacity: .65, fontSize: 12, lineHeight: 1.6 };
    const btn = { padding: '8px 12px', borderRadius: 7, border: '1px solid var(--dsw-alias-border,rgba(128,128,128,.35))', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' };
    const heading = { fontWeight: 600, marginBottom: 12 };
    const statusNames = { 'pending-model': '待判卷', 'awaiting-followup': '待补充', passed: '通过', failed: '未通过', 'insufficient-evidence': '本次证据不足', 'audit-required': '历史记录需核对', correct: '答对', wrong: '答错' };
    const time = (value) => value ? new Date(value).toLocaleString('zh-CN') : '—';
    const button = (label, action, disabled = false, extra = {}) => {
      const { key, ...style } = extra;
      return h('button', { key, type: 'button', onClick: action, disabled, style: { ...btn, opacity: disabled ? .45 : 1, ...style } }, label);
    };

    function AnswerView({ answer }) {
      if (!answer) return null;
      return h('div', { style: { ...box, marginTop: 14, background: 'rgba(128,128,128,.06)' } },
        h('div', { style: heading }, statusNames[answer.status] || answer.status,
          answer.status === 'passed' && answer.independent === false ? ' · 追问后通过' : ''),
        h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.7 } }, '原答：' + answer.raw),
        answer.correctAnswer ? h('div', { style: muted }, '正确选项：' + answer.correctAnswer) : null,
        answer.recognized ? h('p', null, '已体现：' + answer.recognized) : null,
        answer.followup ? h('p', { style: { fontWeight: 600 } }, '追问：' + answer.followup) : null,
        (answer.replies || []).map((r) => h('div', { key: r.turn, style: { marginTop: 10, whiteSpace: 'pre-wrap' } },
          h('div', { style: muted }, r.question), h('div', null, '补答：' + r.raw))),
        answer.note ? h('p', { style: muted }, answer.note) : null,
        h('div', { style: muted }, time(answer.at)));
    }
    function Card({ card, sessionId, busy, closed, submit, reply, retryGrade, history }) {
      const draftKey = 'draft.' + sessionId + '.' + card.id;
      const [draft, setDraft] = React.useState(() => saved(draftKey));
      const answer = card.answer;
      const replyKey = 'followup.' + (answer?.id || card.id) + '.' + (answer?.nextTurn || 0);
      const [replyDraft, setReplyDraft] = React.useState(() => saved(replyKey));
      React.useEffect(() => { setReplyDraft(saved(replyKey)); }, [replyKey]);
      const choose = (value) => { setDraft(value); persist(draftKey, value); };
      return h('div', { style: box },
        h('div', { style: muted }, card.kind === 'objective' ? '客观题 · 程序判分' : '主观题 · 自己的话或正确例子均可'),
        h('p', { style: { fontSize: 16, lineHeight: 1.8, whiteSpace: 'pre-wrap' } }, card.question),
        card.kind === 'objective' ? h('div', { role: 'radiogroup', 'aria-label': '选择答案' }, card.options.map((option, index) => {
          const letter = String.fromCharCode(65 + index), selected = (answer ? answer.raw : draft) === letter;
          return h('label', { key: letter, style: { ...btn, display: 'flex', gap: 10, marginBottom: 8, lineHeight: 1.6, background: selected ? 'rgba(128,128,128,.14)' : 'transparent' } },
            h('input', { type: 'radio', name: 'answer-' + sessionId + '-' + card.id, value: letter, checked: selected, disabled: !!answer || busy || closed, onChange: () => choose(letter) }),
            h('span', null, letter + '. ' + option));
        })) : !answer && !closed ? h('textarea', { 'aria-label': '你的解释', value: draft, onChange: (e) => choose(e.target.value), disabled: busy, rows: 5,
          placeholder: '用自己的话解释，或举一个例子。', style: { width: '100%', boxSizing: 'border-box', padding: 12, background: 'transparent', color: 'inherit', border: btn.border, borderRadius: 8, font: 'inherit', lineHeight: 1.7 } }) : null,
        !answer && !closed ? button(busy ? '正在保存…' : '提交回答', async () => { if (await submit(card.id, draft)) persist(draftKey, ''); }, busy || !draft.trim()) : null,
        !answer && closed ? h('p', { style: muted }, '此会话已结束，未答题目仅供查看。') : null,
        h(AnswerView, { answer }),
        answer?.status === 'pending-model' ? h('div', null,
          h('p', { role: 'status', style: muted }, answer.grading?.state === 'failed' ? '自动判卷未完成，回答已保存。' : answer.grading?.state === 'processing' ? '模型正在判卷，结果会自动更新。' : '回答已保存，等待后台自动判卷。'),
          !answer.grading || answer.grading.state === 'failed' ? button('重新判卷', () => retryGrade(answer.id), busy) : null) : null,
        answer?.status === 'awaiting-followup' ? h('div', null,
          h('textarea', { 'aria-label': '补充回答', value: replyDraft, rows: 4, disabled: busy,
            onChange: (event) => { setReplyDraft(event.target.value); persist(replyKey, event.target.value); },
            placeholder: '针对追问补充你的解释。', style: { ...btn, width: '100%', lineHeight: 1.7 } }),
          button('提交补答', async () => { if (await reply(answer.id, answer.nextTurn, replyDraft)) { setReplyDraft(''); persist(replyKey, ''); } }, busy || !replyDraft.trim())) : null,
        answer ? button('查看本题历史', () => history(card.id), busy, { marginLeft: 8 }) : null);
    }

    // 真实三维坐标经相机旋转、透视投影到SVG；标签不随世界旋转，保持可读。
    const mapStatus = { unseen: ['未学习', UNCONFIRMED_COLOR], assumed: ['推测具备·待确认', UNCONFIRMED_COLOR], encountered: ['课程已接触', '#779bff'], evidence: ['有作答证据', '#33e7f2'], checked: ['单题自检通过', '#6ce7c2'], 'self-confirmed': ['自评已掌握', '#b4ec7a'], 'needs-review': ['需要补习/复核', '#ff668e'] };
    const homeCamera = { yaw: -.36, pitch: -.18, zoom: 1 };
    function projectPoint(position, camera, origin = [0, 0, 0], fit = 1, viewport = [920, 600]) {
      const [x, y, z] = position.map((value, i) => value - origin[i]);
      const a = x * Math.cos(camera.yaw) + z * Math.sin(camera.yaw);
      const b = -x * Math.sin(camera.yaw) + z * Math.cos(camera.yaw);
      const vertical = y * Math.cos(camera.pitch) - b * Math.sin(camera.pitch);
      const depth = y * Math.sin(camera.pitch) + b * Math.cos(camera.pitch);
      const distance = camera.distance || 900;
      const scale = distance / Math.max(distance * .25, distance + depth) * camera.zoom * fit;
      return { x: viewport[0] * (.5 + (camera.panX || 0)) + a * scale, y: viewport[1] * (.5 + (camera.panY || 0)) + vertical * scale, depth, scale };
    }
    function neighborhood(nodes, currentId, futureDepth, full) {
      if (full || !currentId) return nodes;
      const ids = new Set([currentId]);
      let queue = [currentId];
      for (let step = 0; step < 2; step++) {
        queue = nodes.filter((n) => queue.some((id) => nodes.find((p) => p.id === id)?.prerequisites.includes(n.id))).map((n) => n.id);
        queue.forEach((id) => ids.add(id));
      }
      queue = [currentId];
      for (let step = 0; step < futureDepth; step++) {
        queue = nodes.filter((n) => n.prerequisites.some((id) => queue.includes(id))).map((n) => n.id);
        queue.forEach((id) => ids.add(id));
      }
      for (const node of nodes.filter((n) => ids.has(n.id))) node.prerequisites.forEach((id) => ids.add(id));
      return nodes.filter((n) => ids.has(n.id));
    }
    function layoutLabels(nodes, selectedId, zoom = 1, viewport = [920, 600]) {
      const placed = [], result = new Map();
      const ordered = nodes.filter((n) => n.screen.x >= 0 && n.screen.x <= viewport[0] && n.screen.y >= 0 && n.screen.y <= viewport[1] - 20).sort((a,b) => (b.id === selectedId ? 100 : b.isCurrent ? 90 : 0) - (a.id === selectedId ? 100 : a.isCurrent ? 90 : 0));
      for (const node of ordered) {
        const font = (node.id === selectedId || node.isCurrent ? 13 : 11) * Math.max(.85, Math.min(1.35, Math.sqrt(zoom) * Math.sqrt(node.screen.scale)));
        const display = node.title.length > 24 ? node.title.slice(0,23)+'…' : node.title;
        const lines = display.match(/.{1,8}/gu) || [display];
        const step = Math.ceil(font*1.25), width = Math.max(...lines.map((line) => line.length)) * font + 4, height = lines.length * step;
        const p = node.screen;
        const options = [[18,-8],[-width-18,-8],[14,-height-15],[-width-14,-height-15],[-width/2,20],[-width/2,-height-18],[30,16],[-width-30,16]];
        let best = null;
        for (const [dx,dy] of options) {
          const box = { x: Math.max(12,Math.min(viewport[0]-12-width,p.x+dx)), y: Math.max(20,Math.min(viewport[1]-26-height,p.y+dy)), width, height, lines, font, step };
          const overlap = placed.reduce((sum,r) => sum + Math.max(0,Math.min(box.x+width+4,r.x+r.width)-Math.max(box.x-4,r.x)) * Math.max(0,Math.min(box.y+height+3,r.y+r.height)-Math.max(box.y-3,r.y)),0);
          const hits = nodes.filter((n) => n.id !== node.id && n.screen.x > box.x-11 && n.screen.x < box.x+width+11 && n.screen.y > box.y-11 && n.screen.y < box.y+height+11).length;
          const score = overlap*2 + hits*500 + Math.abs(dx)*.05 + Math.abs(dy)*.1;
          if (!best || score < best.score) best = { ...box, score };
        }
        placed.push(best); result.set(node.id,best);
      }
      return result;
    }
    function KnowledgeMap({ data, busy, assess, locate, check, openSession, explore, assignArea }) {
      const mapHome = data.areas?.length > 1 ? {...homeCamera,pitch:-.62} : homeCamera;
      const [selection, setSelection] = React.useState(data.current?.nodeId || data.nodes[0]?.id);
      const [emphasis, setEmphasis] = React.useState(null);
      const [full, setFull] = React.useState(true);
      const [future, setFuture] = React.useState(2);
      const [camera, setCamera] = React.useState({ ...mapHome });
      const [center, setCenter] = React.useState(null);
      const [testing, setTesting] = React.useState(false);
      const [choice, setChoice] = React.useState('');
      const [fullscreen, setFullscreen] = React.useState(false);
      const [viewport, setViewport] = React.useState([920, 600]);
      const root = React.useRef(null), surface = React.useRef(null), drag = React.useRef(null), suppress = React.useRef(false);
      const sceneHost = React.useRef(null), scene = React.useRef(null);
      const [webgl, setWebgl] = React.useState(false);
      const [sceneError, setSceneError] = React.useState('');
      const [orbit, setOrbit] = React.useState(false);
      React.useEffect(() => {
        if (!orbit) return;
        let previous = Date.now();
        const timer=setInterval(()=>{
          const now=Date.now(),elapsed=Math.min(100,now-previous);previous=now;
          if(typeof document!=='undefined'&&document.hidden)return;
          setCamera(old=>({...old,yaw:old.yaw+elapsed*.00012}));
        },50);
        return ()=>clearInterval(timer);
      }, [orbit]);
      React.useEffect(() => {
        try {
          scene.current = createKnowledgeScene(sceneHost.current, () => { setWebgl(false); setSceneError('三维渲染上下文已中断，正在显示兼容视图。'); });
          if (scene.current) setWebgl(true);
        } catch { setSceneError('当前设备未能启用WebGL，正在显示兼容视图。'); }
        return () => { scene.current?.dispose(); scene.current = null; };
      }, []);
      const overlay = React.useRef(false);
      React.useEffect(() => {
        if (typeof document === 'undefined') return;
        const sync = () => { if (!overlay.current) setFullscreen(document.fullscreenElement === root.current); };
        const escape = (event) => { if (event.key === 'Escape' && overlay.current) { event.preventDefault?.(); event.stopPropagation?.(); overlay.current = false; setFullscreen(false); } };
        document.addEventListener('fullscreenchange', sync);
        document.addEventListener('keydown', escape);
        return () => { document.removeEventListener('fullscreenchange', sync); document.removeEventListener('keydown', escape); };
      }, []);
      React.useEffect(() => {
        const element = surface.current;
        if (!element || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(([entry]) => {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) setViewport((old) => Math.abs(old[0]-width) < 1 && Math.abs(old[1]-height) < 1 ? old : [width, height]);
        });
        observer.observe(element); return () => observer.disconnect();
      }, []);
      const toggleFullscreen = async () => {
        if (fullscreen) {
          if (typeof document !== 'undefined' && document.fullscreenElement === root.current) await document.exitFullscreen();
          overlay.current = false; setFullscreen(false); return;
        }
        try {
          if (!root.current?.requestFullscreen) throw new Error('fullscreen unavailable');
          await root.current.requestFullscreen(); setFullscreen(true);
        } catch { overlay.current = true; setFullscreen(true); }
      };
      React.useEffect(() => { setEmphasis(null); setCamera({ ...mapHome }); setCenter(null); setSelection(data.current?.nodeId || data.nodes[0]?.id); if(data.researched)setFull(true); }, [data.current?.nodeId]);
      React.useEffect(() => { setTesting(false); setChoice(''); }, [selection]);
      React.useEffect(() => {
        const element = surface.current;
        if (!element) return;
        const wheel = (event) => {
          event.preventDefault(); event.stopPropagation(); setOrbit(false);
          const anchor=pointerAnchor(element,event);
          setCamera(old=>zoomCamera(old,event.deltaY,event.deltaMode,anchor));
        };
        element.addEventListener('wheel', wheel, { passive: false });
        return () => element.removeEventListener('wheel', wheel);
      }, []);
      const selectedNode = data.nodes.find((n) => n.id === selection) || data.nodes[0];
      const topology=JSON.stringify([data.nodes.map(n=>[n.id,n.position]),data.edges.map(e=>[e.from,e.to,e.kind])]),previousTopology=React.useRef(topology);
      React.useEffect(()=>{
        if(previousTopology.current!==topology){setCenter(null);setFull(true);setCamera(old=>({...old,zoom:Math.min(old.zoom,1),panX:0,panY:0}));}
        previousTopology.current=topology;
      },[topology]);
      const visible = neighborhood(data.nodes, center || data.current?.nodeId, future, full);
      const boundsNodes = [...visible, ...(data.roots || []), ...(data.areas || []).flatMap(a=>[[-a.radius,0],[a.radius,0],[0,-a.radius],[0,a.radius]].map(([x,z])=>({position:[a.position[0]+x,a.position[1],a.position[2]+z]})))];
      const extent = [0,1,2].map(axis=>(Math.max(...boundsNodes.map(n=>n.position[axis]))-Math.min(...boundsNodes.map(n=>n.position[axis])))/2);
      const distance = Math.max(900,Math.hypot(...extent)*2.2);
      const view = {...camera,distance}, homeView = {...mapHome,distance};
      const panoramaCenter = [0,1,2].map((axis) => (Math.min(...boundsNodes.map((n) => n.position[axis])) + Math.max(...boundsNodes.map((n) => n.position[axis]))) / 2);
      // Center the projected volume, not only its world-space bounding box.
      // Perspective otherwise leaves a large empty strip above a tall tower.
      for (let step=0;step<4;step++) {
        const points=boundsNodes.map(n=>projectPoint(n.position,homeView,panoramaCenter,1,viewport));
        const scale=points.reduce((sum,p)=>sum+p.scale,0)/points.length;
        const dx=(Math.min(...points.map(p=>p.x))+Math.max(...points.map(p=>p.x))-viewport[0])/(2*scale);
        const dy=(Math.min(...points.map(p=>p.y))+Math.max(...points.map(p=>p.y))-viewport[1])/(2*scale);
        panoramaCenter[0]+=dx*Math.cos(mapHome.yaw)+dy*Math.sin(mapHome.pitch)*Math.sin(mapHome.yaw);
        panoramaCenter[1]+=dy*Math.cos(mapHome.pitch);
        panoramaCenter[2]+=dx*Math.sin(mapHome.yaw)-dy*Math.sin(mapHome.pitch)*Math.cos(mapHome.yaw);
      }
      const origin = center ? data.nodes.find((n) => n.id === center)?.position || [0,0,0] : full || !data.current ? panoramaCenter : data.nodes.find((n) => n.id === data.current.nodeId)?.position || [0,0,0];
      const bound = boundsNodes.map((n) => projectPoint(n.position, homeView, origin, 1, viewport));
      const fit = Math.min(1.5, Math.max(80, viewport[0]/2-85) / Math.max(200, ...bound.map((p) => Math.abs(p.x - viewport[0]/2))), Math.max(80, viewport[1]/2-55) / Math.max(180, ...bound.map((p) => Math.abs(p.y - viewport[1]/2))));
      const projected = visible.map((n) => ({ ...n, screen: projectPoint(n.position, view, origin, fit, viewport) })).sort((a, b) => b.screen.depth - a.screen.depth);
      const highlight = directConnections(data.nodes,data.edges,emphasis,data.roots||[]);
      React.useEffect(() => { scene.current?.update({ nodes: visible, edges: data.edges, roots: data.roots, areas:data.areas, emphasis, selected: selectedNode.id, camera:view, origin, fit, viewport }); }, [data, camera, center, full, future, selection, viewport, webgl, emphasis]);
      const byId = new Map(projected.map((n) => [n.id, n]));
      const labels = layoutLabels(projected, selectedNode.id, camera.zoom, viewport);
      const branchColor = (node) => nodeAppearance(node).color;
      const pickRoot = (root) => {if(!suppress.current){setEmphasis(rootKey(root));setOrbit(false);setFull(true);setCenter(null);}};
      const pick = (id) => { if (!suppress.current) { setSelection(id); setEmphasis(id); setTesting(false); setChoice(''); } };
      const mapButton = (label, action, disabled = false, key = label) => button(label, action, disabled, { key, color: '#d5eefb', borderColor: '#34516c', fontSize: 12, padding: '6px 9px' });
      const selectStyle = { ...btn, background: '#0d172a', color: '#d5eefb', borderColor: '#34516c', maxWidth: '100%', fontSize: 12 };
      const selectedColor = mapStatus[selectedNode.status]?.[1] || '#8276be';
      const reset = () => { setEmphasis(null); setFull(false); setCenter(null); setCamera({ ...mapHome }); setSelection(data.current?.nodeId || data.nodes[0]?.id); };
      const focusNode = (id) => { suppress.current = false; setSelection(id); setEmphasis(id); setCenter(id); setFull(false); setCamera({ ...mapHome, zoom: 1.15 }); setTesting(false); setChoice(''); };
      const down = (event) => {
        if (![0,1].includes(event.button) || drag.current) return;
        setOrbit(false);
        const pan=event.button===1;
        if(pan){event.preventDefault?.();event.stopPropagation?.();event.currentTarget.setPointerCapture?.(event.pointerId);}
        suppress.current = pan; drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, distance: 0, pan, element: event.currentTarget };
      };
      const move = (event) => {
        const d = drag.current; if (!d || d.id !== event.pointerId) return;
        const dx = event.clientX - d.x, dy = event.clientY - d.y;
        d.x = event.clientX; d.y = event.clientY; d.distance += Math.abs(dx) + Math.abs(dy);
        if(d.pan){
          event.preventDefault?.();suppress.current=true;
          const box=d.element.getBoundingClientRect?.();
          setCamera(old=>panCamera(old,dx,dy,[box?.width||viewport[0],box?.height||viewport[1]]));return;
        }
        if (d.distance <= 5) return;
        suppress.current = true;
        if (!d.element.hasPointerCapture?.(d.id)) d.element.setPointerCapture?.(d.id);
        setCamera((old) => ({ ...old, yaw: old.yaw + dx * .006, pitch: Math.max(-1.4, Math.min(1.4, old.pitch + dy * .005)) }));
      };
      const up = (event) => {
        if (!drag.current || drag.current.id !== event.pointerId) return;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      };
      const blockMiddle = event => { if(event.button===1){event.preventDefault();event.stopPropagation();} };
      return h('section', { ref: root, 'aria-label': '三维知识科技树', 'data-renderer': webgl ? 'webgl' : 'svg-fallback', 'data-fullscreen': fullscreen, style: { border: '1px solid #254762', borderRadius: fullscreen ? 0 : 14, marginBottom: fullscreen ? 0 : 18, overflow: 'hidden', background: '#070d1c', color: '#d5eefb', boxShadow: '0 12px 45px #03081770', ...(fullscreen ? { position: 'fixed', inset: 0, width: '100%', height: '100dvh', zIndex: 2147483000, display: 'flex', flexDirection: 'column' } : {}) } },
        h('style', null, '@keyframes studyMapPulse{0%,100%{opacity:.35}50%{opacity:1}}.study-map-current{animation:studyMapPulse 3s ease-in-out infinite}.study-map-node:focus{outline:none}.study-map-node:focus-visible .study-node-focus{opacity:1}@media(prefers-reduced-motion:reduce){.study-map-current{animation:none}.study-map-flow{display:none}}'),
        h('div', { style: { padding: '18px 20px 12px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between' } },
          h('div', null, h('div', { style: { fontFamily: 'monospace', letterSpacing: 3, fontSize: 10, color: '#55ddec' } }, 'NEURAL ATLAS / KNOWLEDGE FRONTIER'),
            h('div', { style: { fontSize: 20, fontWeight: 650, marginTop: 5 } }, data.researched ? '知识星图 · ' + (data.subjectTitle || '全部学科') : '知识科技树 · 数学'),
            h('div', { style: { color: '#8caac2', fontSize: 12, marginTop: 5 } }, data.current ? '当前：' + data.nodes.find((n) => n.id === data.current.nodeId)?.title : data.researched ? '课程知识与建议前置 · 点击节点确认基础' : '尚未定位 · 可以直接选择较高级的学习起点')),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            mapButton(fullscreen ? '退出全屏' : '全屏查看', toggleFullscreen),
            mapButton('−', () => setCamera((old) => zoomCamera(old, 130))), mapButton('+', () => setCamera((old) => zoomCamera(old, -130))),
            mapButton(orbit ? '停止环绕' : '自动环绕', () => setOrbit(!orbit)), mapButton('俯视', () => setCamera((old) => ({ ...old, pitch: -1.3 }))), mapButton('立体全景', () => { setEmphasis(null); setOrbit(false); setFull(true); setCenter(null); setCamera({ ...mapHome }); }),
            highlight ? mapButton('清除高亮',()=>setEmphasis(null)) : null,
            mapButton('定位当前', reset), locate ? mapButton('恢复自动定位', () => locate(null), busy || data.current?.source !== 'manual') : null, mapButton(full ? '附近知识' : '全部路径', () => { setFull(!full); setCenter(null); setCamera({ ...mapHome }); }),
            h('select', { 'aria-label': '向后展开层数', value: future, onChange: (e) => setFuture(Number(e.target.value)), style: selectStyle }, [2,3,4].map((n) => h('option', { key: n, value: n }, '向后 ' + n + ' 层'))))),
        h('div', { style: { padding: '0 20px', color: '#6f91ab', fontSize: 11 } }, highlight ? highlight.rootSelected?'已高亮根系的 '+highlight.nodes.size+' 个直接相连节点 · 其余内容已淡化':'已高亮选中节点及 '+(highlight.nodes.size-1)+' 个直接关联知识点 · 其余内容已淡化' : data.current?.description || (data.researched ? '自动补出的前置仅推测具备，已有自评、自检及作答证据优先。' : '选定起点后，建议前置节点会低亮待确认。')),
        sceneError ? h('p', {role:'status',style:muted}, sceneError) : null,
        h('div', { style: { position:'relative', height:fullscreen?'auto':'clamp(420px,68vh,820px)', minHeight:fullscreen?140:320, flex:fullscreen?'1 1 0':undefined, background:'radial-gradient(ellipse at 45% 45%,#0d1829 0%,#050911 60%,#020509 100%)' } },
        h('div', {ref:sceneHost,'data-webgl-host':true,style:{position:'absolute',inset:0,pointerEvents:'none'}}),
        h('svg', { ref: surface, viewBox: '0 0 ' + viewport.join(' '), width: '100%', height: fullscreen ? undefined : 560, role: 'group', 'aria-label': '拖拽旋转、滚轮缩放知识地图',
          tabIndex: 0, onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: up,
          onMouseDown:blockMiddle,onAuxClick:blockMiddle,
          onPointerLeave: () => { if (drag.current && !drag.current.element.hasPointerCapture?.(drag.current.id)) drag.current = null; },
          onKeyDown: (e) => { if (['+', '=', '-', 'Home'].includes(e.key)) { e.preventDefault(); if (e.key === 'Home') reset(); else setCamera((old) => zoomCamera(old, e.key === '-' ? 130 : -130)); } },
          style: { position:'relative', display: 'block', height:'100%', outline: 'none', touchAction: 'none', userSelect: 'none', cursor: 'grab' } },
          h('defs', null,
            h('filter', { id: 'study-neon-glow', x: '-100%', y: '-100%', width: '300%', height: '300%' }, h('feGaussianBlur', { stdDeviation: 4 })),
            h('radialGradient', { id: 'study-orb' }, h('stop', { offset: '0%', stopColor: '#ffffff', stopOpacity: .95 }), h('stop', { offset: '100%', stopColor: '#3ddbe5', stopOpacity: 0 }))),
          Array.from({ length: 70 }, (_, i) => h('circle', { key: 'star' + i, cx: ((i * 157 + 73) % 920) / 920 * viewport[0], cy: ((i * 97 + 41) % 580) / 580 * viewport[1], r: i % 7 ? .65 : 1.2, fill: '#7da9d0', opacity: .08 + (i % 3) * .05 })),
          !webgl ? (data.roots || []).map((root) => {
            const p = projectPoint(root.position, view, origin, fit, viewport);
            return h('g', {key:root.subject,style:{pointerEvents:'none'}},
              root.children.filter(id => byId.has(id)).map(id => { const child=byId.get(id),n=child.screen,related=highlight?.edges.has(edgeKey(rootEdge(root,id))); return h('path',{key:id,'data-root-edge':edgeKey(rootEdge(root,id)),'data-highlighted':!!related,d:`M${p.x},${p.y} C${p.x},${p.y-35} ${n.x},${n.y+45} ${n.x},${n.y}`,fill:'none',stroke:nodeAppearance(child).pending?UNCONFIRMED_COLOR:root.tone,strokeWidth:related?2.3:1.5,opacity:highlight&&!related? .12:related? .9:.48}); }));
          }) : null,
          !webgl ? data.edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to)).map((edge) => {
            const a = byId.get(edge.from).screen, b = byId.get(edge.to).screen;
            const lit = nodeAppearance(byId.get(edge.from)).glow&&nodeAppearance(byId.get(edge.to)).glow, cross = byId.get(edge.from).branch !== byId.get(edge.to).branch, tint = !lit?UNCONFIRMED_COLOR:cross ? '#ecb9ff' : branchColor(byId.get(edge.to));
            const path = `M${a.x},${a.y} C${a.x},${a.y+(b.y-a.y)*.65} ${b.x},${a.y+(b.y-a.y)*.72} ${b.x},${b.y}`;
            return h('g', { key: edgeKey(edge), opacity:highlight && !highlight.edges.has(edgeKey(edge)) ? .12 : 1, 'data-knowledge-edge':edgeKey(edge), 'data-highlighted':!!highlight?.edges.has(edgeKey(edge)) },
              lit?h('path', { d: path, fill: 'none', stroke: tint, strokeWidth: 7, opacity: .3, filter: 'url(#study-neon-glow)' }):null,
              h('path', { d: path, fill: 'none', stroke: tint, strokeDasharray: cross ? '5 6' : undefined, opacity: lit ? .95 : .65, strokeWidth: lit ? 1.8 : 1.2 }),
              lit?[0,1,2].map((i) => h('circle', { key: i, className: 'study-map-flow', r: 1.8, fill: tint, opacity: .9 },
                h('animateMotion', { path, dur: (4.5+i*.7)+'s', begin: (-i*1.7)+'s', repeatCount: 'indefinite' }))):null);
          }) : null,
          (data.areas || []).map(area=>{
            const p=projectPoint(area.position,view,origin,fit,viewport);
            const rim=Array.from({length:24},(_,i)=>projectPoint([area.position[0]+Math.cos(i*Math.PI/12)*area.radius,180,area.position[2]+Math.sin(i*Math.PI/12)*area.radius],view,origin,fit,viewport));
            return h('g',{key:area.id,'data-knowledge-area':area.id},h('text',{x:p.x,y:Math.max(...rim.map(p=>p.y))+24,fill:area.tone,fontSize:15,fontWeight:650,textAnchor:'middle'},area.label));
          }),
          projected.map((node) => {
            const p = node.screen, color = branchColor(node),appearance=nodeAppearance(node);
            const active = node.id === selectedNode.id, radius = node.isCurrent ? 8 : 4.5, tint = branchColor(node), label = labels.get(node.id);
            return h('g', { key: node.id, className: 'study-map-node', 'data-knowledge-node': node.id,'data-node-color':color,'data-node-glow':appearance.glow,'data-position':node.position.join(','), 'data-highlighted':!!highlight?.nodes.has(node.id), opacity:highlight && !highlight.nodes.has(node.id) ? .18 : 1, role: 'button', tabIndex: 0, 'aria-pressed': active, 'aria-label': node.title + '，' + mapStatus[node.status][0] + (node.isCurrent ? '，当前学习' : ''),
              onClick: () => pick(node.id), onDoubleClick: (e) => { e.preventDefault(); e.stopPropagation(); focusNode(node.id); }, onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusNode(node.id); } }, style: { cursor: 'pointer', outline: 'none' },
              transform: `translate(${p.x},${p.y})` },
              h('title',null,node.title+' · '+node.branch),
              h('circle', { r: 14, fill: 'transparent' }),
              h('g', {opacity:webgl?0:1},
              h('circle', { className: 'study-node-focus', r: 22, fill: 'none', stroke: '#e5f9ff', strokeWidth: 1.5, opacity: 0 }),
              appearance.glow&&(active || node.isCurrent || ['evidence','checked','self-confirmed'].includes(node.status)) ? h('circle', { r: radius + 9, fill: color, opacity: .3, filter: 'url(#study-neon-glow)' }) : null,
              node.isCurrent&&appearance.glow ? h('g', { stroke: '#e5f9ff', fill: 'none', opacity: .8 }, h('circle', { className: 'study-map-current', r: 19, strokeDasharray: '13 7 2 7', strokeWidth: 1 })) : null,
              active ? h('circle', { r: 14, fill: 'none', stroke: color, strokeWidth: 1, opacity: .75 }) : null,
              h('circle', { r: radius + 3, fill: 'none', stroke: tint, strokeWidth: .8, opacity: .5 }),
              h('circle', { r: radius, fill: color, stroke: color, strokeWidth: 1.3, opacity: ['unseen','assumed'].includes(node.status) ? .5 : 1 }),
              h('circle', { r: radius * .38, fill: appearance.pending?color:'#f1fbff', opacity: appearance.pending ? .5 : .85 })),
              (active||highlight?.nodes.has(node.id))&&appearance.pending?h('circle',{r:12,fill:'none',stroke:UNCONFIRMED_COLOR,strokeWidth:1.4,opacity:.9}):null,
              label ? h('text', { x: label.x-p.x, y: label.y-p.y+label.font, fill: appearance.pending?(active||highlight?.nodes.has(node.id)?'#a6afb9':UNCONFIRMED_COLOR):active || node.isCurrent ? '#f0fbff' : '#b4cbd3', fontSize: label.font, fontWeight: node.isCurrent ? 650 : 400, style: { textShadow: '0 1px 5px #03070e' } }, label.lines.map((line, i) => h('tspan', { key: i, x: label.x-p.x, dy: i ? label.step : 0 }, line))) : null);
          }),
          // Keep root hit targets above node labels; spokes must not enlarge their click bounds.
          (data.roots || []).map((root) => {
            const p=projectPoint(root.position,view,origin,fit,viewport),rootActive=highlight?.roots?.has(rootKey(root));
            return h('g',{key:root.subject,className:'study-map-node study-map-root','data-subject-root':root.subject,'data-highlighted':!!rootActive,transform:`translate(${p.x},${p.y})`,opacity:highlight&&!rootActive ? .18 : 1,role:'button',tabIndex:0,'aria-label':root.title+'根系，高亮直接相连节点','aria-pressed':emphasis===rootKey(root),onClick:e=>{e.stopPropagation();pickRoot(root);},onKeyDown:e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();pickRoot(root);}},style:{cursor:'pointer',outline:'none'}},
              h('circle',{r:14,fill:'transparent',style:{pointerEvents:'all'}}),
              !webgl?h('ellipse',{rx:20*p.scale,ry:5*p.scale,fill:'none',stroke:root.tone,opacity:.65}):null,
              rootActive?h('circle',{r:14*p.scale,fill:'none',stroke:root.tone,strokeWidth:1.5}):null,
              h('circle',{r:9*p.scale,fill:root.tone,opacity:.5,filter:'url(#study-neon-glow)'}),
              h('text',{x:0,y:23,fill:root.tone,fontSize:12,textAnchor:'middle'},root.title+' · 根系'));
          }),
          h('text', { x: 22, y: viewport[1]-16, fill: '#7091aa', fontSize: 10, fontFamily: 'monospace',style:{pointerEvents:'none'} }, `${webgl?'WEBGL 3D':'COMPATIBLE VIEW'} / ORBIT ${Math.round(camera.yaw*180/Math.PI)}° / ZOOM ${Math.round(camera.zoom*100)}% / ${visible.length} NODES`))),
        h('div', { style: { display: 'flex', gap: 12, flexWrap: 'wrap', padding: '0 20px 15px', fontSize: 11, color: '#9bb5cb' } },
          h('span', null, '基础在下 · 高级向上 · 左键旋转 · 中键拖动平移 · 滚轮围绕鼠标缩放 · 双击聚焦 · 未确认的前置为灰色静态点，已接触或确认的节点按学科亮起'),
          Object.entries(mapStatus).map(([key, [label, color]]) => h('span', { key, style: { color } }, '● ' + label))),
        h('div', { style: { borderTop: '1px solid #23384e', padding: '18px 20px', background: '#0b1425', ...(fullscreen ? { maxHeight: '28vh', overflowY: 'auto', flexShrink: 0 } : {}) } },
          h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 } },
            h('select', { 'aria-label': '选择知识点', value: selectedNode.id, onChange: (e) => { suppress.current = false; pick(e.target.value); }, style: selectStyle }, data.nodes.map((n) => h('option', { key: n.id, value: n.id }, n.branch + ' · ' + n.title))),
            h('span', { style: { color: selectedColor, fontSize: 12 } }, mapStatus[selectedNode.status][0]),
            selectedNode.isCurrent ? h('span', { style: { color: '#ebfaff', fontSize: 12 } }, '◎ 当前学习') : null),
          h('p', { style: { lineHeight: 1.7, color: '#b6c9db', margin: '8px 0 12px' } }, selectedNode.description),
          assignArea && (selectedNode.area === 'unclassified' || selectedNode.areaOverride) ? h('label', {style:{...muted,display:'inline-flex',alignItems:'center',gap:8,marginBottom:12}},
            '学科分区 · ' + selectedNode.subject,
            h('select', {'aria-label':'学科分区',value:selectedNode.areaOverride || '',disabled:busy,style:selectStyle,
              onChange:event=>assignArea(selectedNode.subject,event.target.value || null)},
              h('option',{value:''},selectedNode.areaOverride?'恢复自动分区':'选择分区'),
              SUBJECT_AREAS.filter(a=>a.id!=='unclassified').map(a=>h('option',{key:a.id,value:a.id},a.label)))) : null,
          selectedNode.status === 'assumed' ? h('p', { style: { fontSize: 12, color: '#e5b358' } }, '根据当前学习起点或较高级节点推测的前置基础，尚未确认掌握。') : null,
          selectedNode.origin === 'course-summary' ? h('p',{style:muted},'已校验的课程核心概念；联网前置仍待补齐。') : null,
          selectedNode.evidence ? h('p', { style: { fontSize: 12, color: '#8baec5' } }, '作答依据：' + selectedNode.evidence.description) : null,
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
            locate ? mapButton('设为学习起点', () => locate(selectedNode.id), busy) : null,
            mapButton('居中该节点', () => { setCenter(selectedNode.id); setCamera({ ...mapHome }); }),
            explore ? mapButton(selectedNode.exploration?.state==='completed'?'已深挖一层':selectedNode.exploration?.state==='processing'?'正在深挖…':selectedNode.exploration?.state==='queued'?'深挖已排队':selectedNode.exploration?.state==='failed'?'重试深挖':'深挖',()=>explore(selectedNode.id),busy||['queued','processing','completed'].includes(selectedNode.exploration?.state)) : null,
            assess ? mapButton('我已掌握（自评）', () => assess(selectedNode.id, 'self-known'), busy) : null,
            assess ? mapButton('需要补习', () => assess(selectedNode.id, 'needs-review'), busy) : null,
            assess ? mapButton('撤销自评', () => assess(selectedNode.id, 'clear'), busy || selectedNode.selfAssessment === 'clear') : null,
            selectedNode.check ? mapButton(testing ? '收起自检' : '做一道自检', () => { setTesting(!testing); setChoice(''); }, busy) : null),
          explore ? h('p',{style:muted},'深挖只补一层直接前置，自动复用全局已有节点并连接相关知识；想继续深入，请选择下层节点再点深挖。') : null,
          selectedNode.exploration?.state==='failed'?h('p',{role:'status',style:{...muted,color:'#efac96'}},selectedNode.exploration.message):null,
          selectedNode.exploration?.state==='completed'?h('p',{role:'status',style:muted},selectedNode.exploration.outcome==='no-supported-prerequisites'?'本次未找到可核实的直接前置，这不代表它没有更深的基础。':'本次新增 '+selectedNode.exploration.added+' 个节点，复用 '+selectedNode.exploration.reused+' 个全局节点。其他分支已保留。'):null,
          h('p', { style: { color: '#7393ab', fontSize: 11 } }, data.researched ? '课程节点有字幕依据；自动补出的前置仍为推测具备、待确认。自动补全不代表已掌握，可点击自评或自检。' : '自评、单题自检与课程作答分别留痕；低亮不代表掌握，自检不发XP。'),
          data.researched ? h('div', null,
            (selectedNode.references || []).map((r) => h('p', { key: r.url + r.quote, style: muted },
              r.quote || r.authority || '建议路径参考', ' ', r.kind==='course-material'?h('span',null,r.title):h('a', { href: r.url, target: '_blank', rel: 'noreferrer' }, r.title))),
            data.edges.filter((e) => e.from === selectedNode.id || e.to === selectedNode.id).map((e) => {
              const other = data.nodes.find((n) => n.id === (e.from === selectedNode.id ? e.to : e.from));
              return h('div', { key: e.from + e.to + e.kind, style: box },
                mapButton((e.kind === 'suggested-prerequisite' ? '补全的建议先修 · ' : e.kind === 'prerequisite' ? '先修关系 · ' : '知识连接 · ') + other.branch + ' · ' + other.title, () => focusNode(other.id)),
                h('p', null, e.reason), e.references.map((r) => h('p', { key: r.url + r.quote, style: muted }, r.quote || '建议路径参考', ' ',
                  r.kind==='course-material'?h('span',null,r.title):h('a', { href: r.url, target: '_blank', rel: 'noreferrer' }, r.title))));
            })) : null,
          testing ? h('div', { style: { padding: 14, margin: '12px 0', border: '1px solid #2e5266', borderRadius: 8 } },
            h('p', { style: { lineHeight: 1.6 } }, selectedNode.check.question),
            selectedNode.check.options.map((option, i) => { const letter = String.fromCharCode(65 + i); return h('label', { key: letter, style: { display: 'block', padding: '7px 0', fontSize: 13 } }, h('input', { type: 'radio', name: 'knowledge-check-' + selectedNode.id, value: letter, checked: choice === letter, disabled: busy, onChange: () => setChoice(letter) }), ' ' + letter + '. ' + option); }),
            mapButton('提交自检', () => check(selectedNode.id, choice), busy || !choice)) : null,
          selectedNode.lastCheck ? h('p', { style: { lineHeight: 1.7, fontSize: 12, color: selectedNode.lastCheck.correct ? '#6ce7c2' : '#ff91ac' } },
            '最近一次自检：' + (selectedNode.lastCheck.correct ? '答对' : '待复习') + '。' + selectedNode.lastCheck.explanation + ' 这只是单题证据，不代表整个知识点已全面掌握。') : null,
          selectedNode.relatedSessions.length ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 } },
            selectedNode.relatedSessions.slice(0,3).map((s) => mapButton('打开关联学习 · ' + new Date(s.at).toLocaleDateString('zh-CN'), () => openSession(s.id), busy, s.id))) : !data.researched ? h('p', { style: { fontSize: 12, color: '#7393ab' } }, '这个节点还没有关联课程记录，可以先自评或自检。') : null,
          h('details', { style: { color: '#6f8fa7', fontSize: 11, marginTop: 14 } }, h('summary', { style: { cursor: 'pointer' } }, '查看知识路径依据'),
            h('p', { style: { lineHeight: 1.7 } }, data.provenance.description), data.provenance.sources.map((source) => h('div', { key: source.url }, h('a', { href: source.url, target: '_blank', rel: 'noreferrer', style: { color: '#7aaec9' } }, source.title))))));
    }

    function layoutResearchGraph(graph, focusSubject = '', focusArea = '') {
      const subjectsAll=[...new Set(graph.nodes.map(n=>n.subject))].sort();
      const areasBySubject=new Map(subjectsAll.map(subject=>{
        const votes=new Map();for(const n of graph.nodes.filter(n=>n.subject===subject)){const id=n.areaOverride||subjectArea(subject,n.area).id;votes.set(id,(votes.get(id)||0)+1);}
        return [subject,[...votes].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0][0]];
      }));
      const source=graph.nodes.filter(n=>(!focusSubject||n.subject===focusSubject)&&(!focusArea||areasBySubject.get(n.subject)===focusArea));
      const ids=new Set(source.map(n=>n.id)),edges=graph.edges.filter(e=>ids.has(e.from)&&ids.has(e.to));
      // Compute levels from the full prerequisite graph before filtering. A
      // prerequisite in another subject must still sit below its dependent.
      const levels=new Map(),incoming=new Map(graph.nodes.map(n=>[n.id,[]]));
      graph.edges.filter(e=>['prerequisite','suggested-prerequisite'].includes(e.kind)&&incoming.has(e.from)&&incoming.has(e.to)).forEach(e=>incoming.get(e.to).push(e.from));
      const depth=(id,visiting=new Set())=>{
        if(levels.has(id))return levels.get(id);if(visiting.has(id))return 0;
        const next=new Set(visiting);next.add(id);const parents=incoming.get(id)||[];
        const value=parents.length?1+Math.max(...parents.map(p=>depth(p,next))):0;levels.set(id,value);return value;
      };
      const subjects=[...new Set(source.map(n=>n.subject))].sort(),groups=new Map();
      for(const n of source){const key=n.subject+':'+depth(n.id);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(n);}
      for(const group of groups.values())group.sort((a,b)=>a.id.localeCompare(b.id));
      const areas=SUBJECT_AREAS.filter(a=>subjects.some(subject=>areasBySubject.get(subject)===a.id)).map(a=>{
        const own=subjects.filter(subject=>areasBySubject.get(subject)===a.id);
        const nodeRadius=Math.max(150,...own.flatMap(subject=>[...groups].filter(([k])=>k.startsWith(subject+':')).map(([,g])=>Math.sqrt(g.length)*65)));
        const orbit=own.length===1?0:Math.max(240,own.length*(nodeRadius+90)/Math.PI);
        return {...a,subjects:own,nodeRadius,orbit,radius:orbit+nodeRadius+100};
      });
      const regionOrbit=(Math.max(0,...areas.map(a=>a.radius))+260)/Math.sin(Math.PI/SUBJECT_AREAS.length);
      const roots=[];
      for(const area of areas){
        const theta=Math.PI+SUBJECT_AREAS.findIndex(a=>a.id===area.id)*Math.PI*2/SUBJECT_AREAS.length;
        const cx=areas.length===1?0:Math.cos(theta)*regionOrbit,cz=areas.length===1?0:Math.sin(theta)*regionOrbit;
        area.position=[cx,250,cz];
        area.subjects.forEach((subject,i)=>{
          const angle=-Math.PI/2+i*Math.PI*2/area.subjects.length;
          roots.push({subject,area:area.id,title:subject==='math'?'数学':subject,tone:subjectTheme({axis:subject,name:subject}).tone,
            nodeRadius:area.nodeRadius,position:[cx+Math.cos(angle)*area.orbit,130,cz+Math.sin(angle)*area.orbit]});
        });
      }
      const rootBySubject=new Map(roots.map(r=>[r.subject,r]));
      const nodes=source.map(n=>{
        const level=depth(n.id),group=groups.get(n.subject+':'+level),slot=group.findIndex(p=>p.id===n.id),root=rootBySubject.get(n.subject);
        const theta=.3+2*Math.PI*(slot+.5)/group.length+level*.58,radius=root.nodeRadius*(.84+.16*((slot*.61803398875)%1));
        return {...n,area:root.area,branch:n.subject,tone:root.tone,prerequisites:incoming.get(n.id),
          position:[root.position[0]+Math.cos(theta)*radius,-level*115,root.position[2]+Math.sin(theta)*radius],isCurrent:false,relatedSessions:[]};
      });
      roots.forEach(root=>{root.children=nodes.filter(n=>n.subject===root.subject&&!n.prerequisites.some(id=>nodes.find(p=>p.id===id)?.subject===root.subject)).map(n=>n.id);});
      const focus=nodes.find(n=>n.status==='encountered');
      const subjectTitle=focusSubject?subjectTheme({axis:focusSubject,name:focusSubject}).name:focusArea?SUBJECT_AREAS.find(a=>a.id===focusArea)?.label:'全部学科';
      return {nodes,edges,roots,areas:focusSubject?[]:areas,researched:true,subjectTitle,
        current:focus?{nodeId:focus.id,description:focusSubject?'仅显示本学科课程与前置知识 · 返回全部学科可查看交叉连接':'按知识大类分区 · 区内保留独立学科根系 · 点击节点高亮直接关联'}:null,
        provenance:{description:'大类是地图导航分组；各区保持间隔，区内按先修递进向上。跨区连线保留原有知识依据，不用空间距离判断概念关联。',sources:[]}};
    }
    function ResearchMap({ graph, busy, assess, check, focusSubject, explore, assignArea }) {
      const [area,setArea]=React.useState('');
      const states=new Map((graph.explorations||[]).map(r=>[r.nodeId,r]));
      const decorated={...graph,nodes:graph.nodes.map(n=>({...n,exploration:states.get(n.id)}))};
      const all=layoutResearchGraph(decorated);
      const activeArea = !focusSubject && all.areas.some(item => item.id === area) ? area : '';
      const data = layoutResearchGraph(decorated, focusSubject, activeArea);
      if(!data.nodes.length)return h('p',{style:muted},'这个学科尚未生成知识导航。');
      return h('div',null,!focusSubject?h('div',{'aria-label':'知识大类分区',style:{display:'flex',flexWrap:'wrap',gap:8,marginBottom:12}},
        h('button',{type:'button','aria-pressed':!activeArea,onClick:()=>setArea(''),style:btn},'全部分区'),
        all.areas.map(a=>h('button',{key:a.id,type:'button','aria-pressed':a.id===activeArea,'data-area-filter':a.id,onClick:()=>setArea(a.id),style:{...btn,color:a.tone,borderColor:a.id===activeArea?a.tone:undefined}},a.label+' · '+a.subjects.length+' 学科'))):null,
        h(KnowledgeMap,{key:focusSubject||activeArea||'all',data,busy,assess,check,explore,
          assignArea: async (subject, value) => { if (await assignArea(subject, value)) setArea(''); }}));
    }
    function CaptureControls({ data, busy, action, selectReading }) {
      const enabled = !!data?.config.enabled;
      const generation = data?.generation;
      const source = data?.source === 'desktop' ? '客户端B站' : data?.source === 'browser' ? '网页端B站' : '';
      const states = { disconnected: '等待播放信号', waiting: '等待播放信号', paused: '已暂停计入', watching: '正在采集', outside: '等待B站视频', blocked: '当前视频已排除', 'needs-confirmation': '等待课程识别' };
      let status = enabled ? (source ? source + ' · ' : '') + (states[data.state] || '正在识别播放来源') : '采集已结束';
      if (!enabled) status = ({ idle: '尚未开始采集', insufficient: '本轮有效片段不足30秒，暂不可出题', failed: '课程材料准备失败，暂不可出题', preparing: '正在准备课程材料', ready: generation?.state === 'no-questions' ? '采集内容已保存，本段暂不出题' : '采集已结束，可以出题' })[data?.controls?.phase] || status;
      if (data?.controls?.seconds) status += ' · 本轮采集 ' + durationLabel(Math.round(data.controls.seconds)) + ' · ' + data.controls.segments + '段';
      if (enabled && data?.desktop?.state === 'bridge-starting') status = '正在自动准备客户端读取，必要时会重开B站';
      if (enabled && data?.desktop?.state === 'bridge-start-failed') status = '客户端读取准备失败，请结束采集后重新开始';
      if (enabled && source && data?.desktop?.state === 'needs-position' && data.source === 'desktop') status = '客户端B站 · 正在等待有效播放进度';
      if (enabled && source && data?.desktop?.state === 'needs-identity' && data.source === 'desktop') status = '客户端B站 · 请打开要学习的视频，正在识别课程';
      if (data?.audio?.state === 'recording') status += ' · 正在采集应用音频';
      if (data?.audio?.pending) status += ' · 本地转写中';
      if (data?.audio?.state === 'failed' && data.audio.error) status += ' · ' + data.audio.error;
      if (data?.audio?.state === 'waiting-player') status += ' · 等待确认播放器，音频尚未开始';
      if (enabled && data?.diagnostics?.lastIssue) status += ' · 未计入原因：' + data.diagnostics.lastIssue;
      if (!enabled && data?.controls?.phase === 'insufficient' && data.controls.reason) status = data.controls.reason;
      const reading=data?.controls?.kind==='reading',reader=data?.reading;
      if(reading){
        const names={reading:reader?.target?.kind==='editor'?'正在采集 VS Code 可见行':'正在识别可见正文',captured:'正在识别可见正文','select-window':'请选择阅读窗口','waiting-document':'请切回选定文档开始阅读',paused:'已暂停，请切回原文档','document-changed':'文档已切换，暂停采集；请切回原文档或结束本轮','document-edited':'文件内容已修改，请结束本轮后重新采集','editor-disconnected':'等待 VS Code 阅读扩展，请打开文本编辑器；首次安装扩展后需重开 VS Code','editor-too-large':'可见片段过长，请放大代码或减少当前显示行数','window-closed':'原阅读窗口已关闭','unreadable-window':'窗口尺寸不适合识别，请调整文档窗口','capture-unavailable':'阅读器未提供窗口画面，请尝试其他PDF阅读器或浏览器',failed:'阅读识别暂未完成',interrupted:'上次阅读已中断，已识别文字保留；请先结束本轮','material-limit':'本轮材料已达上限，请结束并出题'};
        status=enabled?(names[reader?.state]||'正在准备阅读采集'):data.controls.phase==='ready'?'阅读采集已结束，可以出题':data.controls.reason||'阅读采集已结束';
        status+=' · '+(reader?.characters||data.controls.characters||0)+' 字 · '+(reader?.frames||0)+' 次新内容';
        if(reader?.target)status+=' · '+reader.target.title;if(reader?.error)status+=' · '+reader.error;
        if (reader?.mode === 'chatgpt') {
          const chatStatus = {
            'chatgpt-waiting': '打开 ChatGPT 网页对话，点击浏览器工具栏的学习采集桥图标',
            'chatgpt-reading': '正在采集 ChatGPT 问答，滚动可采集更多消息',
            'chatgpt-no-messages': '等待当前页面显示问答正文',
            'chatgpt-paused': '采集已暂停，请切回原 ChatGPT 对话',
            'chatgpt-edited': '已采集消息发生变化，请结束本轮后重新采集',
          };
          const phase = enabled ? chatStatus[reader.state] || names[reader.state] || '正在准备采集对话'
            : data.controls.phase === 'ready' ? 'ChatGPT 对话已保存，可以出题' : data.controls.reason || 'ChatGPT 对话采集已结束';
          status = phase + ' · 回答 ' + reader.answerCharacters + ' 字 · 问答共 ' + reader.characters + ' 字';
          if (reader.target) status += ' · ' + reader.target.title;
        }
        if (reader?.mode === 'codex') {
          const codexStatus = { 'codex-select': '请选择要学习的 Codex 会话', 'codex-loading': '正在读取选定会话',
            'codex-ready': '已读取 Codex 问答，可以结束采集', interrupted: '上次采集已中断，已读取的问答保留' };
          status = enabled ? codexStatus[reader.state] || names[reader.state] || '正在准备 Codex 采集'
            : data.controls.phase === 'ready' ? 'Codex 对话已保存，可以出题' : data.controls.reason || 'Codex 采集已结束';
          if (reader.target) status += ' · ' + reader.target.title + ' · 回答 ' + reader.answerCharacters + ' 字';
          if (reader.error) status += ' · ' + reader.error;
        }
      }
      const working = ['queued', 'processing'].includes(generation?.state);
      return h('div', { className: 'study-capture-controls', 'aria-label': '采集控制' },
        h('div', { style: { display: 'flex', gap: 10, flexWrap: 'wrap', margin: '16px 0 8px' } },
          button('开始采集', () => action('start'), busy || !data || enabled),
          button('结束采集', () => action('stop'), busy || !data || !enabled),
          !enabled && data?.controls?.canGenerate && generation?.state !== 'no-questions' ? button('出题', () => action('questions'), busy || working) : null),
        reading&&enabled&&reader?.state==='select-window'?h('div',null,
          h('select',{'aria-label':'选择阅读窗口',value:'',disabled:busy,onChange:e=>selectReading(e.target.value),style:{...btn,maxWidth:'100%'}},h('option',{value:''},'选择当前阅读的文档窗口'),(reader.candidates||[]).map(w=>h('option',{key:w.id,value:w.id},w.title+' · '+w.process))),
          !reader.candidates?.length?h('p',{style:muted},'请打开文档，窗口列表会自动更新。'):null):null,
        reading&&enabled&&reader?.state==='codex-select'?h('div',null,
          reader.candidates?.length ? h('select',{'aria-label':'选择 Codex 会话',value:'',disabled:busy,onChange:e=>selectReading(e.target.value),style:{...btn,maxWidth:'100%'}},
            h('option',{value:''},'选择 Codex 会话'),reader.candidates.map(thread=>h('option',{key:thread.id,value:thread.id},thread.title+' · '+time(thread.updatedAt))))
            : h('p',{style:muted},'当前未找到可选的 Codex 会话。请先打开 Codex 中的对话，再重新开始采集。')):null,
        h('p', { role: 'status', style: muted }, status,
          generation?.state === 'queued' ? ' · 已排队，等待DSH接单' :
          generation?.state === 'processing' ? ' · 正在出题，题目会自动出现在学习页' :
          generation?.state === 'failed' ? ' · ' + (generation.reason || '出题未完成，可在结束采集后重试') :
          generation?.state === 'completed' ? ' · 题目已准备，请进入学习页' : ''),
        generation?.state === 'no-questions' ? h('div', { style: muted }, h('p', null, generation.reason), h('p', null, '可以继续采集后续讲解；本段无需反复出题。')) : null);
    }
    const durationLabel = (seconds) => seconds < 60 ? seconds + ' 秒' : Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒';
    function AtlasProjection({ mark }) {
      return h('svg', { className: 'study-atlas-projection', viewBox: '0 0 320 240', 'aria-hidden': true },
        h('g', { fill: 'none', stroke: 'currentColor', strokeWidth: 1, opacity: .32 },
          h('path', { d: 'M13 71V38h38m218 0h38v33M13 159v28h38m218 0h38v-28M25 117h59m152 0h59M160 22v23' }),
          h('circle', { cx: 160, cy: 107, r: 65, strokeDasharray: '2 6' }),
          h('circle', { cx: 160, cy: 107, r: 80, strokeDasharray: '46 13 4 18' }),
          h('path', { d: 'M67 202h186m-155-9h124m-156 22h188M103 188l-35 35m62-35-17 35m77-35 17 35m10-35 35 35' })),
        h('g', { fill: 'none', stroke: 'currentColor' },
          h('ellipse', { cx: 160, cy: 198, rx: 81, ry: 17, opacity: .58 }),
          h('ellipse', { cx: 160, cy: 198, rx: 57, ry: 10, opacity: .8 }),
          h('path', { d: 'M94 194 114 130m112 64-20-64', opacity: .2 }),
          h('path', { d: 'M124 63h-9v9m81-9h9v9m-90 61v9h9m72 0h9v-9', opacity: .7 })),
        h('text', { className: 'study-atlas-sigil', x: 160, y: 132, textAnchor: 'middle', fill: 'currentColor', fontSize: 78 }, mark),
        h('g', { fill: 'currentColor', opacity: .65 }, h('circle', { cx: 89, cy: 87, r: 2 }), h('circle', { cx: 235, cy: 67, r: 2 }), h('circle', { cx: 204, cy: 164, r: 2 })));
    }
    function AtlasStageCopy({ line }) {
      const [body, epigraph] = line.split('\n');
      return h('span', { className: 'study-atlas-line' }, body,
        epigraph ? h('span', { className: 'study-atlas-epigraph' }, epigraph) : null);
    }
    function ProgressOverview({ progress, capture, openTree, controls, busy, nameSubject }) {
      const rail = React.useRef(null);
      const gesture = React.useRef(null);
      const suppressClick = React.useRef(false);
      const [activeIndex, setCurrent] = React.useState(0);
      const current = Math.max(0, Math.min(activeIndex, progress.length - 1));
      const active = capture?.active;
      const snapPosition = (element, card) => Math.min(element.scrollWidth - element.clientWidth, card.offsetLeft - element.firstElementChild.offsetLeft);
      const nearestCard = (element) => {
        let closest = 0, distance = Infinity;
        Array.from(element.children).forEach((card, index) => {
          const gap = Math.abs(element.scrollLeft - snapPosition(element, card));
          if (gap < distance) { distance = gap; closest = index; }
        });
        return closest;
      };
      const onScroll = ({ currentTarget: element }) => setCurrent(nearestCard(element));
      const slideTo = (index) => {
        const element = rail.current;
        const card = element?.children[index];
        if (!card) return;
        const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        element.scrollTo({ left: snapPosition(element, card), behavior: reducedMotion ? 'auto' : 'smooth' });
      };
      const beginDrag = (event) => {
        if (event.pointerType !== 'mouse' || event.button !== 0) return;
        suppressClick.current = false;
        const element = event.currentTarget;
        if (element.scrollWidth <= element.clientWidth) return;
        gesture.current = { id: event.pointerId, x: event.clientX, left: element.scrollLeft, index: nearestCard(element), moving: false };
      };
      const moveDrag = (event) => {
        const drag = gesture.current;
        if (!drag || drag.id !== event.pointerId) return;
        const distance = event.clientX - drag.x;
        if (!drag.moving && Math.abs(distance) < 7) return;
        const element = event.currentTarget;
        if (!drag.moving) {
          drag.moving = true;
          suppressClick.current = true;
          element.classList.add('is-dragging');
          element.setPointerCapture(event.pointerId);
        }
        event.preventDefault();
        element.scrollLeft = drag.left - distance;
      };
      const endDrag = (event) => {
        const drag = gesture.current;
        if (!drag || drag.id !== event.pointerId) return;
        gesture.current = null;
        if (!drag.moving) return;
        const element = event.currentTarget;
        const nearest = nearestCard(element);
        element.classList.remove('is-dragging');
        const distance = event.clientX - drag.x;
        if (event.type === 'pointerup' && Math.abs(distance) >= 55) {
          slideTo(nearest === drag.index ? nearest + (distance < 0 ? 1 : -1) : nearest);
        }
      };
      return h('section', { className: 'study-atlas study-atlas-terminal', 'aria-label': '学习总览' },
        h('div', { className: 'study-atlas-hero' },
          h('div', { className: 'study-atlas-telemetry' },
            h('span', { className: 'study-atlas-kicker' }, 'ATLAS_OS / HOLOGRAPHIC TERMINAL'),
            h('span', { className: 'study-atlas-signal' }, active ? '● 采集中' : '● 系统在线')),
          h('h2', null, '学习总览'),
          h('p', null, active ? '正在采集 ' + active.bvid + ' · P' + active.page + ' · ' + durationLabel(Math.round(capture.controls?.seconds || active.seconds)) : '阅读、观看、作答与复习记录实时汇入学科进度。'), controls),
        !progress.length ? h('div', { className: 'study-atlas-empty' },
          h('div', { className: 'study-atlas-kicker' }, '00 / AWAITING SIGNAL'),
          h('h3', null, capture?.jobs?.some((job) => job.stage === 'prepared') ? '等待AI完成学科归属' : '等待第一段学习信号'),
          h('p', null, '学习材料准备后会自动分析内容，对应的学科终端和知识树随后出现在这里。'),
          h(AtlasProjection, { mark: '◇' })) : null,
        progress.length ? h('div', null,
        h('div', { className: 'study-atlas-controls', 'aria-label': '切换学科' },
          h('div', { className: 'study-atlas-channels' }, progress.map((item, index) => h('button', {
            key: item.axis, type: 'button', onClick: () => slideTo(index), 'aria-pressed': current === index,
          }, item.name))),
          h('div', { className: 'study-atlas-stepper' },
            h('button', { type: 'button', 'aria-label': '上一个学科', disabled: current === 0, onClick: () => slideTo(current - 1) }, '‹'),
            h('span', null, String(current + 1).padStart(2, '0') + ' / ' + String(progress.length).padStart(2, '0')),
            h('button', { type: 'button', 'aria-label': '下一个学科', disabled: current >= progress.length - 1, onClick: () => slideTo(current + 1) }, '›'))),
        h('div', { ref: rail, className: 'study-atlas-rail', tabIndex: 0, 'aria-label': '学科进度滑轨',
          onScroll, onPointerDown: beginDrag, onPointerMove: moveDrag, onPointerUp: endDrag, onPointerCancel: endDrag, onLostPointerCapture: endDrag,
          onPointerLeave: (event) => { if (!gesture.current?.moving) endDrag(event); },
          onDragStart: (event) => event.preventDefault(),
          onClickCapture: (event) => {
            if (!suppressClick.current || event.detail === 0) return;
            suppressClick.current = false;
            event.preventDefault();
            event.stopPropagation();
          },
          onKeyDown: (event) => {
            if (event.target !== event.currentTarget || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            event.preventDefault();
            slideTo(current + (event.key === 'ArrowLeft' ? -1 : 1));
          },
        }, progress.map((item) => {
          const { name, tone, mark, title, stages } = subjectTheme(item);
          const [stageName, line] = stages[item.stage];
          const naming = item.presentationState === 'queued' || item.presentationState === 'processing';
          return h('article', { key: item.axis, className: 'study-atlas-card', style: { '--atlas-tone': tone } },
            h('button', { type: 'button', className: 'study-atlas-progress', 'aria-label': '查看' + name + '知识树', onClick: () => openTree(item.axis, item.courses[0]) },
              h('span', { className: 'study-atlas-name' }, name),
              h('strong', null, title),
              h('span', { className: 'study-atlas-phase' }, stageName),
              h('span', { className: 'study-atlas-track', 'aria-label': '第 ' + (item.stage + 1) + ' 阶段，共 5 阶段' }, stages.map(([label], i) => h('i', { key: label, className: i <= item.stage ? 'lit' : '', title: label }))),
              h(AtlasStageCopy, { line }),
              h('span', { className: 'study-atlas-stats' }, (item.readCharacters?'已采集阅读文字 '+item.readCharacters+' 字 · 学习 ':'已观看 ') + durationLabel(item.watched) + ' · 作答 ' + item.answered + ' 次 · 间隔复习答对 ' + item.reviewed + ' 次'),
              h('span', { className: 'study-atlas-link' }, '进入知识树 ↗'),
              h(AtlasProjection, { mark })),
            h('div', { className: 'study-atlas-card-actions' },
              h('button', { type: 'button', disabled: busy || naming, onClick: () => nameSubject(item.axis) },
                item.presentationState === 'queued' ? '等待起名…' : item.presentationState === 'processing' ? '正在起名…' :
                  item.presentation ? '请 AI 更新文案' : '请 AI 起名'),
              item.presentationReason ? h('span', { role: 'status' }, item.presentationReason) : null),
            item.courses.length ? h('div', { className: 'study-atlas-courses' }, item.courses.map((course) =>
              h('button', { key: course.key, type: 'button', onClick: () => openTree(item.axis, course) },
                h('span', null, course.title), h('span', null, course.parts.length ? course.parts.map((p) => 'P' + p.page + ' · ' + durationLabel(p.seconds) + (p.duration ? ' / ' + durationLabel(p.duration) : '')).join('  /  ') + ' ↗' : course.answered + ' 次作答 ↗')))) : null);
        })),
        h('div', { className: 'study-atlas-footer' }, h('span', null, progress.length > 1 ? '◀  左键拖动切换学科  ▶' : '等待更多学科接入'), h('span', null, '单击进度进入知识树'))) : null);
    }
    function SubjectTree({ progress, courseKey }) {
      const { name, tone, title, stages } = subjectTheme(progress);
      const [stage, line] = stages[progress.stage];
      const course = progress.courses.find((item) => item.key === courseKey);
      const concept = (item) => h('li', { key: item.title }, h('strong', null, item.title), h('span', null, item.meaning));
      return h('section', { className: 'study-atlas study-subject-tree', style: { '--atlas-tone': tone }, 'aria-label': name + '知识树' },
        h('div', { className: 'study-atlas-kicker' }, title),
        h('h2', null, name + ' · 知识树'),
        h('p', { className: 'study-atlas-phase' }, stage),
        h(AtlasStageCopy, { line }),
        h('ul', null, (course ? [course] : progress.courses).map((entry) => h('li', { key: entry.key },
          h('details', { open: true },
            h('summary', null, entry.title),
            h('p', null, (entry.readCharacters?'已采集阅读文字 '+entry.readCharacters+' 字 · 学习 ':'已观看 ') + durationLabel(entry.watched) + ' · 作答 ' + entry.answered + ' 次'),
            h('ul', null, entry.parts.map((part) => h('li', { key: part.page },
              h('details', { open: true },
                h('summary', null, 'P' + part.page + (part.title ? ' · ' + part.title : '')),
                h('p', null, '已观看 ' + durationLabel(part.seconds)),
                h('ul', null, entry.concepts.filter((item) => item.page === part.page).map(concept))))),
              entry.concepts.filter((item) => !entry.parts.some((part) => item.page === part.page)).map(concept)),
            !entry.concepts.length ? h('p', null, '课程提要入库后，知识点会加入对应分支。') : null)))));
    }
    const atlasStyles = `
      .study-atlas{container-type:inline-size;padding:clamp(16px,3vw,32px);border:1px solid #283e57;border-radius:16px;color:#d9eaf8;background:radial-gradient(ellipse at 12% 0%,#153548 0%,transparent 55%),radial-gradient(ellipse at 96% 4%,#252049 0%,transparent 50%),#091321}
      .study-atlas h2{margin:8px 0;color:#f1f7ff;font-size:clamp(23px,3vw,34px);overflow-wrap:anywhere}.study-atlas p{margin:6px 0;color:#a9bfd5;line-height:1.65}
      .study-atlas-hero{margin-bottom:23px}.study-atlas-kicker{color:#8be9dd;font:11px monospace;letter-spacing:.18em}
      .study-atlas-terminal{position:relative;isolation:isolate;border-radius:2px;border-color:#245760;border-top:2px solid #dcf46d;background:radial-gradient(ellipse at 90% 16%,#13423b 0%,transparent 43%),linear-gradient(118deg,#07121b,#0a262e 57%,#09171d);box-shadow:inset 0 0 36px #051015b5}
      .study-atlas-terminal::before{position:absolute;inset:0;z-index:-1;content:'';pointer-events:none;background:linear-gradient(#5de3da0c 1px,transparent 1px),linear-gradient(90deg,#5de3da0c 1px,transparent 1px);background-size:28px 28px;mask-image:linear-gradient(#000,transparent 90%)}
      .study-atlas-telemetry,.study-atlas-controls,.study-atlas-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
      .study-atlas-telemetry{padding-bottom:10px;border-bottom:1px solid #4bdccc37}.study-atlas-signal{color:#dcf46d;font:11px monospace;letter-spacing:.12em}
      .study-atlas-terminal h2{font-size:clamp(28px,4.6vw,50px);line-height:1.18;letter-spacing:.08em;text-shadow:0 0 23px #53e7d968;margin:14px 0 8px}
      .study-atlas-controls{margin-bottom:13px}.study-atlas-channels,.study-atlas-stepper{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      .study-atlas-controls button{font:inherit;color:#add1d3;background:#0a1c24;border:1px solid #3c646d;padding:6px 12px;cursor:pointer}.study-atlas-controls button:hover{border-color:#91f7e7;color:#eafff9}
      .study-atlas-controls button[aria-pressed=true]{color:#101b17;background:#dcf46d;border-color:#dcf46d;font-weight:700}.study-atlas-controls button:disabled{opacity:.38;cursor:default}
      .study-atlas-stepper span,.study-atlas-link,.study-atlas-footer{font:11px monospace;letter-spacing:.09em}.study-atlas-stepper span{color:#dcf46d;padding:0 4px}
      .study-atlas-rail{--atlas-card-width:91%;position:relative;display:flex;align-items:flex-start;gap:14px;overflow-x:auto;overscroll-behavior-x:contain;scroll-snap-type:x mandatory;scrollbar-width:thin;scrollbar-color:#3c7881 #0b1a22;padding:3px 0 12px;cursor:grab;user-select:none}
      .study-atlas-rail.is-dragging{scroll-snap-type:none}.study-atlas-rail.is-dragging,.study-atlas-rail.is-dragging *{cursor:grabbing}
      .study-atlas-card{position:relative;flex:0 0 var(--atlas-card-width);min-width:0;scroll-snap-align:start;overflow:hidden;border:1px solid color-mix(in srgb,var(--atlas-tone) 48%,#193139);background:linear-gradient(115deg,#102631 15%,#08161d 74%);clip-path:polygon(0 0,calc(100% - 18px) 0,100% 18px,100% 100%,18px 100%,0 calc(100% - 18px))}
      .study-atlas-card:last-child{margin-right:calc(100% - var(--atlas-card-width))}
      .study-atlas-card::before{content:'';position:absolute;top:0;left:0;width:48px;height:3px;background:var(--atlas-tone);box-shadow:0 0 14px var(--atlas-tone);pointer-events:none}
      .study-atlas-progress{position:relative;isolation:isolate;font:inherit;color:inherit;text-align:left;width:100%;min-height:252px;display:grid;align-content:center;gap:10px;background:transparent;border:0;cursor:pointer;padding:22px 20px}
      .study-atlas-progress:hover,.study-atlas-courses button:hover{background:#1a424543}.study-atlas button:focus-visible,.study-atlas-rail:focus-visible{outline:2px solid var(--atlas-tone,#71edd7);outline-offset:-3px}
      .study-atlas-name,.study-atlas-phase{color:var(--atlas-tone);font-weight:700}.study-atlas-phase{font-size:14px}
      .study-atlas-progress strong{font-size:clamp(22px,3.1vw,39px);line-height:1.2;color:#f2fffd;text-shadow:0 0 20px color-mix(in srgb,var(--atlas-tone) 42%,transparent)}
      .study-atlas-track{display:flex;gap:5px;max-width:265px}.study-atlas-track i{flex:1;height:5px;transform:skew(-15deg);background:#29434b}.study-atlas-track i.lit{background:var(--atlas-tone);box-shadow:0 0 10px color-mix(in srgb,var(--atlas-tone) 58%,transparent)}
      .study-atlas-line{display:block;max-width:38em;padding-inline-start:12px;border-inline-start:1px solid color-mix(in srgb,var(--atlas-tone) 55%,transparent);color:#d0e8e9;line-height:1.85;overflow-wrap:anywhere}
      .study-atlas-epigraph{display:block;margin-top:7px;color:var(--atlas-tone);font-size:.9em}.study-atlas-stats{font-size:12px;color:#aac7cf;line-height:1.55}.study-atlas-link{color:var(--atlas-tone);margin-top:3px}
      .study-atlas-projection{position:absolute;z-index:-1;pointer-events:none;right:1%;top:50%;transform:translateY(-50%);width:60%;height:100%;color:var(--atlas-tone);opacity:.15;filter:drop-shadow(0 0 7px currentColor)}
      .study-atlas-sigil{font-family:system-ui,sans-serif;animation:study-atlas-float 6s ease-in-out infinite}.study-atlas-footer{color:#96bac0;padding-top:10px;border-top:1px solid #4bdccc37}
      .study-atlas-courses{max-height:160px;overflow:auto;border-top:1px solid #335c63}.study-atlas-courses button{background:none;color:#d0e8e9;border:0;border-bottom:1px solid #263d47;font:inherit;text-align:left;padding:10px 20px;display:grid;gap:4px;width:100%;cursor:pointer;overflow-wrap:anywhere}.study-atlas-courses button span:last-child{color:var(--atlas-tone);font-size:12px}
      .study-atlas-card-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 20px;color:#aac7cf;font-size:12px}.study-atlas-card-actions button{font:inherit;color:var(--atlas-tone);background:#0a1c24;border:1px solid #3c646d;border-radius:3px;padding:5px 9px;cursor:pointer}.study-atlas-card-actions button:hover{border-color:var(--atlas-tone)}.study-atlas-card-actions button:disabled{opacity:.6;cursor:default}
      @container(min-width:620px){.study-atlas-rail{--atlas-card-width:77%;gap:18px}.study-atlas-progress{min-height:300px;padding:25px 40% 25px 26px}.study-atlas-projection{right:2%;width:37%;opacity:.88}}
      @keyframes study-atlas-float{50%{transform:translateY(-7px)}}@media(prefers-reduced-motion:reduce){.study-atlas-sigil{animation:none}}
      .study-atlas-empty{position:relative;isolation:isolate;min-height:235px;padding:25px;border:1px solid #3c646d;color:#dcefff;background:#0b202b}.study-atlas-empty h3{font-size:clamp(21px,4vw,34px);margin:10px 0}.study-atlas-empty button{margin-top:12px}
      .study-atlas-empty .study-atlas-projection{--atlas-tone:#83f9e0;opacity:.3}.study-subject-tree ul{list-style:none;padding:0;margin:12px 0;display:grid;gap:10px}.study-subject-tree li{border-left:2px solid #34465c;padding:4px 14px;color:#bbd1e1;display:grid;gap:6px;overflow-wrap:anywhere}.study-subject-tree li:has(>details){border-color:var(--atlas-tone)}.study-subject-tree summary{color:var(--atlas-tone);cursor:pointer;font-weight:650}
    `;
    function ReadingSettings(){
      const remote=useRemote('/panel/reading/settings',0),[mode,setMode]=React.useState(null),[message,setMessage]=React.useState(''),[saving,setSaving]=React.useState(false);
      return h('section',{style:box,'aria-label':'阅读采集设置'},h('h2',null,'采集场景'),
        h('select',{'aria-label':'采集场景',value:mode||remote.data?.mode||'auto',disabled:saving||!remote.data,onChange:async event=>{const next=event.target.value;setSaving(true);try{const result=await api('/panel/reading/settings',{mode:next});setMode(result.mode);setMessage('已保存，下一次开始采集时生效。');}catch(error){setMessage(error.message);}finally{setSaving(false);}},style:btn},
          h('option',{value:'auto'},'自动识别：文档、VS Code 或B站视频'),h('option',{value:'reading'},'桌面阅读：论文、文档、VS Code'),h('option',{value:'video'},'视频课程'),
          h('option',{value:'chatgpt'},'ChatGPT 对话（浏览器）'), h('option',{value:'codex'},'Codex 对话（桌面客户端）')),
        h('p',{style:muted},'PDF、Word 和 VS Code 支持自动识别；普通浏览器论文可选桌面阅读，再选定窗口。只采集选定窗口在前台显示的内容，切换窗口或文件时暂停。'),
        h('p',{style:muted},'VS Code 通过本地阅读扩展直接读取活动文本编辑器的可见行，保留缩进和符号；终端、聊天和未打开的文件不采集，横向隐藏的行内文字会包括在内。一轮对应一个文件，修改文件后请结束再重新采集。'),
        (mode || remote.data?.mode) === 'chatgpt' ? h('p',{style:muted},'配对浏览器采集桥后，在总览点「开始采集」。打开要学习的 chatgpt.com 对话，点击扩展图标，然后滚动阅读。结束采集会将正文保存在本机。点击「出题」后，所选模型会处理这些材料。') : null,
        (mode || remote.data?.mode) === 'codex' ? h('p',{style:muted},'在总览点「开始采集」并选择一个 Codex 会话，读取最近最多 12 轮已完成的文本问答。结束后保存到本机学习库，点击「出题」后由所选模型处理。') : null,
        h('p',{style:muted},'OCR在本机运行，原始截图不保存、不上传。识别正文会用于所选AI模型的提要、出题和知识导航；公式、图表和分栏顺序可能需要复核。'),
        remote.data?.available===false?h('p',{style:muted},'当前环境未启用桌面OCR。'):null,message?h('p',{role:'status'},message):null,remote.error?h('p',{role:'alert'},remote.error):null);
    }
    function AudioSettings() {
      const remote = useRemote('/panel/audio', 0);
      const [mode, setMode] = React.useState('');
      const [message, setMessage] = React.useState('');
      const [saving, setSaving] = React.useState(false);
      React.useEffect(() => { if (remote.data && !mode) setMode(remote.data.mode); }, [remote.data, mode]);
      const names = { standby: '待采集', 'subtitle-preferred': '使用课程字幕', recording: '正在采集应用音频', transcribing: '正在本地转写', ready: '转写材料已保存', failed: '音频处理失败', unavailable: '音频采集未启用', 'waiting-player': '等待确认播放器' };
      return h('section', { style: box, 'aria-label': '本地音频识别设置' }, h('h2', null, '字幕与本地音频'),
        h('p', { style: muted }, 'SenseVoice本地识别，Silero检测语音；转写本身不调用GPT或DeepSeek。音频不上传，语音片段起止时间为估计值。'),
        h('select', { 'aria-label': '课程内容来源', value: mode, onChange: (e) => setMode(e.target.value), style: { ...btn, maxWidth: '100%' } },
          h('option', { value: 'fallback' }, '字幕优先，无可用字幕时转本地音频'), h('option', { value: 'force' }, '强制本地音频（验收用）'), h('option', { value: 'off' }, '仅使用字幕')),
        h('p', { style: muted }, 'Windows按当前播放器进程及其子进程采集，不采集麦克风。浏览器其他标签页的声音可能同属该进程，请避免同时播放。暂停、离开学习页面或失去播放信号时停止音频采集。'),
        h('p', null, (remote.data?.ready ? '本地模型已就绪 · ' : '本地模型未就绪 · ') + (names[remote.data?.state] || '正在读取状态') + (remote.data?.pending ? ' · 待转写 ' + remote.data.pending + ' 段' : '')),
        remote.data?.error ? h('p', { role: 'alert' }, remote.data.error) : null,
        remote.error ? h('p', { role: 'alert' }, remote.error) : null,
        button('保存内容来源', async () => { setSaving(true); try { await api('/panel/audio/settings', { mode }); setMessage('已保存，下一次开始采集时生效。'); } catch (e) { setMessage(e.message); } finally { setSaving(false); } }, saving || !mode),
        message ? h('p', { role: 'status' }, message) : null);
    }
    function ModelSettings({revision=0}) {
      const remote = useRemote('/panel/models/settings', revision);
      const directory = useRemote('/panel/models/catalog', revision);
      const [draft, setDraft] = React.useState(null);
      const [catalog, setCatalog] = React.useState([]);
      const [loading, setLoading] = React.useState(false);
      const [message, setMessage] = React.useState('');
      const refreshing = React.useRef(false);
      React.useEffect(() => { if (remote.data && !draft) setDraft(remote.data); }, [remote.data, draft]);
      React.useEffect(() => { if (directory.data) setCatalog(directory.data.providers); }, [directory.data]);
      const refresh = async () => {
        if (refreshing.current) return;
        refreshing.current = true;
        setLoading(true); setMessage('');
        try {
          await api('/panel/models/catalog/request', {});
          setMessage('已请求宿主刷新模型目录，列表会自动更新。');
        } catch (error) { setMessage(error.message); }
        finally { refreshing.current = false; setLoading(false); }
      };
      React.useEffect(() => { refresh(); }, []);
      const choices = catalog.flatMap((p) => p.models.map((m) => ({ provider: p.id, model: m.id, label: (p.name || p.id) + ' · ' + m.name })));
      const key = (m) => m ? JSON.stringify([m.provider, m.model]) : '';
      const save = async () => {
        setLoading(true);
        try { await api('/panel/models/settings', draft); setMessage('已保存。新任务使用新设置，正在运行的任务沿用启动时的模型。'); }
        catch (error) { setMessage(error.message); }
        finally { setLoading(false); }
      };
      return h('section', { style: { ...box, borderColor: '#31586e', background: 'linear-gradient(135deg,#0b1928,#10151e)' }, 'aria-label': '学习模型设置' },
        h('h2', null, '模型与用量'),
        h('p', { style: muted }, '设置保存在当前数据模式。ChatGPT需先在DSH「设置 → 模型 → ChatGPT」登录授权，模型列表来自宿主。学习面板不保存账号凭据。'),
        button(loading ? '正在读取…' : '刷新可用模型', refresh, loading),
        h('p', { style: muted }, directory.error ? directory.error : directory.data?.updatedAt ? '已读取 ' + choices.length + ' 个模型' : '等待宿主读取模型目录…'),
        catalog.filter((p) => p.error).map((p) => h('p', { key: p.id, style: muted }, (p.name || p.id) + ' · ' + p.error)),
        remote.error ? h('p', { role: 'alert' }, remote.error) : null,
        draft ? h('div', null,
          [['generation', '课程提要与出题'], ['grading', '主观判卷与追问'], ['navigation', '联网知识导航']].map(([task, label]) => {
            const current = draft.tasks[task], value = key(current);
            return h('label', { key: task, style: { display: 'block', margin: '18px 0' } }, h('div', { style: heading }, label),
              h('select', { 'aria-label': label + '模型', value, disabled: loading, style: { ...btn, width: '100%', maxWidth: 720, background: '#101c29' }, onChange: (e) => {
                const pair = e.target.value ? JSON.parse(e.target.value) : null;
                setDraft({ ...draft, tasks: { ...draft.tasks, [task]: pair ? { provider: pair[0], model: pair[1] } : null } });
              } }, h('option', { value: '' }, '默认 · DeepSeek Flash（学习插件默认配置）'),
              current && !choices.some((m) => key(m) === value) ? h('option', { value }, current.provider + ' · ' + current.model + '（暂未出现在可用列表）') : null,
              choices.map((m) => h('option', { key: key(m), value: key(m) }, m.label))));
          }),
          h('label', { style: { display: 'block', margin: '18px 0' } }, h('div', { style: heading }, '知识导航搜索来源'),
            h('select', { 'aria-label': '知识导航搜索来源', value: draft.searchProvider || 'dsh', style: { ...btn, background: '#101c29' }, onChange: (e) => setDraft({ ...draft, searchProvider: e.target.value }) },
              h('option', { value: 'dsh' }, 'DSH 搜索服务'), h('option', { value: 'chatgpt' }, 'GPT 原生联网搜索'))),
          h('p', { style: muted }, 'GPT原生搜索使用上方所选的ChatGPT知识导航模型及其账号额度；来源正文通过同一代理直接读取。'),
          h('label', { style: { display: 'block', marginBottom: 16 } }, h('input', { type: 'checkbox', checked: draft.autoResearch, onChange: (e) => setDraft({ ...draft, autoResearch: e.target.checked }) }), ' 字幕准备后自动构建知识导航'),
          h('p', { style: muted }, '关闭自动导航后，仍可在知识树手动构建。重新开启后从新采集的材料开始，旧材料可按需手动补建。模型切换不重做已有题目或已保存的导航，也不会在额度不足时自动换模型或搜索来源重试。'),
          button('保存模型设置', save, loading)) : h('p', null, remote.error?'设置尚未读取，请点击上方“刷新”重试。':'正在读取设置…'),
        message ? h('p', { role: 'status' }, message) : null);
    }
    function Panel() {
      const [revision, setRevision] = React.useState(0);
      const [tab, setTab] = React.useState(() => { const view = saved('view', 'overview'); return view === 'capture' ? 'overview' : view; });
      const [treeAxis, setTreeAxis] = React.useState('');
      const [treeCourseKey, setTreeCourseKey] = React.useState('');
      const [selected, setSelected] = React.useState(() => saved('session'));
      const [focus, setFocus] = React.useState(null);
      const [courseId, setCourse] = React.useState(() => saved('course'));
      const [historySelection, setHistorySelection] = React.useState(false);
      const [historyId, setHistory] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [fallback, setFallback] = React.useState('');
      const [validation, setValidation] = React.useState(BASE.endsWith(':7789'));
      const lock = React.useRef(false);
      const workspace = useRemote('/panel/workspace', revision);
      const capture = useRemote('/panel/capture', revision);
      const researchStatus = useRemote('/panel/research', revision);
      const session = useRemote(selected && ['study', 'review'].includes(tab) ? '/panel/sessions/' + encodeURIComponent(selected) : null, revision);
      const historical = useRemote(historyId ? '/panel/cards/' + encodeURIComponent(historyId) + '/history' : null, revision);
      const data = workspace.data;
      const learnedSubjects = data?.progress || [];
      const treeProgress = learnedSubjects.find((item) => item.axis === treeAxis) || learnedSubjects[0];
      const treeCourses = treeProgress?.courses || [];
      const treeCourse = treeCourses.find((course) => course.key === treeCourseKey);
      const treeCourseId = treeCourse?.id || '';
      const researched = researchStatus;
      const hasResearchMap = !!researched.data?.nodes?.length;
      const showMathMap = (!treeAxis || treeAxis === 'math') && treeProgress?.axis === 'math' && (!treeCourse || treeCourseId);
      const knowledge = useRemote(tab === 'tree' && showMathMap ? '/panel/knowledge' + (treeCourseId ? '?courseId=' + encodeURIComponent(treeCourseId) : '') : null, revision);
      React.useEffect(() => {
        if (!data) return;
        if (!data.courses.length && selected) { setSelected(''); persist('session', ''); setFocus(null); }
        if (!['study', 'review'].includes(tab)) {
          if (courseId && !data.courses.some((c) => c.id === courseId)) { setCourse(''); persist('course', ''); }
          return;
        }
        if (!data.courses.some((c) => c.id === courseId)) {
          const id = data.sessions.find((s) => s.id === selected)?.courseId || data.courses[0]?.id || '';
          if (id) { setCourse(id); persist('course', id); }
          return;
        }
        if (historySelection) return;
        const candidates = data.sessions.filter((s) => s.courseId === courseId && s.kind === (tab === 'study' ? 'lesson' : 'review'));
        const savedRun = candidates.find((s) => s.id === selected && !s.endedAt);
        const id = savedRun?.id || candidates.find((s) => !s.endedAt && !s.complete)?.id || candidates.find((s) => !s.endedAt)?.id || candidates.find((s) => s.pending)?.id || candidates[0]?.id || '';
        if (id !== selected) { setSelected(id); persist('session', id); setFocus(null); }
      }, [selected, data, courseId, tab, historySelection]);
      const refresh = () => setRevision((value) => value + 1);
      const switchMode = () => {
        if (lock.current) return;
        const next = !validation;
        try { localStorage.setItem('study.m2.validation', String(next)); } catch { /* 本次切换仍生效 */ }
        BASE = next ? 'http://127.0.0.1:7789' : 'http://127.0.0.1:7788';
        setValidation(next); setSelected(saved('session')); setTab(saved('view', 'overview') === 'capture' ? 'overview' : saved('view', 'overview')); setTreeAxis(''); setTreeCourseKey('');
        setFocus(null); setHistory(null); setCourse(saved('course')); setHistorySelection(false); setNotice(''); setFallback(''); refresh();
      };
      const open = (id, kind, courseHint) => {
        const run = data?.sessions.find((s) => s.id === id);
        const nextTab = (kind || run?.kind) === 'review' ? 'review' : 'study';
        if (run || courseHint) { setCourse(run?.courseId || courseHint); persist('course', run?.courseId || courseHint); }
        setSelected(id); persist('session', id); setHistorySelection(true); setFocus(null); setTab(nextTab); persist('view', nextTab); setNotice('');
      };
      const navigate = (value, keepTree = false) => { if (value === 'tree' && !keepTree) { setTreeAxis(''); setTreeCourseKey(''); } setTab(value); persist('view', value); setHistory(null); setHistorySelection(false); };
      const openTree = (axis, course) => {
        setTreeAxis(axis); persist('tree-axis', axis);
        setTreeCourseKey(course?.key || ''); persist('tree-course', course?.key || '');
        setCourse(course?.id || ''); persist('course', course?.id || ''); navigate('tree', true);
      };
      const act = async (fn) => {
        if (lock.current) return;
        lock.current = true; setBusy(true); setNotice('');
        try { await fn(); refresh(); return true; }
        catch (error) { setNotice(error.message || String(error)); return false; }
        finally { lock.current = false; setBusy(false); }
      };
      const handoff = (prompt, copyOnly = false) => act(async () => {
        if (openConversation && !copyOnly) { await openConversation(prompt); setNotice('已请求打开DSH对话并填入草稿，请检查后发送；若未成功，可复制判卷请求。'); return; }
        setFallback(prompt);
        try { await navigator.clipboard.writeText(prompt); setNotice('请求已复制；粘贴到DSH对话即可。'); }
        catch { setNotice('请复制下方请求到DSH对话。'); }
      });
      const captureAction = (action) => act(async () => {
        const result = await api('/panel/capture/' + action, {});
        if (action === 'questions') { open(result.sessionId, 'lesson', result.courseId); setNotice(result.hasQuestions ? '已打开题目。' : result.noQuestions ? '本段暂不出题，采集内容已保存。' : '已提交出题任务。'); }
      });
      const current = session.data?.id === selected ? session.data : null;
      const card = current?.cards.find((c) => c.id === focus) || current?.cards.find((c) => c.id === current.nextCardId) || current?.cards[0];
      const cardIndex = current && card ? current.cards.findIndex((c) => c.id === card.id) : -1;
      const sessions = (data?.sessions || []).filter((s) => !courseId || s.courseId === courseId);
      const start = () => act(async () => {
        const result = await api('/panel/review/start', { courseId: courseId || null });
        if (result.session) { open(result.session.id, 'review'); setNotice(result.resumed ? '已恢复未结束的复习。' : '已开始复习，进度会自动保存。'); }
        else setNotice('现在没有到期复习，可以继续当前学习。');
      });
      const selectedGeneration = capture.data?.generation?.sessionId === selected ? capture.data.generation : null;
      const emptyLesson = () => selectedGeneration?.state === 'no-questions'
        ? h('div', { style: box, 'aria-label': '本段暂不出题' }, h('strong', null, '本段暂不出题'), h('p', null, selectedGeneration.reason),
          h('p', { style: muted }, '采集内容已保存。继续采集后续讲解，形成可检验的知识后再出题；本段无需重复尝试。'), button('返回总览继续采集', () => navigate('overview'), busy))
        : h('div', { style: box }, selectedGeneration?.state === 'failed' ? '出题未完成：' + (selectedGeneration.reason || '请返回总览检查材料后重试。')
          : selectedGeneration?.state === 'queued' ? '已排队，等待DSH接单。'
          : selectedGeneration?.state === 'processing' ? '正在分析已采集内容并出题。'
          : '这门课还没有题目；请在总览采集后出题。');
      const task = () => !card && tab === 'study' && selectedGeneration ? emptyLesson() : current && current.courseId === courseId && current.kind === (tab === 'review' ? 'review' : 'lesson') ? h('div', { style: { minWidth: 0 } },
        h('div', { style: { ...muted, marginBottom: 12, overflowWrap: 'anywhere' } }, current.title + ' · 已作答 ' + current.answered + '/' + current.total + (current.pending ? ' · 待判/待补充 ' + current.pending : '') + (historySelection ? ' · 从记录打开' : '')),
        current.endedAt ? h('p', { style: muted }, '这组题已经结束，可查看原作答；新内容生成后会自动接续。') : null,
        current.legacyReview ? h('p', { style: muted }, '旧版复习仅展示实际保存的作答，未作答的旧队列无法还原。') : null,
        card ? h(Card, { key: current.id + ':' + card.id, card, sessionId: current.id, busy, closed: !!current.endedAt,
          submit: (cardId, raw) => act(async () => { await api('/panel/sessions/' + encodeURIComponent(current.id) + '/answer', { cardId, raw }); setFocus(cardId); }),
          reply: (answerId, turn, raw) => act(() => api('/panel/answers/' + encodeURIComponent(answerId) + '/followup', { turn, raw })),
          retryGrade: (answerId) => act(() => api('/panel/answers/' + encodeURIComponent(answerId) + '/grade', {})), history: setHistory }) : h('p', null, '这组题已停用或尚未生成。'),
        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 } },
          button('上一题', () => setFocus(current.cards[cardIndex - 1]?.id), busy || cardIndex <= 0),
          h('span', { style: { padding: 8 } }, current.total ? (cardIndex + 1) + ' / ' + current.total : '0 / 0'),
          button('下一题', () => setFocus(current.cards[cardIndex + 1]?.id), busy || cardIndex < 0 || cardIndex >= current.total - 1),
          button(current.endedAt ? '本次已结束' : current.pending ? '结束本次（保留待处理）' : '完成本次', () => act(() => api('/panel/sessions/' + encodeURIComponent(current.id) + '/finish', {})), busy || !!current.endedAt || !current.complete)))
        : selected && session.loading ? h('div', { style: box }, '正在读取题目…') : tab === 'review' ? h('div', { style: box }, '点击开始复习，系统会保存并接续这门课的队列。') : emptyLesson();
      const summary = () => h('aside', { 'aria-label': '当前课程进度', style: { minWidth: 0 } },
        h('div', { style: box }, h('div', { style: heading }, '课程进度'),
          h('p', { style: { ...muted, lineHeight: 1.7 } }, '作答自动保存；选择课程后直接接续未完成的内容。'),
          current?.courseId === courseId ? h('p', null, '当前题组：' + current.answered + ' / ' + current.total + ' 已作答') : null,
          h('p', null, '到期复习：' + data.due.filter((c) => c.courseId === courseId).length + ' 题'),
          button('查看知识树', () => {
            const subject = learnedSubjects.find((item) => item.courses.some((course) => course.id === courseId));
            openTree(subject?.axis || '', subject?.courses.find((course) => course.id === courseId));
          }, busy)),
        h('div', { style: box }, h('div', { style: heading }, '待判卷 / 追问'),
          sessions.some((s) => s.pending) ? sessions.filter((s) => s.pending).map((s) => h('div', { key: s.id, style: { padding: '8px 0', borderBottom: btn.border } },
            h('p', { style: muted }, (s.kind === 'review' ? '复习' : '学习') + ' · ' + time(s.startedAt) + ' · ' + s.pending + ' 题'), button('处理待判 / 追问', () => open(s.id), busy))) : h('p', { style: muted }, '暂无待处理作答。')));
      return h('div', { className: 'study-panel', style: { padding: '20px 24px', width: '100%', height: '100%', maxHeight: '100vh', minWidth: 0, minHeight: 0, boxSizing: 'border-box', overflowY: 'auto', color: 'inherit', fontSize: 14 } },
        h('style', null, '.study-panel *{box-sizing:border-box}.study-panel select{color-scheme:dark;background:#15171b;color:#e6edf5}.study-task-container{container-type:inline-size}.study-task-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:24px}.study-task-layout>*,.study-panel textarea{min-width:0}.study-panel label{overflow-wrap:anywhere}@container(min-width:1000px){.study-task-layout{grid-template-columns:minmax(0,2fr) minmax(280px,1fr)}}'),
        h('style', null, atlasStyles),
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 16 } },
          h('div', null, h('div', { style: { fontSize: 20, fontWeight: 650 } }, '学习与复习'), h('div', { style: muted }, '进度自动保存 · 主观题自动判卷与追问')),
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, button(validation ? '返回正式数据' : '使用试用数据', switchMode, busy), button('刷新', refresh, busy), button('开始 / 继续到期复习', start, busy || !data))),
        h('div', { style: { ...muted, marginBottom: 12 } }, validation ? '试用模式 · 使用独立测试数据，操作不计入正式学习记录' : '正式学习数据'),
        h('div', { role: 'tablist', 'aria-label': '学习面板导航', style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 } },
          [['overview', '总览'], ['tree', '知识树'], ['study', '学习'], ['review', '复习'], ['wrong', '错题'], ['progress', '记录'], ['settings', '设置']].map(([key, label]) => h('button', { key, type: 'button', role: 'tab', 'aria-selected': tab === key, onClick: () => navigate(key), style: { ...btn, fontWeight: tab === key ? 650 : 400, ...(tab === key ? { color: '#91eadc', borderColor: '#426b83', background: '#142539' } : {}) } }, label))),
        tab === 'settings' ? h('div', null, h(ModelSettings, { key: BASE,revision }), h(ReadingSettings,{key:BASE}), h(AudioSettings, { key: BASE })) : null,
        capture.error && tab === 'overview' ? h('p', { role: 'alert' }, '采集状态读取失败：'+capture.error) : null,
        workspace.error || session.error || historical.error || knowledge.error || researchStatus.error || researched.error ? h('div', { role: 'alert', style: box }, '读取失败：' + (workspace.error || session.error || historical.error || knowledge.error || researchStatus.error || researched.error) + '。已保存的数据仍在，可以稍后刷新。') : null,
        notice ? h('div', { role: 'status', style: box }, notice) : null,
        fallback ? h('textarea', { readOnly: true, value: fallback, rows: 5, 'aria-label': '复制到DSH的请求', style: { width: '100%', boxSizing: 'border-box', marginBottom: 16 } }) : null,
        !data ? h('p', { style: muted }, '正在读取学习数据…') : null,
        data && !['capture', 'overview', 'tree', 'settings'].includes(tab) ? h('div', { style: { ...muted, marginBottom: 14 } },
          '到期 ' + data.due.length + ' · 待处理判卷/追问 ' + data.sessions.reduce((n, s) => n + s.pending, 0),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, margin: '8px 0 0 12px', maxWidth: 'calc(100% - 12px)' } }, ['study', 'review'].includes(tab) ? '当前课程' : '查看课程',
            h('select', { 'aria-label': '当前课程', value: courseId, onChange: (e) => { setCourse(e.target.value); persist('course', e.target.value); setSelected(''); persist('session', ''); setHistorySelection(false); setFocus(null); setHistory(null); }, style: { ...btn, minWidth: 0, maxWidth: '100%' } },
              h('option', { value: '', disabled: ['study', 'review'].includes(tab) }, ['study', 'review'].includes(tab) ? '选择课程' : '全部课程'), data.courses.map((c) => h('option', { key: c.id, value: c.id }, c.title))))) : null,
        tab === 'overview' && data?.progress ? h(ProgressOverview, {
          progress: data.progress, capture: capture.data, openTree, busy,
          nameSubject: subject => act(() => api('/panel/subject-presentation/request', { subject })),
          controls: h(CaptureControls, { data: capture.data, busy, action: captureAction, selectReading: id => act(() => api('/panel/reading/select', { id })) }),
        }) : null,
        ['overview', 'tree'].includes(tab) ? h('div', { style: { marginTop: 12 } },
          h('p', { style: muted }, researchStatus.data?.autoResearch === false ? '自动知识导航已关闭，课程不会自动建树。可在设置中开启，或在知识树中手动构建。' : 'AI在学习材料准备后自动归类并检索知识路径；结果会自动更新。'),
          researchStatus.data?.queued?.length ? h('p', { role: 'status', style: muted }, '知识导航任务待完成，请保持DSH开启。完成后会自动显示。') : null,
          (researchStatus.data?.navigationMode==='overview-v1'?[]:researchStatus.data?.foundationProgress||[]).map(p=>h('div',{key:p.sessionId,style:box,role:'status'},h('p',null,p.label+' · '+p.concepts+' 个必要概念 · '+p.sources+' 份资料'+(p.alignedConcepts!=null?' · 材料对齐 '+p.alignedConcepts+'/'+p.concepts:'')),
            p.stage==='incomplete'?h('div',null,h('p',{style:muted},'当前基础链未通过完整性检查，图中已有课程节点不代表基础已经补齐。进度已保留。'),h('ul',null,p.gaps.map((gap,i)=>h('li',{key:i},gap))),button('继续补全基础',()=>act(()=>api('/panel/research/'+encodeURIComponent(p.sessionId)+'/request',{foundations:true})),busy)):null)),
          (researchStatus.data?.pending || []).map((r) => h('div', { key: r.key, style: box }, h('p', null, '学科归属待确认 · ' + r.subject + ' · ' + r.reason),
            button('确认归入 ' + r.subject, () => act(() => api('/panel/research/confirm', { key: r.key })), busy))),
          researchStatus.data?.failures?.length ? h('details',{'aria-label':'知识导航未完成记录',style:{...box,padding:'10px 14px',color:'#8caac2'}},h('summary',{style:{cursor:'pointer'}},'知识导航有 '+researchStatus.data.failures.length+' 项未完成 · 已有知识树可继续使用'),
          researchStatus.data.failures.map((r) => h('div', { key: r.key,style:{borderTop:'1px solid #254052',marginTop:10,paddingTop:8} }, h('p',{style:muted},r.courseTitle+' · '+time(r.at)),h('p', null, /insufficient balance/i.test(r.message) ? 'DSH模型账户余额不足，恢复额度后可点击重试知识导航。课程材料已保留。' : r.message),
            r.legacyFoundation?h('p',{style:muted},'这是旧版完整基础补全的失败记录。现在改为初次课程概览、按节点逐层深挖；重试只生成课程概览，旧资料仍保留。'):null,
            r.code==='chatgpt-sharing-limit'?h('p',{style:muted},h('a',{href:r.usageUrl,target:'_blank',rel:'noreferrer'},'查看 ChatGPT 总用量和应用限额'),' · 本页面不能读取具体限制或重置时间，不会自动改限额、付费或切换模型。'):null,
            button('重试知识导航', () => act(() => api('/panel/research/' + encodeURIComponent(r.sessionId) + '/request', {})), busy)))):null) : null,
        tab === 'tree' && data && !treeProgress ? h('section', { className: 'study-atlas', 'aria-label': '空知识树' }, h('h2', null, '等待第一棵知识树'), h('p', null, '学习记录会在这里长出学科和课程分支。'), button('返回总览', () => navigate('overview'))) : null,
        tab === 'tree' && treeProgress ? h('div', null,
          h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }, 'aria-label': '知识树学科' },
            h('button',{type:'button','aria-pressed':!treeAxis,onClick:()=>openTree(''),style:btn},'全部学科 · 同图'),
            learnedSubjects.map((item) => h('button', { key: item.axis, type: 'button', 'aria-pressed': item.axis === treeAxis, onClick: () => openTree(item.axis), style: { ...btn, color: item.axis === treeAxis ? subjectTheme(item).tone : 'inherit' } }, item.name)),
            treeAxis ? h('select', { 'aria-label': '当前课程', value: treeCourse?.key || '', style: { ...btn, minWidth: 0, maxWidth: '100%' },
              onChange: (event) => openTree(treeProgress.axis, treeCourses.find((course) => course.key === event.target.value)) },
              h('option', { value: '' }, '本学科全部课程'), treeCourses.map((course) => h('option', { key: course.key, value: course.key }, course.title))) : null),
          h('div', { style: { marginBottom: 12 } }, button('构建所选课程知识树', () => act(async () => {
            const courseId = treeCourse?.id || treeCourses.find((course) => course.id)?.id;
            const result = await api('/panel/research/request', { courseId });
            setNotice(result.cached ? '已使用保存的知识导航。' : '知识导航已排队，完成后会自动显示在这里。');
          }), busy || !treeCourses.some((course) => course.id))),
          hasResearchMap ? h(ResearchMap, { key: BASE + ':research:' + treeAxis, graph: researched.data, busy, focusSubject: treeAxis,
            assignArea: (subject, area) => act(() => api('/panel/research/subject-area', { subject, area })),
            explore:(id)=>act(async()=>{const result=await api('/panel/research/nodes/'+encodeURIComponent(id)+'/explore',{});setNotice(result.cached?'已保留本节点的一层前置，可选择下层节点继续。':'一层深挖已排队，完成后自动更新；其他分支保留。');}),
            assess: (id, state) => act(() => api('/panel/research/nodes/' + encodeURIComponent(id) + '/assessment', { state })),
            check: (id, answer) => act(() => api('/panel/research/nodes/' + encodeURIComponent(id) + '/check', { answer })),
          }) : null,
          showMathMap ? h('details', { open: !hasResearchMap },
            h('summary', { style: { ...btn, marginBottom: 12 } }, '数学基础自检与作答依据'),
            knowledge.data ? h(KnowledgeMap, { key: BASE + ':' + treeCourseId, data: knowledge.data, busy, openSession: open,
            assess: (id, state) => act(() => api('/panel/knowledge/' + encodeURIComponent(id) + '/assessment', { state, courseId: treeCourseId || null })),
            locate: (nodeId) => act(() => api('/panel/knowledge/current', { nodeId, courseId: treeCourseId || null })),
            check: (id, answer) => act(() => api('/panel/knowledge/' + encodeURIComponent(id) + '/check', { answer, courseId: treeCourseId || null })),
          }) : h('p', { style: muted }, knowledge.error?'数学自检读取失败，请点击上方“刷新”重试。':'正在读取数学自检…')) : null,
          treeAxis ? h(SubjectTree, { progress: treeProgress, courseKey: treeCourse?.key }) : null) : null,
        tab === 'study' && data ? h('div', { className: 'study-task-container' }, h('div', { className: 'study-task-layout' }, task(), summary())) : null,
        tab === 'review' && data ? h('div', { className: 'study-task-container' }, h('div', { className: 'study-task-layout' },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: box }, h('div', { style: heading }, '到期复习'),
              h('p', { style: muted }, '每次取这门课最多20道到期题。退出后自动接续；学习与复习分别保存进度。'), button('开始 / 继续', start, busy)),
            task()), summary())) : null,
        tab === 'wrong' && data ? h('div', { style: box }, h('div', { style: heading }, '错题本'),
          h('p', { style: muted }, '保留曾经答错或主观未通过的题目；待判和待补充不会被当作错题。'),
          data.wrong.length ? data.wrong.filter((c) => !courseId || c.courseId === courseId).map((c) => h('div', { key: c.id, style: { padding: '12px 0', borderBottom: btn.border } },
            h('div', null, c.question), h('div', { style: muted }, c.title + ' · 作答 ' + c.attempts + ' 次'), button('答案与历史', () => setHistory(c.id), busy))) : h('p', null, '暂无错题。')) : null,
        tab === 'progress' && data ? h('div', null,
          h('div', { style: box }, h('div', { style: heading }, '经验与近7天记录'),
            Object.keys(data.xp).length ? Object.entries(data.xp).map(([axis, xp]) => h('p', { key: axis }, axis + ' · Lv.' + data.levels[axis] + ' · ' + xp + ' XP')) : h('p', { style: muted }, '暂无经验记录。'),
            h('div', { style: { display: 'flex', alignItems: 'end', gap: 8, height: 140 } }, data.days.map((d) => h('div', { key: d.date, style: { flex: 1, minWidth: 0, textAlign: 'center', fontSize: 11 } },
              h('div', null, d.xp), h('div', { style: { height: Math.max(2, d.xp / Math.max(1, ...data.days.map((x) => x.xp)) * 80), background: 'currentColor', opacity: .4, margin: '4px 15%' } }), h('div', null, d.date.slice(5)), h('div', { style: muted }, d.answers + '答'))))),
          h('div', { style: box }, h('div', { style: heading }, '学习与复习历史'), sessions.map((s) => h('div', { key: s.id, style: { padding: '12px 0', borderBottom: btn.border } },
            h('div', null, s.title + ' · ' + (s.kind === 'review' ? '复习' : '学习')), h('div', { style: muted }, time(s.startedAt) + ' · 已作答 ' + s.answered + '/' + s.total + ' · 待处理 ' + s.pending), button(s.pending ? '处理待判 / 追问' : '查看 / 继续', () => open(s.id), busy))))) : null,
        historyId ? h('div', { style: box }, h('div', { style: { display: 'flex', justifyContent: 'space-between' } }, h('div', { style: heading }, '本题历史'), button('关闭历史', () => setHistory(null))),
          historical.data?.cardId === historyId ? h('div', null, h('p', null, historical.data.question),
            historical.data.review ? h('p', { style: muted }, '下次复习：' + time(historical.data.review.dueAt)) : null,
            historical.data.attempts.map((a) => h('div', { key: a.id }, h(AnswerView, { answer: a }), button('打开这次会话', () => { open(a.sessionId); setHistory(null); })))) : h('p', { style: muted }, '正在读取历史…')) : null);
    }
    function Icon(props) {
      return h('svg', { width: props?.size || 20, height: props?.size || 20, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('path', { d: 'M4 4h7v16H4z M13 4h7v16h-7z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }));
    }
    return {
      mapMath: { projectPoint, zoomCamera, panCamera, pointerAnchor, neighborhood, layoutResearchGraph, directConnections, subjectArea },
      inject: ['slots'],
      apply(ctx) {
        hostConnection = typeof ctx.get === 'function' ? ctx.get('connection') : null;
        const navigation = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null;
        if (navigation && typeof navigation.startSession === 'function') openConversation = (prompt) => navigation.startSession(undefined, { prompt, whenDraftExists: 'append' });
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'study' }, Panel));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'study', order: 20, label: () => '学习面板' }, Icon));
      },
    };
  },
});

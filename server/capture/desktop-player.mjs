// Read-only, fixed CDP query. No input events, playback commands, cookies or storage access.
export const PLAYER_EXPRESSION = `(() => {
  const video = document.querySelector('video');
  const state = window.__INITIAL_STATE__;
  const details = state && state.videoData;
  const locationValue = String(location.href);
  const parse = (value) => { try { const u = new URL(value); return { bvid:u.searchParams.get('bvid') || u.pathname.match(/BV[a-zA-Z0-9]{10}/)?.[0], cid:u.searchParams.get('cid'), page:u.searchParams.get('p') || u.searchParams.get('page') }; } catch { return {}; } };
  const route = parse(locationValue), hash = parse('https://www.bilibili.com/'+String(location.hash).replace(/^#\\/?/,''));
  return { hasVideo:!!video, title:document.title, url:locationValue,
    bvid:route.bvid || hash.bvid || details?.bvid || null, cid:route.cid || hash.cid || details?.cid || null, page:route.page || hash.page || null,
    position:video && Number.isFinite(video.currentTime) ? video.currentTime : null,
    duration:video && Number.isFinite(video.duration) ? video.duration : null,
    rate:video?.playbackRate ?? null, playing:!!video && !video.paused && !video.ended && !video.seeking && video.readyState >= 3,
    ended:!!video?.ended, visible:document.visibilityState === 'visible' };
})()`;
function allowedPage(value) {
  try { const url = new URL(value); return ['file:','app:','bilibili:','bili:'].includes(url.protocol) || url.protocol === 'https:' && (url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')); }
  catch { return false; }
}
export function localSocket(value, port) {
  try { const url = new URL(value); return url.protocol === 'ws:' && !url.username && !url.password && ['127.0.0.1','localhost','[::1]'].includes(url.hostname) && Number(url.port) === port && url.pathname.startsWith('/devtools/page/'); }
  catch { return false; }
}
export async function connectPlayer(url, { Socket = WebSocket, timeout = 1300 } = {}) {
  const socket = new Socket(url), pending = new Map(); let serial = 0;
  const opened = new Promise((resolve,reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('connect-timeout')); },timeout);
    socket.addEventListener('open',() => { clearTimeout(timer); resolve(); },{once:true});
    socket.addEventListener('error',() => { clearTimeout(timer); reject(new Error('connect-error')); },{once:true});
  });
  socket.addEventListener('message',(event) => {
    try { const value = JSON.parse(event.data), item = pending.get(value.id); if (item) { pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(new Error('cdp-error')) : item.resolve(value.result); } } catch { }
  });
  socket.addEventListener('close',() => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('cdp-closed')); } pending.clear(); });
  await opened;
  return {
    request(method,params={}) {
      if (!['Runtime.evaluate','Page.getFrameTree','Page.createIsolatedWorld'].includes(method)) throw new Error('read-only method required');
      return new Promise((resolve,reject) => {
        const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error('cdp-timeout')); },timeout);
        pending.set(id,{resolve,reject,timer}); socket.send(JSON.stringify({id,method,params}));
      });
    },
    close() { socket.close(); },
  };
}
export async function readPlayerBridge(port, { fetcher = fetch, connect = connectPlayer } = {}) {
  if (port !== 7790) return null;
  let targets;
  try { const response = await fetcher('http://127.0.0.1:7790/json/list',{signal:AbortSignal.timeout(1500)}); if (!response.ok) return null; targets = await response.json(); }
  catch { return null; }
  if (!Array.isArray(targets)) return null;
  const items = await Promise.all(targets.filter((t) => ['page','webview','iframe'].includes(t.type) && allowedPage(t.url) && localSocket(t.webSocketDebuggerUrl,port)).slice(0,6).map(async (target) => {
    let reader;
    try {
      reader = await connect(target.webSocketDebuggerUrl);
      const values = [];
      const evaluate = async (contextId) => {
        const result = await reader.request('Runtime.evaluate',{expression:PLAYER_EXPRESSION,returnByValue:true,timeout:700,...(contextId ? { contextId } : {})});
        if (!result.exceptionDetails && result.result?.value) values.push(result.result.value);
      };
      await evaluate();
      if (!values.some((v) => v.hasVideo)) {
        const tree = await reader.request('Page.getFrameTree');
        for (const child of (tree.frameTree?.childFrames || []).slice(0,3)) {
          if (!allowedPage(child.frame.url)) continue;
          const world = await reader.request('Page.createIsolatedWorld',{frameId:child.frame.id,worldName:'study-readonly-player'});
          await evaluate(world.executionContextId);
        }
      }
      // Identity from a frame's parent is used only when there is a single identified route.
      const routes = values.filter((v) => /^BV[a-zA-Z0-9]{10}$/.test(v.bvid || ''));
      const routeIds = new Set(routes.map((v) => v.bvid));
      return values.filter((v) => v.hasVideo).map((v) => !v.bvid && routeIds.size === 1 ? { ...v,bvid:routes[0].bvid,page:v.page || routes[0].page } : v);
    } catch { return []; }
    finally { reader?.close(); }
  }));
  const videos = items.flat().filter((v) => Number.isFinite(v.duration) && v.duration > 0);
  // Multiple players are not guessed; the panel asks for confirmation instead.
  return videos.length === 1 ? videos[0] : null;
}

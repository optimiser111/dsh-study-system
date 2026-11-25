// 执行实际client.js与点击回调，使用轻量hook宿主；非浏览器视觉验收。
import fs from 'node:fs';
import vm from 'node:vm';
export function panelHarness({ base, storage = new Map(), navigation = true, failPost = false, nativeFullscreen = true, connection = null,fetchOverride=null,requestTimeoutMs=12000 } = {}) {
  const instances = new Map(), jobs = [], requests = new Set(), sent = [], copied = [], calls = [],polls=new Map();let pollId=0;
  const document = {
    fullscreenElement: null, listeners: new Map(),
    addEventListener(type, handler) { const set = this.listeners.get(type) || new Set(); set.add(handler); this.listeners.set(type, set); },
    removeEventListener(type, handler) { this.listeners.get(type)?.delete(handler); },
    dispatch(type, event = {}) { for (const handler of this.listeners.get(type) || []) handler(event); },
    async exitFullscreen() { this.fullscreenElement = null; this.dispatch('fullscreenchange'); },
  };
  const observers = new Set();
  class ResizeObserver {
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe(target) { this.target = target; }
    disconnect() { observers.delete(this); }
  }
  let active, hook = 0, Root, tree, pluginExports;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const owner = active, index = hook++;
      if (!(index in owner.hooks)) owner.hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [owner.hooks[index], (value) => { owner.hooks[index] = typeof value === 'function' ? value(owner.hooks[index]) : value; }];
    },
    useRef(value) { const [ref] = this.useState(() => ({ current: value })); return ref; },
    useEffect(effect, deps) {
      const owner = active, index = hook++, previous = owner.hooks[index];
      if (!previous || deps.some((d, i) => d !== previous.deps[i])) {
        jobs.push(() => { previous?.cleanup?.(); const item = { deps, cleanup: effect() }; owner.hooks[index] = item; });
        owner.hooks[index] = { deps };
      }
    },
  };
  function resolve(node, key = 'root') {
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const identity = key + ':' + node.type.name + ':' + (node.props.key || '');
      const instance = instances.get(identity) || { hooks: [] }; instances.set(identity, instance);
      const previous = active, oldHook = hook; active = instance; hook = 0;
      const result = node.type(node.props); active = previous; hook = oldHook;
      return resolve(result, identity);
    }
    if (node.props.ref && !node.props.ref.current) node.props.ref.current = {
      listeners: new Map(),
      addEventListener(type, handler, options) { this.listeners.set(type, { handler, options }); },
      removeEventListener(type) { this.listeners.delete(type); },
      captures: new Set(), setPointerCapture(id) { this.captures.add(id); }, hasPointerCapture(id) { return this.captures.has(id); }, releasePointerCapture(id) { this.captures.delete(id); },
      async requestFullscreen() { if (!nativeFullscreen) throw new Error('disabled'); document.fullscreenElement = this; document.dispatch('fullscreenchange'); },
    };
    return { ...node, children: node.children.map((child, i) => resolve(child, key + ':' + i)) };
  }
  vm.runInNewContext(fs.readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8'), {
    document, ResizeObserver, window: { __ModuleLoader__: { load(def) {
      const plugin = def.factory(() => React);
      pluginExports = plugin;
      plugin.apply({ get: (name) => name === 'connection' ? (connection ? { rpc: { async call(channel, endpoint, payload) {
        if (endpoint === 'models') return { ok: true, value: connection.catalog || [] };
        calls.push({ channel, endpoint, payload }); connection.startups++; connection.online = true; return { ok: true, value: { ready: true } };
      } } } : null) : navigation ? { startSession: async (...args) => sent.push(args) } : null,
        slots: { inject: (name, fn) => fn(), register: (slot, component) => { if (slot.name === 'main') Root = component; } } });
    } } },
    localStorage: { getItem: (k) => storage.get(k) || null, setItem: (k, value) => storage.set(k, value) },
    navigator: { clipboard: { writeText: async (value) => copied.push(value) } },
    AbortController,AbortSignal:{any:AbortSignal.any.bind(AbortSignal),timeout:ms=>AbortSignal.timeout(Math.min(ms,requestTimeoutMs))},setTimeout,clearTimeout,setInterval:fn=>{const id=++pollId;polls.set(id,fn);return id;}, clearInterval(id) {polls.delete(id);},
    fetch(url, options) {
      calls.push({ url, options });
      if (connection?.online === false) return Promise.reject(new TypeError('test connection refused'));
      const request = fetchOverride?.(url,options)||(failPost && options?.method === 'POST' ? Promise.resolve({ ok: false, status: 503, json: async () => ({ error: '模拟断网：未保存' }) })
        : fetch(base + new URL(url).pathname + new URL(url).search, options));
      requests.add(request); request.then(() => requests.delete(request), () => requests.delete(request)); return request;
    },
  });
  function render() { active = null; tree = resolve(React.createElement(Root)); while (jobs.length) jobs.shift()(); }
  async function settle() {
    for (let i = 0; i < 12; i++) { render(); await Promise.allSettled([...requests]); await new Promise((r) => setTimeout(r, 0)); }
    render(); return tree;
  }
  function all(predicate) { const result = []; const walk = (node) => { if (!node || typeof node !== 'object') return; if (predicate(node)) result.push(node); node.children.forEach(walk); }; walk(tree); return result; }
  function text(node = tree) { return !node || typeof node !== 'object' ? String(node ?? '') : node.children.map(text).join(''); }
  async function click(label) {
    const node = all((n) => n.type === 'button' && text(n) === label)[0];
    if (!node || node.props.disabled) throw new Error('button unavailable: ' + label);
    await node.props.onClick(); await settle();
  }
  function dispose() { for (const owner of instances.values()) for (const item of owner.hooks) item?.cleanup?.(); }
  return { settle, click, all, text, dispose, storage, sent, copied, calls, document,tickPolls(){for(const fn of [...polls.values()])fn();},
    resize(target, width, height) { for (const observer of observers) if (observer.target === target) observer.callback([{ contentRect: { width, height } }]); },
    get tree() { return tree; }, get mapMath() { return pluginExports.mapMath; } };
}

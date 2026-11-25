importScripts('chatgpt-bridge.js');
chrome.action.onClicked.addListener(tab => {
  if (chatGPTThread(tab.url)) return selectChatGPT(tab).catch(() => showChatStatus(tab.id, 'ERR', '连接失败，请核对扩展配对码和学习面板的正式／试用模式。'));
  return chrome.runtime.openOptionsPage();
});
let running = false;
let reportingTab = null;
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== 'study-observe' || !sender.tab || sender.frameId !== 0) return;
  (async () => {
    if (running) return { state: 'busy' };
    running = true;
    try {
      const settings = await chrome.storage.local.get(['enabled', 'token', 'port']);
      if (!settings.enabled || !/^[a-f0-9]{64}$/.test(settings.token || '')) return { state: 'disabled' };
      const tab = await chrome.tabs.get(sender.tab.id);
      // 发送方、真实标签页地址都必须是B站视频；不接受页面传入任意请求地址。
      const url = new URL(tab.url || '');
      if (url.origin !== 'https://www.bilibili.com' || !/^\/video\/BV[a-zA-Z0-9]{10}\/?$/.test(url.pathname)) return { state: 'outside' };
      const win = await chrome.windows.get(tab.windowId);
      // 其他后台B站标签页不能不断清掉正在观看标签页的连续时间。
      const focused = !!win.focused && !!tab.active;
      if (!focused && reportingTab !== sender.tab.id) return { state: 'background' };
      reportingTab = focused ? sender.tab.id : null;
      const idleState = await chrome.idle.queryState(300);
      const observation = { ...message.observation, url: 'https://www.bilibili.com'+url.pathname+'?p='+(url.searchParams.get('p') || '1'), focused, idleState };
      const port = settings.port === 7789 ? 7789 : 7788;
      const response = await fetch('http://127.0.0.1:'+port+'/collector/observe', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer '+settings.token },
        body: JSON.stringify(observation), signal: AbortSignal.timeout(4000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error('连接失败（'+response.status+'），请核对服务及配对码');
      await chrome.storage.local.set({ lastStatus: result.state, lastContact: Date.now() });
      return result;
    } catch {
      await chrome.storage.local.set({ lastStatus: '连接失败：请核对服务、端口和配对码。' });
      return { state: 'offline' };
    } finally { running = false; }
  })().then(reply, () => reply({ state: 'offline' }));
  return true;
});

function chatGPTThread(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://chatgpt.com'
      ? url.pathname.match(/^\/(?:g\/[\w-]+\/)?c\/([\w-]{1,128})\/?$/)?.[1] || null
      : null;
  } catch { return null; }
}

async function showChatStatus(tabId, text, title) {
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setTitle({ tabId, title });
}

async function chatRequest(settings, body) {
  const response = await fetch('http://127.0.0.1:' + settings.port + '/collector/chatgpt', {
    headers: { authorization: 'Bearer ' + settings.token, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(4000),
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error('ChatGPT capture bridge: HTTP ' + response.status);
  return response.json();
}

async function chatSettings() {
  const { enabled, token, port } = await chrome.storage.local.get(['enabled', 'token', 'port']);
  if (!enabled || !/^[a-f0-9]{64}$/.test(token || '')) return null;
  return { token, port: Number(port) === 7789 ? 7789 : 7788 };
}

async function focusedConversation(tabId, conversationId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active || chatGPTThread(tab.url) !== conversationId) return null;
  const window = await chrome.windows.get(tab.windowId);
  return window.focused && await chrome.idle.queryState(300) !== 'locked' ? tab : null;
}

async function selectChatGPT(tab) {
  const settings = await chatSettings();
  if (!settings) { await chrome.runtime.openOptionsPage(); return; }
  const conversationId = chatGPTThread(tab.url);
  const status = await chatRequest(settings);
  if (!status.enabled) {
    await showChatStatus(tab.id, '…', '请在学习面板选择 ChatGPT 对话并点「开始采集」，再点击此图标。');
    return;
  }
  const previous = (await chrome.storage.session.get('studyChatBinding')).studyChatBinding;
  const bindingId = previous?.tabId === tab.id && previous.conversationId === conversationId && previous.runId === status.runId && previous.port === settings.port
    ? previous.bindingId : crypto.randomUUID();
  const current = await focusedConversation(tab.id, conversationId);
  if (!current) return;
  // Install the sampler before binding so a failed injection leaves the run selectable.
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['chatgpt-content.js'] });
  if (!await focusedConversation(tab.id, conversationId)) return;
  const selected = { tabId: tab.id, conversationId, bindingId, runId: status.runId, port: settings.port };
  const result = await chatRequest(settings, { action: 'bind', conversationId, bindingId, runId: status.runId, title: current.title });
  if (!result.accepted) {
    await showChatStatus(tab.id, '…', '本轮已选定另一段对话，或采集已结束。');
    return;
  }
  await chrome.storage.session.set({ studyChatBinding: selected });
  await chrome.tabs.sendMessage(tab.id, { type: 'study-chat-start', conversationId, bindingId, runId: status.runId });
  await showChatStatus(tab.id, 'ON', '正在采集此 ChatGPT 对话。返回学习面板可结束采集。');
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!['study-chat-status', 'study-chat-frame'].includes(message?.type) || !sender.tab || sender.frameId !== 0) return;
  (async () => {
    const { studyChatBinding: binding } = await chrome.storage.session.get('studyChatBinding');
    const inactive = { state: 'inactive' };
    if (binding?.tabId !== sender.tab.id || binding.bindingId !== message.bindingId || binding.runId !== message.runId) return inactive;
    const settings = await chatSettings();
    if (!settings || binding.port !== settings.port) return inactive;
    if (!await focusedConversation(binding.tabId, binding.conversationId)) return { state: 'paused' };
    if (message.type === 'study-chat-status') {
      const status = await chatRequest(settings);
      if (status.enabled && status.runId === binding.runId) return { state: 'ready' };
      await showChatStatus(binding.tabId, '', '选中此 ChatGPT 对话');
      return inactive;
    }
    return chatRequest(settings, { action: 'frame', runId: binding.runId, bindingId: binding.bindingId, conversationId: binding.conversationId, messages: message.messages });
  })().then(reply, () => reply({ state: 'offline' }));
  return true;
});

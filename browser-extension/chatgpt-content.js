// The toolbar injects this script into one explicitly selected conversation.
(() => {
  if (globalThis.studyChatSampler) return;
  globalThis.studyChatSampler = true;
  let selection = null;
  let sampling = false;

  const excluded = 'button, svg, script, style, [hidden], [aria-hidden="true"], [role="toolbar"], [role="button"]';
  const block = 'p, div, h1, h2, h3, h4, li, ol, ul, blockquote, table, tr, section, figure';

  function renderedText(element) {
    if (!element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return '';
    function read(node) {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
      if (node.nodeType !== Node.ELEMENT_NODE || node.matches(excluded) || !node.checkVisibility({ checkVisibilityCSS: true })) return '';
      if (node.matches('.katex')) return node.querySelector('annotation[encoding="application/x-tex"]')?.textContent || '';
      if (node.matches('br')) return '\n';
      if (node.matches('pre')) {
        const code = node.querySelector('code') || node;
        const text = code.textContent;
        const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
        return '\n' + fence + '\n' + text + '\n' + fence + '\n';
      }
      const text = [...node.childNodes].map(read).join('');
      if (node.matches('td, th')) return text + '\t';
      return node.matches(block) ? '\n' + text + '\n' : text;
    }
    return read(element).trim();
  }

  function visible(element) {
    if (!element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false;
    const rect = element.getBoundingClientRect();
    let top = Math.max(rect.top, 0), bottom = Math.min(rect.bottom, innerHeight);
    for (let parent = element.parentElement; parent && bottom > top; parent = parent.parentElement) {
      if (/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) {
        const bounds = parent.getBoundingClientRect();
        top = Math.max(top, bounds.top);
        bottom = Math.min(bottom, bounds.bottom);
      }
    }
    return bottom > top && rect.right > 0 && rect.left < innerWidth && rect.width > 0;
  }

  function messages() {
    const main = document.querySelector('main');
    if (!main || document.querySelector('[role="dialog"][aria-modal="true"]')) return [];
    const generating = main.querySelector('[data-testid="stop-button"], .result-streaming');
    const turns = [...main.querySelectorAll('[data-message-id][data-message-author-role="user"], [data-message-id][data-message-author-role="assistant"]')];
    const streamingTurn = generating ? turns.findLast(item => item.dataset.messageAuthorRole === 'assistant') : null;
    const result = [];
    let size = 0;
    for (const [order, turn] of turns.entries()) {
      const role = turn.dataset.messageAuthorRole;
      if (turn === streamingTurn) continue;
      if (!visible(turn)) continue;
      const body = turn.querySelector(role === 'assistant' ? '.markdown, [data-message-content]' : '.whitespace-pre-wrap, [data-message-content]');
      if (!body) continue;
      const text = renderedText(body);
      if (!text || text.length > 60000 || size + text.length > 60000 || result.length >= 40) continue;
      result.push({ id: turn.dataset.messageId, role, order, text });
      size += text.length;
    }
    return result;
  }

  const onSelectedPage = current => document.visibilityState === 'visible' && document.hasFocus() &&
    location.pathname.match(/^\/(?:g\/[\w-]+\/)?c\/([\w-]{1,128})\/?$/)?.[1] === current.conversationId;

  async function sample() {
    const current = selection;
    if (sampling || !current || !onSelectedPage(current)) return;
    sampling = true;
    try {
      const status = await chrome.runtime.sendMessage({ type: 'study-chat-status', ...current });
      if (selection !== current) return;
      if (status?.state === 'inactive') { selection = null; return; }
      if (status?.state !== 'ready' || !onSelectedPage(current)) return;
      const snapshot = messages();
      if (onSelectedPage(current)) {
        const result = await chrome.runtime.sendMessage({ type: 'study-chat-frame', ...current, messages: snapshot });
        if (selection === current && ['inactive', 'material-limit', 'chatgpt-edited'].includes(result?.state)) selection = null;
      }
    } catch { /* The next sample rechecks authorization after reconnecting. */ }
    finally { sampling = false; }
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type !== 'study-chat-start') return;
    const { conversationId, bindingId, runId } = message;
    selection = { conversationId, bindingId, runId };
    void sample();
  });
  setInterval(sample, 4000);
  window.addEventListener('focus', sample);
  document.addEventListener('visibilitychange', sample);
})();

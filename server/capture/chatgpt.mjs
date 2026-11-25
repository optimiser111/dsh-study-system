export const CHATGPT_SOURCE = 'chatgpt-conversation';
export const CHATGPT_ENGINE = 'chatgpt-web-text';
export const CHATGPT_MIN_ANSWER_CHARS = 200;
export const textLength = text => text.replace(/\s/gu, '').length;

const idPattern = /^[\w-]{1,128}$/;
export function chatIdentity(body) {
  const { conversationId, bindingId } = body;
  if (typeof conversationId !== 'string' || !idPattern.test(conversationId) ||
      typeof bindingId !== 'string' || !idPattern.test(bindingId)) throw new Error('invalid conversation identity');
  return { conversationId, bindingId };
}

export function chatMessages(value) {
  if (!Array.isArray(value) || value.length > 40) throw new Error('invalid conversation messages');
  const seen = new Set();
  let size = 0;
  return value.map(({ id, role, order, text }) => {
    if (typeof id !== 'string' || !idPattern.test(id) || seen.has(id) ||
        !['user', 'assistant'].includes(role) || !Number.isSafeInteger(order) || order < 0 || order > 100000 ||
        typeof text !== 'string' || !text.trim() || (size += text.length) > 60000) throw new Error('invalid conversation message');
    seen.add(id);
    return { id, role, order, text: text.replace(/\r\n?/g, '\n').trim() };
  });
}

export function chatParts(lines, assistant = 'ChatGPT') {
  return [...lines].sort((a, b) => a.order - b.order).map(line => ({
    text: (line.role === 'assistant' ? `【${assistant} 回答】` : '【用户提问】') + '\n' + line.text,
  }));
}

// Reuse the installed ChatGPT controller's live authorization and proxy transport.
// No credential files, copied tokens, or independent refresh owner are created.
import { readSource } from './source-reader.js';
import { sourceAuthority } from './research.js';
export function createNativeWeb(controller, { model, signal, trace = () => {} }) {
  const session = controller?.session, auth = session?.auth, adapter = session?.adapter;
  if (!auth?.usable || typeof adapter?.fetch !== 'function') throw new Error('ChatGPT搜索接口尚未就绪，请检查插件登录及版本兼容性。');
  const transport = adapter.fetch;
  return {
    async search({ query, maxResults = 5 }, requestSignal = signal) {
      const credential = await auth.usable(requestSignal);
      const response = await transport((adapter.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/responses', {
        method: 'POST', signal: requestSignal,
        headers: { authorization: 'Bearer ' + credential.accessToken, 'content-type': 'application/json' },
        body: JSON.stringify({ model, store: false, stream: true, reasoning: { effort: 'low' },
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'Search the web once for this query. Return authoritative page URLs and titles. Keep the answer brief. Query: ' + query }] }],
          tools: [{ type: 'web_search' }], tool_choice: { type: 'web_search' }, include: ['web_search_call.action.sources'],
        }),
      });
      if (!response.ok) throw new Error('GPT原生搜索 HTTP ' + response.status + ': ' + (await response.text()).slice(0, 500));
      const result = await readNativeSearch(response);
      trace({ model, query, engine: 'chatgpt-native', status: result.terminal, searches: result.searches, sources: result.sources.length, usage: result.usage });
      // HTML and text PDFs are readable; skip unsupported media downloads.
      return { sources: result.sources.filter(s => !/\.(zip|mp[34]|wav|png|jpe?g)(?:[?#]|$)/i.test(s.url)).slice(0, maxResults) };
    },
    async fetch({ url }, requestSignal = signal) {
      // This request intentionally carries no authorization header.
      return readSource(transport, url, requestSignal, sourceAuthority);
    },
  };
}

export async function readNativeSearch(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('GPT搜索未返回事件流');
  const decoder = new TextDecoder(), sources = new Map();
  let buffer = '', terminal = null, searches = 0, usage;
  const addSource = (source) => {
    if (typeof source?.url !== 'string') return;
    try {
      const url = new URL(source.url); if (url.protocol !== 'https:' || url.username || url.password) return;
      const previous = sources.get(url.href);
      sources.set(url.href, { url: url.href, title: source.title || previous?.title || url.href });
    } catch { /* Ignore malformed citations. */ }
  };
  const inspect = (item) => {
    if (item?.type === 'web_search_call' && item.status === 'completed') {
      searches++;
      for (const source of item.action?.sources || []) addSource(source);
    }
    for (const part of item?.content || []) for (const citation of part.annotations || []) if (citation.type === 'url_citation') addSource(citation);
  };
  const consume = (frame) => {
    const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data);
    if (event.type === 'response.output_item.done') inspect(event.item);
    if (event.type === 'response.output_text.annotation.added') addSource(event.annotation);
    if (event.type === 'response.completed') {
      if (!searches) for (const item of event.response?.output || []) inspect(item);
      terminal = event.type; usage = event.response?.usage;
    }
    if (['response.failed', 'response.incomplete', 'error'].includes(event.type)) throw new Error('GPT搜索未完成：' + (event.error?.message || event.response?.error?.message || event.type));
  };
  try {
    while (!terminal) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) { consume(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
      if (buffer.length > 2 * 1024 * 1024) throw new Error('GPT搜索事件过大');
      if (done) { if (buffer.trim()) consume(buffer); break; }
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (terminal !== 'response.completed' || !searches || !sources.size) throw new Error('GPT未返回可核对的原生搜索结果');
  return { terminal, searches, sources: [...sources.values()], usage };
}

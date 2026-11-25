import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeWeb, readNativeSearch } from '../plugin/native-search.js';
const call = { type: 'web_search_call', status: 'completed', action: { sources: [{ url: 'https://ocw.mit.edu/test' }] } };
const sse = (events) => new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\r\n\r\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
const valid = () => sse([{ type: 'response.output_item.done', item: call }, { type: 'response.completed', response: { output: [] } }]);

test('原生搜索保留流中来源，终态空output不抹掉结果；非完整或伪搜索拒绝', async () => {
  assert.equal((await readNativeSearch(valid())).sources[0].url, 'https://ocw.mit.edu/test');
  await assert.rejects(readNativeSearch(sse([{ type: 'response.completed', response: { output: [] } }])), /未返回/);
  await assert.rejects(readNativeSearch(sse([{ type: 'response.output_item.done', item: call }])), /未返回/);
  await assert.rejects(readNativeSearch(sse([{ type: 'response.failed', response: { error: { message: 'quota' } } }])), /quota/);
});

test('复用宿主授权与传输，使用真实web_search，网页正文请求不携带令牌', async () => {
  const seen = [];
  const web = createNativeWeb({ session: {
    auth: { usable: async () => ({ accessToken: 'fixture-token' }) },
    adapter: { fetch: async (url, options) => {
      seen.push({ url, options });
      return url.endsWith('/responses') ? valid() : new Response('textbook contents', { headers: { 'content-type': 'text/html' } });
    } },
  } }, { model: 'fixture-model' });
  assert.equal((await web.search({ query: 'fixture' })).sources.length, 1);
  assert.equal(JSON.parse(seen[0].options.body).tools[0].type, 'web_search');
  assert.equal(JSON.parse(seen[0].options.body).store, false);
  assert.equal((await web.fetch({ url: 'https://ocw.mit.edu/test' })).body.content, 'textbook contents');
  assert.equal(seen[1].options.headers, undefined);
  assert.throws(() => createNativeWeb({}, { model: 'x' }), /接口尚未就绪/);
});

test('下载文件不挤占可读取网页的搜索名额', async () => {
  const web = createNativeWeb({ session: { auth: { usable: async () => ({ accessToken: 'fixture' }) }, adapter: { fetch: async () => sse([
    { type: 'response.output_item.done', item: { ...call, action: { sources: [{ url: 'https://ocw.mit.edu/book.zip' }, { url: 'https://ocw.mit.edu/chapter' }] } } },
    { type: 'response.completed', response: { output: [] } },
  ]) } } }, { model: 'fixture' });
  const result = await web.search({ query: 'fixture', maxResults: 1 });
  assert.equal(result.sources[0].url, 'https://ocw.mit.edu/chapter');
});

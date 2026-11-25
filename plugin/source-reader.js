async function boundedBytes(response, maximum) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('来源正文为空');
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length;
      if (bytes > maximum) throw new Error('来源正文过大');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const joined = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
  return joined;
}

export function linkedPdf(html, base, allowed) {
  const urls = new Set();
  for (const match of html.matchAll(/<a\b([^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (!/download|下载/i.test(match[1] + match[3])) continue;
    try {
      const url = new URL(match[2].replace(/&amp;/g, '&'), base);
      if (/\.pdf(?:[?#]|$)/i.test(url.href) && url.hostname === new URL(base).hostname && allowed(url.href)) urls.add(url.href);
    } catch { /* Ignore invalid links. */ }
  }
  return urls.size === 1 ? [...urls][0] : null;
}

export async function readSource(transport, url, signal, allowed, followDocument = true) {
  const response = await transport(url, { signal });
  const type = response.headers.get('content-type') || '', finalUrl = response.url || url;
  if (!response.ok || /image|audio|video/i.test(type)) {
    await response.body?.cancel();
    return { url: finalUrl, statusCode: response.ok ? 415 : response.status, body: { kind: 'text', content: '' } };
  }
  const isPdf = /pdf|octet-stream/i.test(type) || /\.pdf(?:[?#]|$)/i.test(finalUrl);
  const bytes = await boundedBytes(response, (isPdf ? 8 : 2) * 1024 * 1024);
  signal?.throwIfAborted();
  if (new TextDecoder().decode(bytes.subarray(0, 5)) === '%PDF-') {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const pdf = await getDocumentProxy(bytes, { isEvalSupported: false, maxImageSize: 1 });
    try {
      if (pdf.numPages > 80) throw new Error('讲义超过80页，请使用更具体的来源');
      const result = await extractText(pdf, { mergePages: true });
      signal?.throwIfAborted();
      if (!result.text.trim()) throw new Error('PDF没有可提取文字，不能依据图像猜测正文');
      return { url: finalUrl, statusCode: response.status, body: { kind: 'text', content: result.text, format: 'pdf-text', pages: result.totalPages } };
    } finally { await pdf.loadingTask.destroy(); }
  }
  if (isPdf) throw new Error('讲义未返回有效PDF正文');
  const content = new TextDecoder().decode(bytes);
  if (/html/i.test(type) && followDocument) {
    const linked = linkedPdf(content, finalUrl, allowed);
    if (linked) return readSource(transport, linked, signal, allowed, false);
  }
  return { url: finalUrl, statusCode: response.status, body: { kind: /html/i.test(type) ? 'html' : 'text', content } };
}

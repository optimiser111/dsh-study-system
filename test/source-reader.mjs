import test from 'node:test';
import assert from 'node:assert/strict';
import { readSource, linkedPdf } from '../plugin/source-reader.js';
import { sourceAuthority } from '../plugin/research.js';

// Minimal original PDF fixture; no network, embedded images, or external fonts.
function pdfFixture() {
  const text = 'Borrowing constraints limit access to credit.';
  const stream = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${start}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

test('权威下载页读取同站唯一PDF正文，保留PDF地址；请求不含账号授权', async () => {
  const seen = [];
  const result = await readSource(async (url, options) => {
    seen.push({ url, options });
    return url.endsWith('.pdf') ? new Response(pdfFixture(), { headers: { 'content-type': 'application/pdf' } })
      : new Response('<main><a download href="/lecture.pdf">Download File</a></main>', { headers: { 'content-type': 'text/html' } });
  }, 'https://ocw.mit.edu/resources/lecture', undefined, sourceAuthority);
  assert.equal(result.url, 'https://ocw.mit.edu/lecture.pdf');
  assert.equal(result.body.pages, 1); assert.equal(result.body.format, 'pdf-text');
  assert.ok(result.body.content.includes('Borrowing constraints limit access to credit.'));
  assert.equal(seen.length, 2); assert.ok(seen.every(s => s.options.headers === undefined));
});

test('不猜测多个下载文档，不跟随跨站或未获认可的下载链接；拒绝伪PDF', async () => {
  const base = 'https://ocw.mit.edu/chapter';
  assert.equal(linkedPdf('<a download href="/a.pdf">one</a><a download href="/b.pdf">two</a>', base, sourceAuthority), null);
  assert.equal(linkedPdf('<a download href="https://example.com/a.pdf">one</a>', base, sourceAuthority), null);
  assert.equal(linkedPdf('<a href="/a.pdf">A reference</a>', base, sourceAuthority), null);
  await assert.rejects(readSource(async () => new Response('not a PDF', { headers: { 'content-type': 'application/pdf' } }), base, undefined, sourceAuthority), /有效PDF/);
});

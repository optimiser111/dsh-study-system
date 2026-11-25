import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { m2Fixture } from './test/m2-fixture.mjs';
import { startServer } from './server/http/server.mjs';

const root = fileURLToPath(new URL('./', import.meta.url));
fs.mkdirSync(new URL('./.probe/', import.meta.url), { recursive: true });
const fixture = m2Fixture({ demo: true });
const backend = await startServer({
  db: fixture.db, port: 0, desktopOptions: { enabled: false },
  audioOptions: { enabled: false }, readingOptions: { enabled: false },
});
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, format: 'iife',
  stdin: { resolveDir: root, sourcefile: 'demo-entry.js', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    const root = createRoot(document.getElementById('root'));
    localStorage.setItem('study.m2.validation','true');
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, options) => {
      const url = new URL(input, location.href);
      if (url.origin === 'http://127.0.0.1:7789') return nativeFetch(url.pathname + url.search, options);
      return nativeFetch(input, options);
    };
    window.__ModuleLoader__ = { load(definition) {
      const plugin = definition.factory(() => React);
      plugin.apply({ get(){ return null; }, slots:{
        inject(name, callback){ callback(); },
        register(slot, component){ if(slot.name === 'main') root.render(React.createElement(component)); },
      } });
    } };
    require('./plugin/client.js');
  ` },
});

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>学习系统课程演示</title>
<style>body{margin:0;background:#07111c;color:#e2eff9;font:16px "Microsoft YaHei",sans-serif}aside{padding:10px 24px;background:#13303c}button,select{color:inherit;background:#102235}*{box-sizing:border-box}</style></head>
<body><aside>隔离演示　内置固定题和模拟历史作答。可试答客观题与到期复习。实时采集和 AI 功能请使用 DSH 模式。</aside>
<main id="root"></main><script src="/app.js"></script></body></html>`;
const allowedWrites = /^\/panel\/(?:review\/start|sessions\/[^/]+\/(?:answer|finish))$/;
const frontend = http.createServer(async (req, res) => {
  const address = new URL(req.url, 'http://127.0.0.1');
  if (address.pathname === '/') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(html);
  }
  if (address.pathname === '/app.js') {
    res.setHeader('content-type', 'text/javascript; charset=utf-8');
    return res.end(outputFiles[0].contents);
  }
  if (!['/health', '/xp'].includes(address.pathname) && !address.pathname.startsWith('/panel/')) {
    res.writeHead(404); return res.end();
  }
  const method = req.method;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (method !== 'GET' && !(method === 'POST' && allowedWrites.test(address.pathname))) {
    res.writeHead(409); return res.end(JSON.stringify({error:'这项操作需要完整 DSH 模式，见运行说明。'}));
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await fetch('http://127.0.0.1:' + backend.port + address.pathname + address.search, {
      method, headers: { 'content-type':'application/json' },
      body: method === 'POST' ? Buffer.concat(chunks) : undefined,
    });
    res.writeHead(response.status);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(502);
    res.end(JSON.stringify({error:'本地演示数据服务未能响应。'}));
  }
});
frontend.listen(0, '127.0.0.1', () => {
  console.log('演示窗口 http://127.0.0.1:' + frontend.address().port);
  console.log('按 Ctrl+C 关闭。所有作答写入本轮独立演示库。');
});

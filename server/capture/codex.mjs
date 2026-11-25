import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export const CODEX_SOURCE = 'codex-conversation';
export const CODEX_ENGINE = 'codex-app-server';
export const CODEX_TURN_LIMIT = 12;
const TEXT_LIMIT = 60000;

async function executable() {
  if (process.env.STUDY_CODEX_EXE) return process.env.STUDY_CODEX_EXE;
  if (process.platform !== 'win32') return 'codex';
  if (process.env.LOCALAPPDATA) {
    const bin = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
    const entries = await readdir(bin, { withFileTypes: true }).catch(() => []);
    const candidates = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
      const file = path.join(bin, entry.name, 'codex.exe');
      const info = await stat(file).catch(() => null);
      return info?.isFile() ? { file, modified: info.mtimeMs } : null;
    }));
    const newest = candidates.filter(Boolean).sort((a, b) => b.modified - a.modified)[0];
    if (newest) return newest.file;
  }
  return 'codex.exe';
}

async function withAppServer(operation) {
  const child = spawn(await executable(), ['app-server', '--listen', 'stdio://'], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let sequence = 0;
  let failure;
  function fail(error) {
    failure = error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
  child.stderr.resume();
  child.on('error', () => fail(new Error('无法启动本机 Codex App Server，请确认已安装 Codex 桌面应用。')));
  child.on('exit', () => fail(new Error('本机 Codex 会话读取服务已退出。')));
  child.stdin.on('error', () => fail(new Error('本机 Codex 会话读取通道已断开。')));
  lines.on('line', line => {
    let reply;
    try { reply = JSON.parse(line); } catch { return; }
    if (!reply || reply.method) return;
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    if (reply.error) {
      const error = new Error('Codex 拒绝了本次历史读取。');
      error.rpcCode = reply.error.code;
      request.reject(error);
    } else request.resolve(reply.result);
  });
  const timer = setTimeout(() => {
    fail(new Error('读取本机 Codex 会话超时，请重试。'));
    child.kill();
  }, 9500);
  timer.unref();
  const send = body => child.stdin.write(JSON.stringify(body) + '\n');
  const call = (method, params) => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    send({ method, id, params });
  });
  try {
    await call('initialize', { clientInfo: { name: 'study_codex_reader', version: '0.1.0' } });
    send({ method: 'initialized' });
    return await operation(call);
  } finally {
    clearTimeout(timer);
    lines.close();
    child.stdin.end();
    child.kill();
  }
}

export async function listCodexThreads() {
  return withAppServer(async call => {
    const result = await call('thread/list', {
      limit: 40, sortKey: 'updated_at', archived: false, useStateDbOnly: true, sourceKinds: ['vscode', 'appServer'],
    });
    return (result?.data || []).filter(thread => typeof thread.id === 'string' && !thread.ephemeral).map(thread => ({
      id: thread.id,
      title: (thread.name?.trim() || '未命名对话').slice(0, 150),
      updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt * 1000 : 0,
    }));
  });
}

export function codexMessages(turns) {
  const accepted = [];
  let size = 0;
  for (const turn of turns.filter(turn => turn.status === 'completed').slice(-CODEX_TURN_LIMIT).reverse()) {
    const items = turn.items || [];
    const answer = items.findLast(item => item.type === 'agentMessage' && item.phase === 'final_answer') ||
      items.findLast(item => item.type === 'agentMessage' && item.phase == null);
    const messages = items.flatMap(item => {
      if (item.type === 'userMessage') {
        const text = (item.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
        return text ? [{ role: 'user', text }] : [];
      }
      if (item === answer && typeof item.text === 'string' && item.text.trim()) {
        return [{ role: 'assistant', text: item.text.trim() }];
      }
      return [];
    });
    if (!messages.some(message => message.role === 'assistant')) continue;
    const length = messages.reduce((total, message) => total + message.text.length, 0);
    if (size + length > TEXT_LIMIT) {
      if (!accepted.length) throw new Error('最近一轮 Codex 问答超过 6 万字符，本次未采集。');
      break;
    }
    size += length;
    accepted.unshift(messages);
  }
  return accepted.flat().map((message, order) => ({ ...message, order }));
}

export async function readCodexThread(threadId) {
  return withAppServer(async call => {
    try {
      // New versions expose paginated turns. Request one extra in case the latest is unfinished.
      const result = await call('thread/turns/list', {
        threadId, limit: CODEX_TURN_LIMIT + 1, sortDirection: 'desc', itemsView: 'full',
      });
      if (!Array.isArray(result?.data)) throw new Error('Codex 返回的会话格式不受支持。');
      return codexMessages(result.data.slice().reverse());
    } catch (error) {
      if (![-32601, -32602].includes(error.rpcCode)) throw error;
      const result = await call('thread/read', { threadId, includeTurns: true });
      if (result?.thread?.id !== threadId || !Array.isArray(result.thread.turns)) throw new Error('Codex 返回的会话格式不受支持。');
      return codexMessages(result.thread.turns);
    }
  });
}

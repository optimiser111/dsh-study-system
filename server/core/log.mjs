import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

// A8：日志里绝不允许出现凭据。任何写日志的地方都过这里。
const SECRET_PATTERNS = [
  /SESSDATA=[^;\s]+/gi,
  /bili_jct=[^;\s]+/gi,
  /Cookie:\s*.+/gi,
  /Authorization:\s*.+/gi,
];

export function redact(text) {
  let out = String(text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[REDACTED]');
  return out;
}

export function logFile() {
  const dir = process.env.STUDY_LOG_DIR || path.join(ROOT, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'study.log');
}

export function log(message) {
  const line = `${new Date().toISOString()} ${redact(message)}\n`;
  fs.appendFileSync(logFile(), line, 'utf8');
  return line;
}

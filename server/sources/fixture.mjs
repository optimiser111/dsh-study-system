import fs from 'node:fs';
import { normalize } from '../core/normalize.mjs';

/** fixture 文本 → Content 的原始片段（按空行分段） */
export function loadTextParts(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return raw
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text) => ({ text: normalize(text).text }));
}

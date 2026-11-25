// 唯一的归一化实现。写入方（切段/出题）与校验方（validateSpan）必须共用这一个。
// 改动规则 = 必须升 NORMALIZER_VERSION，否则旧 span 全部失效。
export const NORMALIZER_VERSION = 1;

// v2 preserves tabs, whitespace, Unicode and case for formatted excerpts,
// including editor and conversation code blocks.
export const EDITOR_NORMALIZER_VERSION = 2;
export const normalizeEditor = raw => raw.replace(/\r\n?/g, '\n');

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/;
const CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF01-\uFF60]/;

/**
 * @param {string} raw
 * @returns {{ text: string, map: number[] }} map[i] = text[i] 在 raw 里的下标
 */
export function normalize(raw) {
  const chars = [];
  const src = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ZERO_WIDTH.test(ch)) continue;
    for (const c of ch.normalize('NFKC')) {
      chars.push(c);
      src.push(i);
    }
  }

  const out = [];
  const map = [];
  let pendingSpace = false;
  for (let k = 0; k < chars.length; k++) {
    const c = chars[k];
    if (/\s/.test(c)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      const prev = out.length ? out[out.length - 1] : '';
      // 只在「两侧都不是 CJK」时保留一个空格；CJK 之间不留空格
      if (prev && !CJK.test(prev) && !CJK.test(c)) {
        out.push(' ');
        map.push(src[k]);
      }
      pendingSpace = false;
    }
    out.push(c);
    map.push(src[k]);
  }
  return { text: out.join(''), map };
}

/** 把归一化坐标映射回原文坐标（导出/高亮用） */
export function toRawRange({ map }, spanStart, spanEnd) {
  if (spanEnd <= spanStart || spanStart < 0 || spanEnd > map.length) return null;
  return { start: map[spanStart], end: map[spanEnd - 1] + 1 };
}

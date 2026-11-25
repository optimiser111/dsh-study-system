// span 硬校验：不通过 = 丢题，不允许降级成 warning（D.6）。
/**
 * @param {{spanText:string, spanStart:number, spanEnd:number}} card
 * @param {{text:string}} content
 * @returns {boolean}
 */
export function isSpanValid(card, content) {
  const { spanText, spanStart, spanEnd } = card;
  if (typeof spanText !== 'string' || spanText.length === 0) return false;
  if (!Number.isInteger(spanStart) || !Number.isInteger(spanEnd)) return false;
  if (spanStart < 0 || spanEnd <= spanStart || spanEnd > content.text.length) return false;
  if (content.text.slice(spanStart, spanEnd) !== spanText) return false;
  // 精确位置命中：同一句话出现多次时，不允许落在别处
  return content.text.indexOf(spanText, spanStart) === spanStart;
}

/** 在归一化文本里定位一句原文；命中返回 {spanStart,spanEnd,spanText}，否则 null */
export function locate(content, quote) {
  const at = content.text.indexOf(quote);
  if (at < 0) return null;
  return { spanStart: at, spanEnd: at + quote.length, spanText: quote };
}

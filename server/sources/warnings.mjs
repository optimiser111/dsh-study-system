// 只提示人工复核，不参与 verdict、判分或丢弃。正常数学变量也可能命中。
export function subtitleWarnings(text, { offset = 0, coordinate = 'text', from = null, to = null } = {}) {
  const warnings = [];
  const han = /\p{Script=Han}/u;
  for (const match of String(text).matchAll(/[A-Za-z]+[0-9]*/g)) {
    if (!/^[A-Za-z][0-9]*$/.test(match[0])) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (!han.test(text.slice(0, start).trimEnd().slice(-1)) || !han.test(text.slice(end).trimStart().slice(0, 1))) continue;
    warnings.push({
      code: 'latin-in-chinese', token: match[0],
      reason: '中文上下文中出现单个拉丁字母或字母数字记号，请核对字幕；正常变量也可能命中',
      excerpt: text.slice(Math.max(0, start - 24), Math.min(text.length, end + 24)),
      start: offset + start, end: offset + end, coordinate, from, to,
    });
  }
  return warnings;
}

export function segmentWarnings(segment, quality = null) {
  if(segment.source_kind==='chatgpt-conversation')return [{code:'chatgpt-excerpt',token:'ChatGPT',reason:'材料来自已选对话的可见问答片段，回答中的事实及引用需要核对。',excerpt:segment.text.slice(0,100),start:segment.span_start,end:Math.min(segment.span_end,segment.span_start+100),coordinate:'normalized-content',from:null,to:null}];
  if(segment.source_kind==='codex-conversation')return [{code:'codex-excerpt',token:'Codex',reason:'材料来自选定会话的近期问答。代码、运行结果或引用以实际提供的证据为准。',excerpt:segment.text.slice(0,100),start:segment.span_start,end:Math.min(segment.span_end,segment.span_start+100),coordinate:'normalized-content',from:null,to:null}];
  if(segment.source_kind==='desktop-editor-text')return [{code:'editor-excerpt',token:'VS Code',reason:'仅采集 VS Code 活动编辑器的可见行，保留缩进与符号；未显示、折叠及其他文件的内容不在材料内，代码未运行验证。',excerpt:segment.text.slice(0,100),start:segment.span_start,end:Math.min(segment.span_end,segment.span_start+100),coordinate:'normalized-content',from:null,to:null}];
  if(segment.source_kind==='desktop-ocr')return [{code:'desktop-ocr-review',token:'OCR',reason:'屏幕文字识别可能遗漏分栏顺序、术语、公式和图表；这里只代表采集到的可见片段，不代表全文已读。请核对原文。',excerpt:segment.text.slice(0,100),start:segment.span_start,end:Math.min(segment.span_end,segment.span_start+100),coordinate:'normalized-content',from:null,to:null}];
  if (segment.source_kind === 'bilibili-local-asr') return [{ code: 'local-asr-review', token: 'ASR', reason: '本地语音转写可能误识别术语、数字或公式；请核对原音频，不应把同音猜测当作原文事实。', excerpt: segment.text.slice(0, 100), start: segment.span_start, end: Math.min(segment.span_end, segment.span_start + 100), coordinate: 'normalized-content', from: null, to: null }, ...(quality?.warnings || [])];
  if (segment.source_kind !== 'bilibili-cc') return [];
  // 新导入保留原始字幕行与精确时间；旧数据只能给归一化全文坐标，不猜时间。
  return Array.isArray(quality?.warnings) ? quality.warnings : subtitleWarnings(segment.text, {
    offset: segment.span_start, coordinate: 'normalized-content',
  });
}

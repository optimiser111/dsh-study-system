const esc = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' / ').replace(/`/g, "'");

export function renderReviewTable(cards) {
  const active = cards.filter((c) => !c.discarded);
  const discarded = cards.filter((c) => c.discarded);
  let md = `# 人工抽检表（稳定 ID）\n\n> ${cards.length} 张候选题：${active.length} 在用、${discarded.length} 已停用。请使用完整题目 ID 引用，序号不作为身份。\n> 模型自查不算人工复核。字幕可疑仅提示优先复核，正常变量也会命中；未标记不代表可靠。\n> 人工结论建议填写：可用 / 来源错误 / 题目或答案错误 / 有歧义；没有独立复核时留空。\n> 已停用题保留原文和原因，不能从题目质量统计中悄悄删除。\n`;
  for (const [label, rows] of [['在用题目', active], ['已停用题目（保留历史问题）', discarded]]) {
    md += `\n## ${label}\n\n| 题目 ID | 来源与位置 | 题型 / 状态 | 题目 | 原文引用 | 答案 / rubric | 复核提示 | 人工结论 | 备注 |\n|---|---|---|---|---|---|---|---|---|\n`;
    for (const c of rows) {
      const source = c.prompt_version === 'm1-cards-v1-closed-book' ? '聊天中模型手写' : '模型自动';
      const warnings = c.warnings.length ? `优先复核来源段：${c.warnings.length} 处提示，记号 ${[...new Set(c.warnings.map((w) => w.token))].join(' / ')}；详情见下方 segment=${c.segment_id}` : '';
      const location = `${source}；${c.course}；${c.external_id || ''}；session=${c.session_id}；segment=${c.segment_id}（段${c.seq}，非视频P号）；span=${c.span_start}-${c.span_end}`;
      const answer = `${c.answer}${c.options_json ? '；选项：' + JSON.parse(c.options_json).join(' / ') : ''}${c.rubric_json ? '；rubric：' + c.rubric_json : ''}`;
      md += `| ${esc(c.id)} | ${esc(location)} | ${esc(c.kind)} / ${c.discarded ? '停用：' + esc(c.discard_reason) : '在用'} | ${esc(c.question)} | ${esc(c.span_text)} | ${esc(answer)} | ${esc(warnings || '未检出模式，不代表来源可靠')} | | |\n`;
    }
  }
  md += '\n## 来源段复核提示（同段只列一次）\n\n';
  const segments = new Map(cards.filter((c) => c.warnings.length).map((c) => [c.segment_id, c]));
  for (const [id, card] of segments) {
    md += `### segment=${id}\n\n`;
    for (const w of card.warnings) {
      const position = w.from == null ? '时间未保存；' + w.coordinate + ' 偏移 ' + w.start + '-' + w.end : w.from + '-' + w.to + ' 秒；' + w.coordinate + ' 行内偏移 ' + w.start + '-' + w.end;
      md += `- ${esc(w.reason)}。位置：${position}。片段：${esc(w.excerpt)}\n`;
    }
    md += '\n';
  }
  return md;
}

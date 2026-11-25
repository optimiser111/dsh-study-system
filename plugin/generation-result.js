export function generationResult(report) {
  const totals = report?.totals || {}, segments = report?.segments || [];
  const reasons = [...new Set(segments.filter(s => s.failed || s.abstained).map(s => s.reason).filter(Boolean))].join('；').slice(0, 800);
  if (totals.failed > 0) return { failed: true, outcome: 'failed', reason: reasons || '提要或出题处理失败，可重试。' };
  if (totals.kept > 0 || totals.skipped > 0) return { failed: false, outcome: 'completed' };
  if (totals.abstained > 0 && !totals.discarded) return { failed: false, outcome: 'abstained', reason: reasons || '本段尚不足以形成可检验的课程知识，请继续采集后续讲解。' };
  return { failed: true, outcome: 'failed', reason: '生成的题目未通过质量检查，可检查材料后重试。' };
}

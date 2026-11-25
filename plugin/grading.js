// 纯规则由宿主与服务端共用，服务端始终重新计算正式结论。
export const GRADING_RULE = 'core-coverage-v1';
export const COVERAGE_THRESHOLD = 0.75;

export function rubricPoints(rubric) {
  if (!Array.isArray(rubric) || !rubric.length) throw new Error('rubric must be a non-empty array');
  const seen = new Set();
  return rubric.map((point) => {
    const item = typeof point === 'string' ? { text: point, required: false } : point;
    if (!item || typeof item.text !== 'string' || !item.text.trim() || typeof item.required !== 'boolean') {
      throw new Error('rubric point needs text and required:boolean');
    }
    const text = item.text.trim();
    if (seen.has(text)) throw new Error('duplicate rubric point');
    seen.add(text);
    return { text, required: item.required };
  });
}

export function evaluateGrade(hit, rubric) {
  if (!Array.isArray(hit) || hit.some((p) => typeof p !== 'string')) throw new Error('hit must be an array of rubric texts');
  const points = rubricPoints(rubric);
  const allowed = new Set(points.map((p) => p.text));
  const matched = [...new Set(hit.filter((p) => allowed.has(p)))];
  const missingRequired = points.filter((p) => p.required && !matched.includes(p.text)).map((p) => p.text);
  const coverage = matched.length / points.length;
  return { hit: matched, passed: missingRequired.length === 0 && coverage >= COVERAGE_THRESHOLD,
    coverage, missingRequired, gradingRule: GRADING_RULE, threshold: COVERAGE_THRESHOLD };
}

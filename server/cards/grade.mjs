import { rubricPoints } from '../../plugin/grading.js';
// 客观题：纯函数，永不调用模型（A3）。
const norm = (s) => String(s ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();

export function gradeObjective(card, answer) {
  const given = norm(answer);
  const expected = norm(card.answer);
  if (!given) return false;
  if (given === expected) return true;

  // 选项题：answer 可能是 'B'，选项是文本数组；两个方向都要认
  const options = card.options_json ? JSON.parse(card.options_json) : null;
  if (Array.isArray(options)) {
    if (/^[a-z]$/.test(given)) {
      const index = given.charCodeAt(0) - 97;
      if (index >= 0 && index < options.length) return norm(options[index]) === expected;
    }
    if (/^[a-z]$/.test(expected)) {
      const index = expected.charCodeAt(0) - 97;
      if (index >= 0 && index < options.length) return norm(options[index]) === given;
    }
  }
  return false;
}

// 主观题：rubric 命中率，禁止整体印象分（§7）
export function gradeSubjective(answer, rubric) {
  const given = norm(answer);
  const points = (rubric?.length ? rubricPoints(rubric) : []).map((p) => norm(p.text));
  const hitPoints = points.filter((p) => given.includes(p));
  const total = points.length;
  const hit = hitPoints.length;
  return {
    hit,
    total,
    points: hitPoints,
    passed: total > 0 && hit / total >= 0.6,
  };
}

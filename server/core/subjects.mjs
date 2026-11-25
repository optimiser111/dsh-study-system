import { subjectLabel } from '../../plugin/subject-identity.js';
export { normalizeSubject, subjectLabel } from '../../plugin/subject-identity.js';

const titlePatterns = [
  ['math', /线性代数|微积分|高等数学|离散数学|概率论|数理统计|数论/i],
  ['programming', /编程|数据结构|操作系统|计算机网络|数据库|\b(?:python|javascript|typescript|rust)\b/i],
  ['language', /英语|日语|法语|德语|西班牙语|外语|雅思|托福/i],
  ['物理', /物理|量子力学|经典力学|热力学|电动力学/i],
  ['化学', /有机化学|无机化学|分析化学|物理化学|化学实验/i],
  ['生物', /生物学|生理学|遗传学|细胞生物|分子生物/i],
  ['历史', /中国史|世界史|历史|朝代/i],
  ['经济学', /经济学|计量经济|宏观经济|微观经济/i],
  ['电子工程', /电路|模电|数电|电子技术|信号与系统/i],
  ['音乐', /乐理|和声|音乐|钢琴|吉他/i],
  ['美术', /美术|素描|油画|绘画|色彩构成/i],
];

export function suggestSubject(title) {
  const matches = titlePatterns.filter(([, pattern]) => pattern.test(title || ''));
  return matches.length === 1 ? subjectLabel(matches[0][0]) : null;
}

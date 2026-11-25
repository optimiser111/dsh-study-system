export const DIALOGUE_VERSION = 'targeted-followup-v1';
export const MAX_FOLLOWUPS = 1;
export const DIALOGUE_PROMPT = [
  '按原题和rubric判断理解，接受自己的话和正确例子；不看参考答案，不添加原题之外的要求。',
  '综合原答及已有追问回答。已足够说明核心就sufficient，不为补齐术语追问；完全无关irrelevant，实质错误incorrect。',
  '有具体正确内容但同一个任务的关键关系仍不清楚，才是partial。recognized指出已理解之处，gap只说尚未体现的关系，followup只问一个针对该缺口的问题。',
  '不要把完整答案、公式步骤或正确选项喂给学生；不要考整讲其他知识，不重复已经证明的内容。原题允许任选路径时不能强求另一条。',
  '追问最多一轮。达到上限仍不充分，应说明本次证据不足，不推断学生一定没听懂。',
  'hit只复制真正完整覆盖的rubric文本；一个整体评分点也可能局部理解，此时hit可为空，recognized必须说明具体正确证据。',
  '只输出JSON：{"assessment":"sufficient|partial|incorrect|irrelevant","hit":["完整命中的rubric文本"],"recognized":"已体现的具体理解","gap":"同一任务的缺口","followup":"一个不泄露答案的追问","note":"判断理由"}。不需要追问时gap/followup可为空字符串。',
].join('\n');

export function parseDialogue(raw) {
  const text = String(raw).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const result = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  validateJudgment(result);
  return result;
}
export function validateJudgment(value) {
  if (!value || !['sufficient', 'partial', 'incorrect', 'irrelevant'].includes(value.assessment) ||
      !Array.isArray(value.hit) || value.hit.some((p) => typeof p !== 'string') ||
      ['recognized', 'gap', 'followup', 'note'].some((key) => typeof value[key] !== 'string')) throw new Error('invalid dialogue judgment');
  if (value.assessment === 'partial' && (!value.recognized.trim() || !value.gap.trim() || !value.followup.trim())) throw new Error('partial judgment needs recognized evidence, gap and one followup');
  return value;
}
export function dialoguePrompt(item) {
  return JSON.stringify({ question: item.question, rubric: item.rubric, originalAnswer: item.raw,
    replies: item.dialogue.replies, turn: item.dialogue.turn, maxFollowups: MAX_FOLLOWUPS });
}

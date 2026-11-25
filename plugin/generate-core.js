// 出题链路的纯逻辑（不依赖 DSH），供插件与测试共用。
// 放在插件包内是为了让宿主半能直接 import；测试用相对路径引它，避免两边各写一份。

import { evaluateGrade } from './grading.js';
export const PROMPT_VERSION = 'm1-cards-v7';

export const SYSTEM_PROMPT = [
  '你根据已完成的整讲提要与原文，检验学生是否理解核心概念、能否应用和纠正误解。',
  '硬规则：',
  '1. 每题targetId必须对应提要中的核心概念。quote是模型出题的原文证据，须逐字复制连续片段；学生无需复述quote或参考答案。',
  '2. 内容充足时出 3 道客观题和 1 道主观题。信息不足时可以少出；若没有可检验的课程知识、只是闲聊或问候，返回 {"abstain":"原因"}，不要为了凑题考问候、时间或闲聊事实。',
  '3. 客观题：options 恰好 4 个，answer 是 "A"-"D" 之一。',
  '4. M1短主观题只检验一个核心理解任务：answer 给一种可行解释；rubric 必须恰好一个 {"text":"完成题干任务的整体语义条件，允许等价解释或正确例子","required":true}。不要把多个独立要求用“并且”捆在一个点中，不考整讲面面俱到。写不出聚焦的题就少出或弃权。',
  '5. 知识范围限于本讲所教的概念与方法；可以据此推理、换数字或设置新情境，不引入课外定理与方法。不要把答案必须逐字存在于原文当成出题条件。',
  '可以改变数字或设置小情境，检验课程所教方法；不得只问“原文说了什么”“某专业把它叫作什么”。最多4题，整讲只出一组。',
  '每题必须标skill（apply/explain/diagnose/compare）、assessmentReason（怎样检验核心理解）、misconception（针对何种误解）。客观题的错误选项应代表真实误解。',
  '主观题评分要点必须描述可观察的解释/推理/操作，接受口语、同义说明与正确例子。不要把同一含义拆成多个点，不以出现某个词或照讲师顺序复述为条件。',
  '不要将“物理/计算机/数学家等不同学科如何定义它”作为主观题的主任务；用一个具体概念关系、应用或误解来考理解。背景分类可在提要中介绍，不作为必须罗列的得分点。',
  '题干和评分任务必须一致：题干允许“解释或举例”“结合坐标或运算”时，任一正确路径即可；不得在rubric中改成所有路径都要覆盖，也不得暗加题干未要求的术语或抽象概括。',
  '6. 只输出 JSON，不要解释、不要 markdown 代码块。',
  '输出格式（两种卡都给了完整示例，字段一个都不能少）：',
  '{"cards":[' +
    '{"kind":"objective","targetId":"concept-1","skill":"apply","assessmentReason":"解释此题如何检验核心概念","misconception":"本题针对的误解","question":"…？","options":["…","…","…","…"],"answer":"B","quote":"…","topic":"…","difficulty":1},' +
    '{"kind":"subjective","targetId":"concept-1","skill":"explain","assessmentReason":"检验关键关系的理解","misconception":"会背公式但不理解含义","question":"解释或举例说明…？","answer":"参考作答：一种可行解释，不是唯一措辞","rubric":[{"text":"能解释关键关系，允许等价例子和口语","required":true}],"quote":"…","topic":"…","difficulty":3}' +
  ']}',
].join('\n');

export const GRADE_PROMPT = [
  '你在按 rubric 判一份主观作答。你看不到标准答案，也看不到出题理由，只有题目、rubric 和学生的作答。',
  '判定标准是“意思是否覆盖”，不是“是否出现了这个词”：同义表述算命中；只堆砌名词、否定原意、答非所问都不算。',
  '先结合题目判断学生的推理是否成立。正确的例子、日常用语和不同解释路径都可体现理解；不要要求照抄术语或把题干已给出的前提再重复一遍。',
  '只复述题目或结论而未给出解释时，理由应写“本次作答证据不足”，不要推断学生一定没听懂。',
  'hit 必须逐字复制语义覆盖的 rubric 文本（对象的 text），不得重复。不要因仅出现同名关键词就算覆盖。核心点全部覆盖、总覆盖率至少75%才通过，最终由程序计算。',
  '只输出 JSON：{"hit":["命中的要点"],"passed":true或false,"note":"一句话理由"}',
].join('\n');

/** 该段是否必须先弃权（不消耗模型调用） */
export function segmentGate(segment, { minChars = 200 } = {}) {
  if (segment.verdict && segment.verdict !== 'ok' && segment.verdict !== 'unknown') {
    return { abstain: true, reason: `subtitle-quality:${segment.verdict}` };
  }
  if (Number(segment.chars) < minChars) {
    return { abstain: true, reason: 'segment-too-short' };
  }
  if (segment.cards > 0) {
    return { abstain: true, reason: 'already-generated' };
  }
  return { abstain: false };
}

/**
 * 解析模型输出。三种结果：{abstain} / {cards} / 抛错。
 * 解析失败必须抛错（由调用方记 abstain），不得用默认值填充。
 */
export function parseModelOutput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error('empty model output');
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model output');
  let parsed;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    throw new Error(`invalid JSON: ${e.message}`);
  }
  if (parsed && typeof parsed.abstain === 'string' && parsed.abstain.trim()) {
    return { abstain: parsed.abstain.trim() };
  }
  if (!parsed || !Array.isArray(parsed.cards)) throw new Error('missing cards array');
  const cards = parsed.cards.filter((c) => c && typeof c.quote === 'string' && c.quote.length > 0 && c.question);
  if (!cards.length) throw new Error('no usable cards (every card needs a quote and a question)');
  return { cards };
}

export function buildUserPrompt(segment) {
  return `课程原文（第 ${Number(segment.seq) + 1} 段）：\n"""\n${segment.text}\n"""`;
}

function jsonObject(raw, what) {
  const text = String(raw ?? '').trim();
  if (!text) throw new Error(`empty ${what} output`);
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`no JSON object in ${what} output`);
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    throw new Error(`invalid JSON in ${what} output: ${e.message}`);
  }
}

/** 盲判输出解析：必须有 hit 数组，且 passed 必须是真布尔（"false" 字符串不算） */
export function parseGradeOutput(raw) {
  const parsed = jsonObject(raw, 'grade');
  if (!Array.isArray(parsed.hit)) throw new Error('grade output has no hit array');
  if (typeof parsed.passed !== 'boolean') {
    throw new Error(`grade output passed must be boolean, got ${JSON.stringify(parsed.passed)}`);
  }
  return parsed;
}

/** 盲判结果必须落在 rubric 上，模型自己造的点不算 */
export function normalizeGradeResult(parsed, rubric) {
  if (typeof parsed.passed !== 'boolean') throw new Error('passed must be boolean');
  return { ...evaluateGrade(parsed.hit, rubric), note: String(parsed.note || '') };
}

export function buildGradePrompt(item) {
  return `题目：${item.question || ''}\n\nrubric（required=true 为核心点；旧字符串条目按普通要点计算）：${JSON.stringify(item.rubric)}\n\n学生作答：\n"""\n${item.raw}\n"""`;
}

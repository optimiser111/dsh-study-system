// 旧录制响应的管道适配器，仅供接线测试，不代表真实模型已经会总结或测理解。
export function testDialogue(value) {
  return { ...value, assessment: value.hit?.length ? 'sufficient' : 'incorrect', recognized: '', gap: '', followup: '', note: value.note || '' };
}
export function testLesson(text) {
  return { overview: '本测试文本讨论向量表示与运算。', coreIdeas: [
    { id: 'vector-core', title: '向量表示与运算', meaning: '解释表示与操作的含义。', evidence: text.slice(0, 80) },
  ], connections: [] };
}
export function testAssessment(cards) {
  return cards.map((card) => ({ targetId: 'vector-core', skill: card.kind === 'subjective' ? 'explain' : 'apply',
    assessmentReason: '接线测试：检查核心目标映射。', misconception: '接线测试中的预设误解。', ...card,
    ...(card.kind === 'subjective' ? { rubric: [{ text: '能用坐标解释几何箭头与数字表示的对应，允许正确例子', required: true }] } : {}),
  }));
}

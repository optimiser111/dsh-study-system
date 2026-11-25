import { createRecognizer } from './recognizer.mjs';
let recognize;
const sessions = new Map();
process.on('message', ({ type, id, epoch, pcm, offset, final }) => {
  if (type === 'discard') { sessions.delete(epoch); return; }
  try {
    recognize ||= createRecognizer();
    if (!sessions.has(epoch)) {
      if (!epoch || offset !== 0 || sessions.size >= 8) throw new Error('语音流起点或并发数量无效');
      sessions.set(epoch, recognize.createSession());
    }
    const started = performance.now(), result = sessions.get(epoch).push(pcm, { offset, final });
    if (final) sessions.delete(epoch);
    process.send({ id, result: { ...result, inferenceSeconds: (performance.now() - started) / 1000 } });
  }
  catch (error) { sessions.delete(epoch); process.send({ id, error: error.message }); }
});
process.on('disconnect', () => process.exit(0));

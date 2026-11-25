import { loadCaptureRuntime } from './capture-runtime.mjs';
let loopback;
let capture = null, current = null, carry = Buffer.alloc(0), chunks = [], count = 0, offset = 0;
function flush() {
  if (!count || !current) return;
  const pcm = Buffer.concat(chunks); process.send({ type: 'pcm', epoch: current, pcm, offset, at: Date.now() });
  offset += pcm.length / 2; chunks = []; count = 0;
}
process.on('message', (message) => {
  try {
    if (message.type === 'stop') {
      if (message.epoch === current) { capture?.stop(); flush(); capture = null; current = null; }
      process.send({ type: 'stopped', epoch: message.epoch }); return;
    }
    if (message.type !== 'start') return;
    capture?.stop(); flush(); current = message.epoch; const epoch = current;
    carry = Buffer.alloc(0); chunks = []; count = 0; offset = 0;
    loopback ||= loadCaptureRuntime();
    capture = new loopback.LoopbackCapture();
    capture.start(message.pid, (buffer) => {
      if (current !== epoch) return;
      // 48 kHz stereo PCM16 -> 16 kHz mono, averaging a 3-frame window.
      const input = Buffer.concat([carry, buffer]), frames = Math.floor(input.length / 12), pcm = Buffer.alloc(frames * 2);
      for (let i = 0; i < frames; i++) { let sum = 0; for (let j = 0; j < 6; j++) sum += input.readInt16LE(i * 12 + j * 2); pcm.writeInt16LE(Math.round(sum / 6), i * 2); }
      carry = Buffer.from(input.subarray(frames * 12)); chunks.push(pcm); count += pcm.length;
      if (count >= 32000) flush();
    });
    process.send({ type: 'started', epoch });
  } catch (error) { process.send({ type: 'error', epoch: message.epoch, error: error.message }); }
});
process.on('disconnect', () => { capture?.stop(); process.exit(0); });

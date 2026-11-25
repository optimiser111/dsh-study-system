// Transport batches are not speech boundaries. Keep VAD and unfinished audio
// alive until a real pause, the detector's duration limit, or capture stop.
export class UtteranceStream {
  constructor({ vad, decode }) {
    this.vad = vad; this.decode = decode;
    this.samples = new Float32Array(); this.head = 0; this.received = 0;
    this.processed = 0; this.lastEnd = 0; this.closed = false;
    this.vadOrigin = 0; this.speechStart = null;
  }
  push(pcm, { offset = this.received, final = false } = {}) {
    if (this.closed) throw new Error('语音流已结束');
    if (!Buffer.isBuffer(pcm) || pcm.length % 2 || pcm.length > 16000 * 2 * 30) throw new Error('语音片段格式或长度无效');
    if (offset !== this.received) throw new Error('语音片段不连续，不能拼接转写');
    const count = pcm.length / 2, joined = new Float32Array(this.samples.length + count);
    joined.set(this.samples);
    for (let i = 0; i < count; i++) joined[this.samples.length + i] = pcm.readInt16LE(i * 2) / 32768;
    this.samples = joined; this.received += count;
    const cues = [];
    const drain = () => {
      while (!this.vad.isEmpty()) {
        const segment = this.vad.front(false);
        const start = Math.max(this.head, this.lastEnd, this.vadOrigin + segment.start - 3200);
        const end = Math.min(this.received, this.vadOrigin + segment.start + segment.samples.length);
        if (end > start) {
          const text = this.decode(this.samples.subarray(start - this.head, end - this.head)).replace(/<\|[^|]*\|>/g, '').trim();
          if (text) cues.push({ from: start / 16000, to: end / 16000, text });
          this.lastEnd = end;
        }
        this.vad.pop();
      }
    };
    while (this.processed + 512 <= this.received) {
      this.vad.acceptWaveform(this.samples.subarray(this.processed - this.head, this.processed - this.head + 512));
      this.processed += 512; drain();
      if (this.vad.isDetected()) this.speechStart ??= this.processed - 512;
      else this.speechStart = null;
      // Native maxSpeechDuration relaxes the pause threshold; it does not
      // enforce a hard limit. Bound truly continuous speech before the
      // native detector's 30-second circular buffer can overflow.
      if (this.speechStart !== null && this.processed - this.speechStart >= 24 * 16000) {
        this.vad.flush(); drain(); this.vad.reset();
        this.vadOrigin = this.processed; this.speechStart = null;
      }
    }
    if (final) {
      // Silero takes complete 512-sample windows. Pad only the last partial
      // window, and clamp output timestamps to the actual captured samples.
      if (this.processed < this.received) {
        const tail = new Float32Array(512); tail.set(this.samples.subarray(this.processed - this.head));
        this.vad.acceptWaveform(tail); this.processed += 512; drain();
      }
      this.vad.flush(); drain(); this.closed = true;
      this.samples = new Float32Array();
    } else {
      // Keep the pending utterance, onset padding, and an input remainder.
      const nextHead = Math.max(this.head, this.processed - 26 * 16000);
      this.samples = this.samples.slice(nextHead - this.head); this.head = nextHead;
    }
    return { cues, duration: count / 16000, speechSeconds: cues.reduce((n, c) => n + c.to - c.from, 0) };
  }
}

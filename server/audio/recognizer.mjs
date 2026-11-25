import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sherpa from 'sherpa-onnx-node';
import { UtteranceStream } from './utterances.mjs';

export const MODEL_DIR = fileURLToPath(new URL('../../models/sensevoice/', import.meta.url));
export function createRecognizer(directory = MODEL_DIR) {
  const assets = JSON.parse(fs.readFileSync(new URL('./model-assets.json', import.meta.url)));
  for (const asset of [assets.models.int8, assets.tokens, assets.vad]) {
    const data = fs.readFileSync(path.join(directory, asset.name));
    if (data.length !== asset.bytes || createHash('sha256').update(data).digest('hex') !== asset.sha256) throw new Error('本地语音模型校验失败，请运行Setup-Audio.ps1');
  }
  const recognizer = new sherpa.OfflineRecognizer({ featConfig: { sampleRate: 16000, featureDim: 80 }, modelConfig: {
    senseVoice: { model: path.join(directory, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 },
    tokens: path.join(directory, 'tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0,
  } });
  const createVad = () => new sherpa.Vad({ sileroVad: { model: path.join(directory, 'silero_vad.onnx'), threshold: .5,
    minSilenceDuration: .65, minSpeechDuration: .25, maxSpeechDuration: 20, windowSize: 512 },
    sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0 }, 30);
  const createSession = () => new UtteranceStream({ vad: createVad(), decode: samples => {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples }); recognizer.decode(stream);
    return recognizer.getResult(stream).text;
  } });
  const recognize = pcm => {
    const session = createSession();
    return session.push(pcm, { final: true });
  };
  recognize.createSession = createSession;
  return recognize;
}

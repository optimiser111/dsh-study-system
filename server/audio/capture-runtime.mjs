import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const binary = new URL('../../models/loopback/loopback_capture_addon.node', import.meta.url);
const manifest = new URL('../../models/loopback/build.json', import.meta.url);
export function captureRuntimeReady() {
  try { return fs.existsSync(binary) && JSON.parse(fs.readFileSync(manifest)).version === 'pcm-silence-v1'; }
  catch { return false; }
}
export function loadCaptureRuntime() {
  if (!captureRuntimeReady()) throw new Error('音频采集扩展未就绪，请运行Setup-Audio.ps1');
  const expected = JSON.parse(fs.readFileSync(manifest)).sha256;
  if (createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== expected) throw new Error('音频采集扩展校验失败，请运行Setup-Audio.ps1');
  return require(fileURLToPath(binary));
}

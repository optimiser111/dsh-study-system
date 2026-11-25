import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const cwd = fileURLToPath(new URL('../', import.meta.url));
for (const args of [['test/run.mjs'], ['test/integration-plugin.mjs'], ['--test', 'test/review-warnings.mjs', 'test/m1-acceptance.mjs', 'test/lesson-assessment.mjs', 'test/dialogue.mjs', 'test/m2.mjs', 'test/knowledge.mjs', 'test/capture.mjs', 'test/no-questions.mjs', 'test/audio.mjs', 'test/audio-stream.mjs', 'test/desktop-capture.mjs', 'test/research.mjs', 'test/node-exploration.mjs', 'test/research-foundations.mjs', 'test/universal-foundations.mjs', 'test/deep-foundations.mjs', 'test/spatial-layout.mjs', 'test/camera-navigation.mjs', 'test/reading.mjs', 'test/vscode-reading.mjs', 'test/model-settings.mjs', 'test/native-search.mjs', 'test/source-reader.mjs', 'test/startup.mjs', 'test/panel-loading.mjs']]) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', env: { ...process.env, STUDY_LOG_DIR: path.join(cwd, '.probe/m1-test-logs') } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

import { applyEvent } from './events.mjs';

export const MODEL_TASKS = ['generation', 'grading', 'navigation'];
export function modelSettings(db) {
  const row = db.prepare("SELECT payload_json FROM events WHERE type='models.settings' ORDER BY rowid DESC LIMIT 1").get();
  return row ? JSON.parse(row.payload_json) : { tasks: {}, autoResearch: true };
}
export function saveModelSettings(db, value) {
  if (!value || typeof value.autoResearch !== 'boolean' || !value.tasks || typeof value.tasks !== 'object') throw new Error('模型设置不完整');
  const tasks = {};
  for (const key of MODEL_TASKS) {
    const choice = value.tasks[key];
    if (choice == null) continue;
    if (!['provider', 'model'].every((field) => typeof choice[field] === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/.test(choice[field]))) throw new Error('模型标识无效');
    tasks[key] = { provider: choice.provider, model: choice.model };
  }
  const result = { tasks, autoResearch: value.autoResearch };
  if (value.searchProvider !== undefined) {
    if (!['dsh', 'chatgpt'].includes(value.searchProvider)) throw new Error('搜索来源无效');
    result.searchProvider = value.searchProvider;
  }
  applyEvent(db, { type: 'models.settings', payload: result });
  return result;
}

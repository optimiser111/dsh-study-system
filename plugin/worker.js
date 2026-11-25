import { applyTools, reportWorkerFailure } from './index.js';

export const inject = ['tools', 'llm'];

export function apply(ctx, config = {}) {
  try { return applyTools(ctx, config); }
  catch (error) { reportWorkerFailure(error); throw error; }
}

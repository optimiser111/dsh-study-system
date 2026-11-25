export const UNCONFIRMED_COLOR = '#707b88';

// Automatic prerequisite inference and selection are not mastery evidence.
// Both renderers use this rule, including after a global node is reused.
export function nodeAppearance(node) {
  const pending = !node.status || ['unseen', 'assumed'].includes(node.status);
  return { pending, glow: !pending, color: pending ? UNCONFIRMED_COLOR : node.tone || '#75e4df' };
}

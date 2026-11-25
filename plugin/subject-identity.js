const labels = new Map([['math', '数学'], ['programming', '编程'], ['language', '语言'], ['other', '待归类']]);

export function normalizeSubject(value) {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ·&+.#/()_-]{0,31}$/u.test(name)) return null;
  for (const [axis, label] of labels) if (name.toLowerCase() === axis || name === label) return axis;
  return name;
}

export function subjectLabel(axis) { return labels.get(axis) || axis; }

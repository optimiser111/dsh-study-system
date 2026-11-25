import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function sourceRevision() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const hash = createHash('sha256');
  function visit(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) { if (name !== 'logs') visit(file); }
      else if (/\.(mjs|js|sql|ps1)$/.test(name)) hash.update(path.relative(root, file)).update(fs.readFileSync(file));
    }
  }
  visit(path.join(root, 'server')); visit(path.join(root, 'plugin'));
  return hash.digest('hex').slice(0, 16);
}

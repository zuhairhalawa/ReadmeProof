import { rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Removes the given directories (relative to the repo root). Cross-platform rm -rf. */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const dir of process.argv.slice(2)) {
  if (dir.includes('..') || dir.startsWith('/') || /^[A-Za-z]:/.test(dir)) {
    console.error('clean: refusing unsafe path: ' + dir);
    process.exit(2);
  }
  rmSync(resolve(root, dir), { recursive: true, force: true });
}

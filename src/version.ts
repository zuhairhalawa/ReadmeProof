import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = '@zuhairhalawa/readmeproof';

let cached: string | undefined;

/** Reads the version from the nearest package.json that belongs to this package. */
export function getVersion(): string {
  if (cached !== undefined) return cached;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const data = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
        if (data.name === PACKAGE_NAME && typeof data.version === 'string') {
          cached = data.version;
          return cached;
        }
      } catch {
        /* keep searching */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cached = '0.0.0-unknown';
  return cached;
}


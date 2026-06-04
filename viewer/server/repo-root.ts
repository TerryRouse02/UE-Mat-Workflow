import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function isRepoRoot(dir: string): boolean {
  return existsSync(resolve(dir, 'viewer', 'package.json'))
    && existsSync(resolve(dir, 'tools', 'node-t3d-metadata'));
}

export function resolveRepoRoot(startDir = process.cwd()): string {
  let dir = resolve(startDir);
  while (true) {
    if (isRepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

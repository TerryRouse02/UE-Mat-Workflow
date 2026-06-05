import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

// Tests run from <repo>/viewer/tests; the repo root (own git repo) is two up.
const repoRoot = resolve(__dirname, '../..');

// `git check-ignore` exits 0 when a path is ignored, 1 when it is not. It works on
// hypothetical paths, so it is valid even though the local-only files don't exist.
function isIgnored(relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relPath], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

describe('local-only files are gitignored', () => {
  it('ignores the work-MF index files and per-machine tooling config', () => {
    expect(isIgnored('agent-pack/workmf-index.json')).toBe(true);
    expect(isIgnored('agent-pack/workmf-index.export.json')).toBe(true);
    expect(isIgnored('tools/node-t3d-metadata/local.config.json')).toBe(true);
  });

  it('ignores project material crawl staging', () => {
    expect(isIgnored('tools/node-t3d-metadata/projectmat-staging/M_Test.t3d')).toBe(true);
  });

  it('does NOT ignore the committed example index', () => {
    expect(isIgnored('agent-pack/workmf-index.example.json')).toBe(false);
  });
});

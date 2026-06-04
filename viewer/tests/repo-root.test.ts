import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveRepoRoot } from '../server/repo-root';

function fixtureRepo(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'repo-root-'));
  mkdirSync(resolve(root, 'viewer'), { recursive: true });
  mkdirSync(resolve(root, 'tools', 'node-t3d-metadata'), { recursive: true });
  writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name: 'root' }));
  writeFileSync(resolve(root, 'viewer', 'package.json'), JSON.stringify({ name: 'viewer' }));
  return root;
}

describe('resolveRepoRoot', () => {
  it('keeps the repository root when started there', () => {
    const root = fixtureRepo();
    expect(resolveRepoRoot(root)).toBe(root);
  });

  it('walks from viewer cwd back to the repository root', () => {
    const root = fixtureRepo();
    expect(resolveRepoRoot(resolve(root, 'viewer'))).toBe(root);
  });
});

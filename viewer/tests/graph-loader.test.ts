import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadGraph } from '../server/graph-loader';

const REPO = resolve(__dirname, '..', '..');

describe('loadGraph', () => {
  it('loads a valid example', async () => {
    const r = await loadGraph(resolve(REPO, 'agent-pack/examples/01_basic_pbr.matgraph.json'));
    expect(r.errors).toEqual([]);
    expect(r.graph?.name).toBe('01_basic_pbr');
  });

  it('returns errors for missing file', async () => {
    const r = await loadGraph(resolve(REPO, 'graphs/nonexistent.matgraph.json'));
    expect(r.errors[0]).toMatch(/not found/i);
    expect(r.graph).toBe(null);
  });

  it('returns errors for malformed JSON', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(resolve(tmpdir(), 'mat-'));
    const p = resolve(dir, 'bad.matgraph.json');
    writeFileSync(p, '{bad json');
    const r = await loadGraph(p);
    expect(r.errors[0]).toMatch(/JSON/);
  });
});

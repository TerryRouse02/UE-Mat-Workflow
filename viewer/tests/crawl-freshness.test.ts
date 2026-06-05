import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadFreshness, recordFreshness } from '../server/crawl-freshness';

function makeTmpRepo() {
  return mkdtempSync(resolve(tmpdir(), 'freshness-'));
}

describe('crawl-freshness', () => {
  it('loadFreshness returns {} when the file does not exist', async () => {
    const root = makeTmpRepo();
    const result = await loadFreshness(root);
    expect(result).toEqual({});
  });

  it('recordFreshness writes an ISO string for the given kind', async () => {
    const root = makeTmpRepo();
    const iso = '2026-06-05T00:00:00.000Z';
    await recordFreshness(root, 'workmf', iso);
    const result = await loadFreshness(root);
    expect(result.workmf).toBe(iso);
    expect(result.export).toBeUndefined();
    expect(result.enginemf).toBeUndefined();
    expect(result.projectmat).toBeUndefined();
  });

  it('recordFreshness preserves existing keys when adding a new one', async () => {
    const root = makeTmpRepo();
    const iso1 = '2026-06-05T00:00:00.000Z';
    const iso2 = '2026-06-05T01:00:00.000Z';
    await recordFreshness(root, 'workmf', iso1);
    await recordFreshness(root, 'export', iso2);
    const result = await loadFreshness(root);
    expect(result.workmf).toBe(iso1);
    expect(result.export).toBe(iso2);
  });

  it('recordFreshness overwrites the same kind with a newer timestamp', async () => {
    const root = makeTmpRepo();
    await recordFreshness(root, 'workmf', '2026-06-05T00:00:00.000Z');
    await recordFreshness(root, 'workmf', '2026-06-05T02:00:00.000Z');
    const result = await loadFreshness(root);
    expect(result.workmf).toBe('2026-06-05T02:00:00.000Z');
  });
});

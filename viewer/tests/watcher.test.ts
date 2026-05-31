import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { watchGraphs } from '../server/watcher';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

describe('watchGraphs', () => {
  it('fires once for a batch of writes within debounce window', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'watch-'));
    mkdirSync(resolve(root, 'functions'), { recursive: true });

    const changes: string[][] = [];
    const w = watchGraphs(root, (changed) => { changes.push(changed); }, { debounceMs: 100 });
    await sleep(150); // let watcher settle

    writeFileSync(resolve(root, 'a.matgraph.json'), '{}');
    writeFileSync(resolve(root, 'functions/b.matgraph.json'), '{}');
    await sleep(50);
    writeFileSync(resolve(root, 'c.matgraph.json'), '{}');
    await sleep(250);

    await w.close();
    expect(changes.length).toBe(1);
    expect(changes[0].length).toBe(3);
  }, 5000);

  it('reports an unlinked file as removed, not as a changed graph', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'watch-'));
    const target = resolve(root, 'gone.matgraph.json');
    writeFileSync(target, '{}');

    const batches: { changed: string[]; removed: string[] }[] = [];
    const w = watchGraphs(root, (changed, removed) => { batches.push({ changed, removed }); }, { debounceMs: 100 });
    // Settle past any initial add/change for the pre-existing file so the
    // deletion lands in its own batch and we observe only the unlink handling.
    await sleep(400);
    const settleCount = batches.length;

    rmSync(target);
    await sleep(250);

    await w.close();
    const unlinkBatches = batches.slice(settleCount);
    // The delete must surface as removed in its batch...
    expect(unlinkBatches.some(b => b.removed.includes(target))).toBe(true);
    // ...and a deleted file must NEVER be re-sent as a changed graph (which
    // would emit a spurious graphError for a file that no longer exists).
    expect(unlinkBatches.every(b => !b.changed.includes(target))).toBe(true);
  }, 5000);
});

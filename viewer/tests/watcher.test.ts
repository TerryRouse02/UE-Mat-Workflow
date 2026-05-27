import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { watchGraphs } from '../server/watcher';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

describe('watchGraphs', () => {
  it('fires once for a batch of writes within debounce window', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'watch-'));
    mkdirSync(resolve(root, 'functions'), { recursive: true });

    const changes: string[][] = [];
    const w = watchGraphs(root, (paths) => { changes.push(paths); }, { debounceMs: 100 });
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
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createCheckpointStore } from '../server/agent/checkpoint.js';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'ckpt-redo-')); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

const viewer = () => join(tmpDir, 'viewer');
const exists = async (p: string) => access(p).then(() => true, () => false);

// A turnId shaped like the real loop's `${sessionId}-turn${n}` so the
// manifest-less rebuild path can also order it.
const TURN = 'sess-x-turn1';

describe('checkpoint cross-restart undo', () => {
  it('rebuilds the undo stack from disk so undo works after a "restart"', async () => {
    const target = join(tmpDir, 'g.matgraph.json');
    await writeFile(target, '{"v":"original"}\n', 'utf-8');

    // Session lifetime 1: snapshot + write.
    const s1 = createCheckpointStore(viewer(), 'sess-x');
    await s1.snapshotFile(TURN, target);
    await writeFile(target, '{"v":"modified"}\n', 'utf-8');

    // "Restart": a brand-new store object over the same on-disk session dir.
    const s2 = createCheckpointStore(viewer(), 'sess-x');
    expect(s2.canUndo()).toBe(false); // not loaded yet (sync, pre-await)
    const restored = await s2.undoLastTurn();
    expect(restored).toEqual([target]);
    expect(JSON.parse(await readFile(target, 'utf-8')).v).toBe('original');
  });

  it('manifest-less rebuild orders turns by the -turn<N> suffix', async () => {
    const f = join(tmpDir, 'f.matgraph.json');
    await writeFile(f, '{"v":0}\n', 'utf-8');
    const s1 = createCheckpointStore(viewer(), 'sess-y');
    // Create 12 turns so a lexical sort (turn10 < turn2) would mis-order.
    for (let n = 1; n <= 12; n++) {
      await writeFile(f, `{"v":${n - 1}}\n`, 'utf-8');
      await s1.snapshotFile(`sess-y-turn${n}`, f);
      await writeFile(f, `{"v":${n}}\n`, 'utf-8');
    }
    // Delete the manifest to force the directory-scan rebuild path.
    await rm(join(viewer(), '.agent-checkpoints', 'sess-y', '.stack.json'), { force: true });

    const s2 = createCheckpointStore(viewer(), 'sess-y');
    // Undo once → should restore the pre-image of turn12 (v=11), proving the
    // newest turn (not turn1, not turn9) sits on top.
    await s2.undoLastTurn();
    expect(JSON.parse(await readFile(f, 'utf-8')).v).toBe(11);
  });
});

describe('checkpoint redo', () => {
  it('redo re-applies the last undone turn (post-image)', async () => {
    const target = join(tmpDir, 'g.matgraph.json');
    await writeFile(target, '{"v":"original"}\n', 'utf-8');

    const s = createCheckpointStore(viewer(), 'sess-r');
    await s.snapshotFile(TURN, target);
    await writeFile(target, '{"v":"modified"}\n', 'utf-8');

    // Redoable undo → back to original, redo now available.
    const undone = await s.undoLastTurn(undefined, { redoable: true });
    expect(undone).toEqual([target]);
    expect(JSON.parse(await readFile(target, 'utf-8')).v).toBe('original');
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(true);

    // Redo → forward to modified again.
    const redone = await s.redoLastTurn();
    expect(redone).toEqual([target]);
    expect(JSON.parse(await readFile(target, 'utf-8')).v).toBe('modified');
    expect(s.canUndo()).toBe(true);
    expect(s.canRedo()).toBe(false);
  });

  it('redo handles a turn that CREATED a file (undo deletes, redo recreates)', async () => {
    const target = join(tmpDir, 'new.matgraph.json'); // absent before the turn
    const s = createCheckpointStore(viewer(), 'sess-c');
    await s.snapshotFile(TURN, target);           // pre-image = ABSENT
    await writeFile(target, '{"v":"created"}\n', 'utf-8');

    await s.undoLastTurn(undefined, { redoable: true });
    expect(await exists(target)).toBe(false);     // undo deleted it

    await s.redoLastTurn();
    expect(await exists(target)).toBe(true);       // redo recreated it
    expect(JSON.parse(await readFile(target, 'utf-8')).v).toBe('created');
  });

  it('redo survives a restart (stacks persist in the manifest)', async () => {
    const target = join(tmpDir, 'g.matgraph.json');
    await writeFile(target, '{"v":"original"}\n', 'utf-8');
    const s1 = createCheckpointStore(viewer(), 'sess-rr');
    await s1.snapshotFile(TURN, target);
    await writeFile(target, '{"v":"modified"}\n', 'utf-8');
    await s1.undoLastTurn(undefined, { redoable: true });

    // Restart: redo availability + image must come back from disk.
    const s2 = createCheckpointStore(viewer(), 'sess-rr');
    const redone = await s2.redoLastTurn();
    expect(redone).toEqual([target]);
    expect(JSON.parse(await readFile(target, 'utf-8')).v).toBe('modified');
  });

  it('a fresh turn forks history: the redo stack is dropped', async () => {
    const target = join(tmpDir, 'g.matgraph.json');
    await writeFile(target, '{"v":"original"}\n', 'utf-8');
    const s = createCheckpointStore(viewer(), 'sess-fork');
    await s.snapshotFile('sess-fork-turn1', target);
    await writeFile(target, '{"v":"modified"}\n', 'utf-8');
    await s.undoLastTurn(undefined, { redoable: true });
    expect(s.canRedo()).toBe(true);

    // New edit (new turn) from the undone state → redo future is abandoned.
    await s.snapshotFile('sess-fork-turn2', target);
    await writeFile(target, '{"v":"branch"}\n', 'utf-8');
    expect(s.canRedo()).toBe(false);
    expect(await s.redoLastTurn()).toBeNull();
  });

  it('a destructive (non-redoable) undo clears the redo stack', async () => {
    const target = join(tmpDir, 'g.matgraph.json');
    await writeFile(target, '{"v":"a"}\n', 'utf-8');
    const s = createCheckpointStore(viewer(), 'sess-d');
    await s.snapshotFile('sess-d-turn1', target);
    await writeFile(target, '{"v":"b"}\n', 'utf-8');
    await s.snapshotFile('sess-d-turn2', target);
    await writeFile(target, '{"v":"c"}\n', 'utf-8');

    await s.undoLastTurn(undefined, { redoable: true }); // undo turn2 → redo has it
    expect(s.canRedo()).toBe(true);
    await s.undoLastTurn();                               // regenerate-style undo turn1
    expect(s.canRedo()).toBe(false);                     // redo future dropped
    expect(await s.redoLastTurn()).toBeNull();
  });

  it('redoLastTurn returns null with nothing to redo', async () => {
    const s = createCheckpointStore(viewer(), 'sess-none');
    expect(await s.redoLastTurn()).toBeNull();
  });
});

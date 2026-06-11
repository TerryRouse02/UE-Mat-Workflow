// server/agent/checkpoint.ts — pre-image snapshot management for agent undo.
//
// Before each write_graph / patch_graph write, the caller snapshots the
// target file's current content (or a "did not exist" sentinel) into:
//   viewer/.agent-checkpoints/<sessionId>/<turnId>/
//
// Undo = restore all files in the latest turn directory back to their
// pre-image, then pop that turn off the stack.
//
// The .agent-checkpoints/ directory must be listed in the root .gitignore.

import { mkdir, readFile, readdir, writeFile, rename, rm, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';

/** Sentinel written when the target file did not exist before write. */
const ABSENT_SENTINEL = '\x00AGENT_CHECKPOINT_ABSENT\x00';

export interface CheckpointStore {
  /** Directory where this session's checkpoints live. */
  readonly sessionDir: string;

  /**
   * Snapshot the current state of `absPath` into the given turn.
   * If the file does not exist, records the absent sentinel.
   * Call this BEFORE the atomic write.
   */
  snapshotFile(turnId: string, absPath: string): Promise<void>;

  /**
   * Undo the last recorded turn: restore all snapshotted files to their
   * pre-image, then remove the turn directory from the stack.
   * Returns the list of restored abs paths, or null if there are no turns.
   */
  undoLastTurn(): Promise<string[] | null>;

  /** Stack of turn IDs from oldest to newest. */
  turnIds(): string[];
}

export function createCheckpointStore(viewerRoot: string, sessionId: string): CheckpointStore {
  const sessionDir = join(viewerRoot, '.agent-checkpoints', sessionId);
  const turns: string[] = [];

  // Track which (turnId, absPath) pairs have already been snapshotted.
  // Only the first write per path per turn records the pre-image.
  const seenPathsPerTurn = new Set<string>();

  async function ensureTurnDir(turnId: string): Promise<string> {
    const turnDir = join(sessionDir, turnId);
    await mkdir(turnDir, { recursive: true });
    return turnDir;
  }

  async function snapshotFile(turnId: string, absPath: string): Promise<void> {
    // Only the FIRST write to a given path within a turn records the pre-image.
    // Later writes in the same turn would otherwise overwrite the true pre-image.
    const slotKey = `${turnId}::${absPath}`;
    if (seenPathsPerTurn.has(slotKey)) {
      return; // already snapshotted this path for this turn — skip
    }
    seenPathsPerTurn.add(slotKey);

    const turnDir = await ensureTurnDir(turnId);

    // Track which turns we have seen.
    if (!turns.includes(turnId)) {
      turns.push(turnId);
    }

    // Encode the original abs path into the snapshot filename so we know
    // where to restore it.  Use base64url to avoid filesystem-unsafe chars.
    const encodedPath = Buffer.from(absPath, 'utf-8').toString('base64url');
    const snapshotFilePath = join(turnDir, encodedPath);

    let content: string;
    if (existsSync(absPath)) {
      try {
        content = await readFile(absPath, 'utf-8');
      } catch {
        content = ABSENT_SENTINEL;
      }
    } else {
      content = ABSENT_SENTINEL;
    }

    await writeFile(snapshotFilePath, content, 'utf-8');
  }

  async function undoLastTurn(): Promise<string[] | null> {
    if (turns.length === 0) return null;

    const turnId = turns[turns.length - 1];
    const turnDir = join(sessionDir, turnId);

    // Read all snapshot files in this turn directory.
    let entries: string[];
    try {
      entries = await readdir(turnDir);
    } catch {
      // Turn directory does not exist — pop and return empty.
      turns.pop();
      return [];
    }

    const restored: string[] = [];

    for (const entry of entries) {
      const snapshotPath = join(turnDir, entry);
      // The filename IS the base64url-encoded abs path (no slot prefix).
      const absPath = Buffer.from(entry, 'base64url').toString('utf-8');

      const content = await readFile(snapshotPath, 'utf-8');

      if (content === ABSENT_SENTINEL) {
        // File did not exist before — delete it now (if it still exists).
        try {
          await unlink(absPath);
        } catch {
          // Already gone — that's fine.
        }
      } else {
        // Restore: atomic write (temp + rename).
        const tmp = absPath + '.undo.' + process.pid + '.' + Date.now();
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(tmp, content, 'utf-8');
        await rename(tmp, absPath);
      }

      restored.push(absPath);
    }

    // Remove the turn directory and pop the stack.
    try {
      await rm(turnDir, { recursive: true, force: true });
    } catch {
      // Non-fatal.
    }
    turns.pop();

    // Prune seenPathsPerTurn entries for this turn so the set doesn't grow
    // without bound across a long-lived session.
    for (const key of [...seenPathsPerTurn]) {
      if (key.startsWith(`${turnId}::`)) seenPathsPerTurn.delete(key);
    }

    return restored;
  }

  function turnIds(): string[] {
    return [...turns];
  }

  return { sessionDir, snapshotFile, undoLastTurn, turnIds };
}

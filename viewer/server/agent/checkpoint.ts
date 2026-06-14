// server/agent/checkpoint.ts — pre-image snapshot management for agent undo/redo.
//
// Before each write_graph / patch_graph write, the caller snapshots the
// target file's current content (or a "did not exist" sentinel) into:
//   viewer/.agent-checkpoints/<sessionId>/<turnId>/
//
// Undo  = restore all files in the latest turn to their pre-image (state
//         BEFORE the turn), then move the turn onto the redo stack.
// Redo  = re-apply the latest undone turn's post-image (state AFTER the turn),
//         then move it back onto the undo stack.
//
// The undo/redo stacks are persisted to <sessionDir>/.stack.json so the history
// survives a server restart (pre-images were always on disk; before this they
// were orphaned because the stack lived only in memory). A turn's post-images
// are captured lazily at undo time into <sessionDir>/.redo/<turnId>/.
//
// The .agent-checkpoints/ directory must be listed in the root .gitignore.

import { mkdir, readFile, readdir, writeFile, rename, rm, unlink } from 'node:fs/promises';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';

/** Sentinel written when the target file did not exist at snapshot time. */
const ABSENT_SENTINEL = '\x00AGENT_CHECKPOINT_ABSENT\x00';

/** Reserved sessionDir children that are NOT turn directories. */
const STACK_FILE = '.stack.json';
const REDO_DIR = '.redo';

export interface CheckpointStore {
  /** Directory where this session's checkpoints live. */
  readonly sessionDir: string;

  /**
   * Snapshot the current state of `absPath` into the given turn.
   * If the file does not exist, records the absent sentinel.
   * Call this BEFORE the atomic write. A brand-new turn clears the redo stack
   * (a fresh edit forks history — the undone future is no longer reachable).
   */
  snapshotFile(turnId: string, absPath: string): Promise<void>;

  /**
   * Undo the last recorded turn: restore all snapshotted files to their
   * pre-image. Returns the list of restored abs paths, or null if there are no
   * turns.
   *
   * @param allowedRoot If provided, snapshot entries whose resolved target path
   *   lies outside this directory are NOT restored (loud skip — reported with a
   *   `!SKIPPED:` prefix). Pass undefined to restore all.
   * @param opts.redoable When true (the user-facing undo), the turn's CURRENT
   *   state is captured as a post-image first and the turn moves onto the redo
   *   stack. When false/omitted (regenerate's destructive rewind), the turn is
   *   discarded and the redo stack is cleared.
   */
  undoLastTurn(allowedRoot?: string, opts?: { redoable?: boolean }): Promise<string[] | null>;

  /**
   * Redo the last undone turn: re-apply its post-image. Returns the list of
   * re-applied abs paths, or null if there is nothing to redo. Honors the same
   * allowedRoot containment guard as undo.
   */
  redoLastTurn(allowedRoot?: string): Promise<string[] | null>;

  /** Stack of turn IDs from oldest to newest (best-effort: reflects in-memory
   *  state, which is loaded on the first async operation). */
  turnIds(): string[];

  /** Whether an undo is currently available (in-memory; valid after any await). */
  canUndo(): boolean;
  /** Whether a redo is currently available (in-memory; valid after any await). */
  canRedo(): boolean;
}

interface StackManifest { undo: string[]; redo: string[] }

export function createCheckpointStore(viewerRoot: string, sessionId: string): CheckpointStore {
  const sessionDir = join(viewerRoot, '.agent-checkpoints', sessionId);
  const redoRoot = join(sessionDir, REDO_DIR);
  const stackPath = join(sessionDir, STACK_FILE);

  // In-memory mirror of the persisted stacks. Populated by ensureLoaded() on
  // the first async op so the store survives a restart (loaded from disk) yet
  // turnIds()/canUndo()/canRedo() can stay synchronous for callers.
  let turns: string[] = [];
  let redo: string[] = [];

  // Track which (turnId, absPath) pairs have already been snapshotted this run.
  // Only the first write per path per turn records the pre-image.
  const seenPathsPerTurn = new Set<string>();

  // ── Persistence ────────────────────────────────────────────────────────────

  let loaded: Promise<void> | null = null;
  function ensureLoaded(): Promise<void> {
    if (!loaded) loaded = loadStacks();
    return loaded;
  }

  async function loadStacks(): Promise<void> {
    // Preferred source of truth: the manifest written by this module.
    try {
      const raw = await readFile(stackPath, 'utf-8');
      const m = JSON.parse(raw) as Partial<StackManifest>;
      if (Array.isArray(m.undo) && Array.isArray(m.redo)) {
        turns = m.undo.filter(t => typeof t === 'string');
        redo = m.redo.filter(t => typeof t === 'string');
        return;
      }
    } catch { /* no/!valid manifest → fall back to a directory scan */ }

    // Legacy / manifest-less rebuild: every non-reserved child dir is a turn.
    // Order by the monotonic `<sessionId>-turn<N>` suffix (lexical sort breaks
    // at turn10); turns with no parseable suffix fall back to name order.
    try {
      const entries = await readdir(sessionDir, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && e.name !== REDO_DIR && !e.name.startsWith('.'))
        .map(e => e.name);
      dirs.sort((a, b) => {
        const na = a.match(/-turn(\d+)$/)?.[1];
        const nb = b.match(/-turn(\d+)$/)?.[1];
        if (na !== undefined && nb !== undefined) return Number(na) - Number(nb);
        return a.localeCompare(b);
      });
      turns = dirs;
      redo = [];
    } catch {
      turns = [];
      redo = [];
    }
  }

  async function persistStacks(): Promise<void> {
    try {
      await mkdir(sessionDir, { recursive: true });
      await writeFile(stackPath, JSON.stringify({ undo: turns, redo } satisfies StackManifest), 'utf-8');
    } catch { /* non-fatal — worst case the stack falls back to a dir scan */ }
  }

  // ── Snapshot helpers (shared by pre-image + post-image capture/apply) ───────

  const enc = (absPath: string) => Buffer.from(absPath, 'utf-8').toString('base64url');
  const dec = (entry: string) => Buffer.from(entry, 'base64url').toString('utf-8');

  /** Current on-disk state of a path as a snapshot string (bytes or ABSENT). */
  async function captureState(absPath: string): Promise<string> {
    if (!existsSync(absPath)) return ABSENT_SENTINEL;
    try { return await readFile(absPath, 'utf-8'); }
    catch { return ABSENT_SENTINEL; }
  }

  /** Apply a snapshot string to a path: delete on ABSENT, else atomic write. */
  async function applyState(absPath: string, content: string): Promise<void> {
    if (content === ABSENT_SENTINEL) {
      try { await unlink(absPath); } catch { /* already gone */ }
      return;
    }
    const tmp = absPath + '.ckpt.' + process.pid + '.' + Date.now();
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(tmp, content, 'utf-8');
    await rename(tmp, absPath);
  }

  /** Restore every snapshot in `imgDir` onto its decoded target, honoring the
   *  allowedRoot containment guard. Returns the restored/skipped abs paths. */
  async function restoreFrom(imgDir: string, allowedRoot?: string): Promise<string[]> {
    let entries: string[];
    try { entries = await readdir(imgDir); }
    catch { return []; }

    const normAllowedRoot = allowedRoot ? resolve(allowedRoot) : null;
    const out: string[] = [];
    for (const entry of entries) {
      const absPath = dec(entry);
      // Defense-in-depth (§7): never touch a target outside the allowed root.
      // path.relative is separator-correct on both platforms — a '/'-prefix
      // check silently skipped EVERY restore on Windows ('\').
      if (normAllowedRoot) {
        const rel = relative(normAllowedRoot, resolve(absPath));
        const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
        if (!inside) {
          console.warn(`[checkpoint] skipping out-of-root path "${absPath}" (allowed root: "${allowedRoot}")`);
          out.push('!SKIPPED:' + absPath);
          continue;
        }
      }
      await applyState(absPath, await readFile(join(imgDir, entry), 'utf-8'));
      out.push(absPath);
    }
    return out;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async function snapshotFile(turnId: string, absPath: string): Promise<void> {
    await ensureLoaded();

    // Only the FIRST write to a given path within a turn records the pre-image;
    // later writes in the same turn would overwrite the true pre-image.
    const slotKey = `${turnId}::${absPath}`;
    if (seenPathsPerTurn.has(slotKey)) return;
    seenPathsPerTurn.add(slotKey);

    const turnDir = join(sessionDir, turnId);
    await mkdir(turnDir, { recursive: true });

    // A brand-new turn forks history: drop any redo future (its pre/post images
    // are now unreachable) before recording this turn.
    if (!turns.includes(turnId)) {
      if (redo.length > 0) {
        for (const rid of redo) {
          await rm(join(sessionDir, rid), { recursive: true, force: true }).catch(() => {});
          await rm(join(redoRoot, rid), { recursive: true, force: true }).catch(() => {});
        }
        redo = [];
      }
      turns.push(turnId);
    }

    await writeFile(join(turnDir, enc(absPath)), await captureState(absPath), 'utf-8');
    await persistStacks();
  }

  async function undoLastTurn(allowedRoot?: string, opts?: { redoable?: boolean }): Promise<string[] | null> {
    await ensureLoaded();
    if (turns.length === 0) return null;

    const turnId = turns[turns.length - 1];
    const turnDir = join(sessionDir, turnId);

    // Capture the CURRENT (post-turn) state as the redo image BEFORE restoring
    // the pre-image — but only for a redoable (user-facing) undo.
    if (opts?.redoable) {
      const redoDir = join(redoRoot, turnId);
      try {
        const preEntries = await readdir(turnDir);
        await mkdir(redoDir, { recursive: true });
        for (const entry of preEntries) {
          await writeFile(join(redoDir, entry), await captureState(dec(entry)), 'utf-8');
        }
      } catch { /* turn dir vanished — handled by restoreFrom below */ }
    }

    const restored = await restoreFrom(turnDir, allowedRoot);

    turns.pop();
    if (opts?.redoable) {
      redo.push(turnId);
    } else {
      // Destructive rewind (regenerate): discard this turn AND any redo future,
      // then drop their on-disk images.
      await rm(turnDir, { recursive: true, force: true }).catch(() => {});
      for (const rid of redo) {
        await rm(join(sessionDir, rid), { recursive: true, force: true }).catch(() => {});
        await rm(join(redoRoot, rid), { recursive: true, force: true }).catch(() => {});
      }
      redo = [];
    }

    // Prune seenPathsPerTurn for this turn so the set doesn't grow unbounded.
    for (const key of [...seenPathsPerTurn]) {
      if (key.startsWith(`${turnId}::`)) seenPathsPerTurn.delete(key);
    }

    await persistStacks();
    return restored;
  }

  async function redoLastTurn(allowedRoot?: string): Promise<string[] | null> {
    await ensureLoaded();
    if (redo.length === 0) return null;

    const turnId = redo[redo.length - 1];
    const redone = await restoreFrom(join(redoRoot, turnId), allowedRoot);

    redo.pop();
    turns.push(turnId);
    await persistStacks();
    return redone;
  }

  function turnIds(): string[] { return [...turns]; }
  function canUndo(): boolean { return turns.length > 0; }
  function canRedo(): boolean { return redo.length > 0; }

  return { sessionDir, snapshotFile, undoLastTurn, redoLastTurn, turnIds, canUndo, canRedo };
}

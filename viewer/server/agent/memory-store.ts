// server/agent/memory-store.ts — two-layer agent memory (M7b).
//
//   longterm: viewer/.agent-memory/longterm.md      — shared across sessions
//   session:  viewer/.agent-sessions/<id>.memory.md — scoped to one session
//
// Both are plain local markdown files (gitignored), written only through the
// read_memory / update_memory tools. Paths are FIXED — the tools accept no
// path input, so there is no traversal surface. A hard size cap keeps the
// memory injectable into the system prompt; an over-cap write fails loudly
// so the model condenses instead of silently truncating.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export type MemoryScope = 'session' | 'longterm';

/** Hard cap per memory file (characters). */
export const MEMORY_CHAR_CAP = 8000;

export interface MemoryStore {
  /** Returns '' when the file does not exist yet. */
  read(scope: MemoryScope): Promise<string>;
  /** Replace the whole file. Throws when content exceeds the cap. */
  replace(scope: MemoryScope, content: string): Promise<void>;
  /** Append a block (separated by a blank line). Throws when the result exceeds the cap. */
  append(scope: MemoryScope, content: string): Promise<void>;
  /** Absolute path for a scope (session delete cleans this up). */
  pathFor(scope: MemoryScope): string;
}

export function createMemoryStore(viewerRoot: string, sessionId: string): MemoryStore {
  const paths: Record<MemoryScope, string> = {
    longterm: join(viewerRoot, '.agent-memory', 'longterm.md'),
    session: join(viewerRoot, '.agent-sessions', `${sessionId}.memory.md`),
  };

  async function read(scope: MemoryScope): Promise<string> {
    try {
      return await readFile(paths[scope], 'utf-8');
    } catch {
      return '';
    }
  }

  async function writeAtomic(scope: MemoryScope, content: string): Promise<void> {
    if (content.length > MEMORY_CHAR_CAP) {
      throw new Error(
        `memory content too large (${content.length} chars; cap ${MEMORY_CHAR_CAP}). ` +
        'Condense the existing notes with op:"replace" instead.',
      );
    }
    const path = paths[scope];
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, content, 'utf-8');
    await rename(tmp, path);
  }

  return {
    read,
    replace: (scope, content) => writeAtomic(scope, content),
    append: async (scope, content) => {
      const existing = await read(scope);
      const merged = existing ? `${existing.replace(/\n+$/, '')}\n\n${content}` : content;
      await writeAtomic(scope, merged);
    },
    pathFor: (scope) => paths[scope],
  };
}

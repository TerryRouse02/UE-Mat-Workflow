// server/agent/session-store.ts — persistent agent sessions.
//
// Each session is one JSON file under viewer/.agent-sessions/<id>.json
// (gitignored, like the checkpoint directory). A file carries everything a
// session needs to survive a server restart:
//   - provider-neutral message history (for LLM continuation, incl. thinking
//     blocks for the Anthropic round-trip)
//   - the replayable UI transcript (user texts + coalesced SSE events)
//   - meta: title / timestamps / ueVersion / totalTokens / turnSeq
//
// Session files are server-side only. The transcript is served to the local
// UI via GET /api/agent/sessions/:id; raw messages are NEVER sent and the
// files must never be baked into a bundle or the HTML export.

import { mkdir, readFile, readdir, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Message } from './provider/types.js';
import type { AgentSessionMeta, AgentTranscriptEntry } from './agent-types.js';

/** On-disk shape (superset of the wire types). */
export interface PersistedSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  ueVersion: string;
  totalTokens: number;
  turnSeq: number;
  messages: Message[];
  transcript: AgentTranscriptEntry[];
}

/** Allowed session id shape — also the path-traversal guard for :id routes. */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Append a transcript entry, coalescing consecutive text/thinking events so
 * char-by-char streaming does not explode the file into thousands of entries.
 */
export function appendTranscript(transcript: AgentTranscriptEntry[], entry: AgentTranscriptEntry): void {
  if (entry.kind === 'event') {
    const ev = entry.event;
    const last = transcript[transcript.length - 1];
    if (
      last?.kind === 'event' &&
      (ev.type === 'text' || ev.type === 'thinking') &&
      last.event.type === ev.type
    ) {
      last.event = { type: ev.type, text: (last.event as { text: string }).text + ev.text };
      return;
    }
  }
  transcript.push(entry);
}

export interface SessionStore {
  readonly dir: string;
  list(): Promise<AgentSessionMeta[]>;
  load(id: string): Promise<PersistedSession | null>;
  save(session: PersistedSession): Promise<void>;
  remove(id: string): Promise<void>;
}

function toMeta(s: PersistedSession): AgentSessionMeta {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    ueVersion: s.ueVersion,
    totalTokens: s.totalTokens,
    turns: s.transcript.filter((e) => e.kind === 'user').length,
  };
}

export function createSessionStore(viewerRoot: string): SessionStore {
  const dir = join(viewerRoot, '.agent-sessions');

  async function load(id: string): Promise<PersistedSession | null> {
    if (!SESSION_ID_RE.test(id)) return null;
    try {
      const raw = await readFile(join(dir, `${id}.json`), 'utf-8');
      const parsed = JSON.parse(raw) as PersistedSession;
      if (parsed.id !== id || !Array.isArray(parsed.messages) || !Array.isArray(parsed.transcript)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async function list(): Promise<AgentSessionMeta[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const metas: AgentSessionMeta[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const s = await load(name.slice(0, -'.json'.length));
      if (s) metas.push(toMeta(s));
    }
    metas.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return metas;
  }

  async function save(session: PersistedSession): Promise<void> {
    if (!SESSION_ID_RE.test(session.id)) {
      throw new Error(`invalid session id: ${session.id}`);
    }
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${session.id}.json`);
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, JSON.stringify(session) + '\n', 'utf-8');
    await rename(tmp, path);
  }

  async function remove(id: string): Promise<void> {
    if (!SESSION_ID_RE.test(id)) return;
    await rm(join(dir, `${id}.json`), { force: true });
  }

  return { dir, list, load, save, remove };
}

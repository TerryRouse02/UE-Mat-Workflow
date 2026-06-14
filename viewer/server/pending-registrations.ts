// server/pending-registrations.ts — the self-service registration queue. A
// visitor's POST /api/auth/register lands here (NOT in users.json — they cannot
// log in yet); the admin approves/denies from Config → 團隊, and approval lands
// the pre-computed scrypt hash into the real user store via createUserPrehashed.
//
// One JSON under viewer/.auth/ (team-private, gitignored, like users.json):
//   pending-registrations.json  { pending: { [username]: PendingRegistration } }
//
// Lifecycle: pending --approve--> (removed; user created)   24h TTL on both
//            pending --deny-----> denied (kept until TTL so login can say so)

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateCredentials, hashPassword, USERNAME_RE } from './auth.js';

export const PENDING_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const MAX_PENDING = 200;                    // queue hard cap (anti-flood)

export type PendingStatus = 'pending' | 'denied';

export interface PendingRegistration {
  username: string;
  saltHex: string;
  hashHex: string;
  requestedAt: string;
  expiresAt: number; // epoch ms
  ip: string;
  status: PendingStatus;
}

export type RegResult = { ok: true } | { ok: false; error: string };

export interface PendingRegistrationStore {
  register(username: string, password: string, ip: string): Promise<RegResult>;
  list(): Promise<PendingRegistration[]>;
  pendingCount(): Promise<number>;
  get(username: string): Promise<PendingRegistration | null>;
  markDenied(username: string): Promise<void>;
  /** Returns the stored salt/hash for landing into users.json, then removes the entry. */
  approveMaterial(username: string): Promise<{ saltHex: string; hashHex: string } | null>;
  remove(username: string): Promise<void>;
  /** Drops entries past expiresAt (pending OR denied). Returns whether anything changed. */
  pruneExpired(now?: number): Promise<boolean>;
}

interface PendingFile { pending: Record<string, PendingRegistration>; }

export function createPendingRegistrationStore(viewerRoot: string): PendingRegistrationStore {
  const dir = join(viewerRoot, '.auth');
  const path = join(dir, 'pending-registrations.json');

  // Serialize every mutation so two concurrent registrations cannot interleave
  // read-modify-write cycles (mirrors auth.ts / proposal-store.ts).
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  async function load(): Promise<PendingFile> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as PendingFile;
      return parsed && typeof parsed === 'object' && parsed.pending ? parsed : { pending: {} };
    } catch { return { pending: {} }; }
  }

  async function persist(f: PendingFile): Promise<void> {
    await mkdir(dir, { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, JSON.stringify(f, null, 2) + '\n', 'utf-8');
    await rename(tmp, path);
  }

  function prune(f: PendingFile, now: number): boolean {
    let changed = false;
    for (const [name, e] of Object.entries(f.pending)) {
      if (e.expiresAt <= now) { delete f.pending[name]; changed = true; }
    }
    return changed;
  }

  async function list(): Promise<PendingRegistration[]> {
    const f = await load();
    if (prune(f, Date.now())) await persist(f);
    return Object.values(f.pending).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  return {
    list,
    register(username, password, ip) {
      return enqueue(async () => {
        const v = validateCredentials(username, password);
        if (!v.ok) return v;
        const f = await load();
        prune(f, Date.now());
        if (f.pending[username]) return { ok: false, error: 'a registration for this name is already pending' };
        if (Object.keys(f.pending).length >= MAX_PENDING) return { ok: false, error: 'registration queue is full — try again later' };
        const saltHex = randomBytes(16).toString('hex');
        f.pending[username] = {
          username,
          saltHex,
          hashHex: hashPassword(password, saltHex),
          requestedAt: new Date().toISOString(),
          expiresAt: Date.now() + PENDING_TTL_MS,
          ip,
          status: 'pending',
        };
        await persist(f);
        return { ok: true };
      });
    },
    async pendingCount() {
      return (await list()).filter((e) => e.status === 'pending').length;
    },
    async get(username) {
      if (!USERNAME_RE.test(username)) return null;
      const f = await load();
      if (prune(f, Date.now())) await persist(f);
      return f.pending[username] ?? null;
    },
    markDenied(username) {
      return enqueue(async () => {
        const f = await load();
        const e = f.pending[username];
        if (e) { e.status = 'denied'; await persist(f); }
      });
    },
    approveMaterial(username) {
      return enqueue(async () => {
        const f = await load();
        const e = f.pending[username];
        if (!e) return null;
        const material = { saltHex: e.saltHex, hashHex: e.hashHex };
        delete f.pending[username];
        await persist(f);
        return material;
      });
    },
    remove(username) {
      return enqueue(async () => {
        const f = await load();
        if (f.pending[username]) { delete f.pending[username]; await persist(f); }
      });
    },
    pruneExpired(now = Date.now()) {
      return enqueue(async () => {
        const f = await load();
        const changed = prune(f, now);
        if (changed) await persist(f);
        return changed;
      });
    },
  };
}

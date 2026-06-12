// server/agent/usage-store.ts — per-user daily token accounting for member
// quotas. One small JSON under viewer/.auth/ (team-mode private data):
//   usage.json  { days: { "2026-06-12": { artist: 12345 } } }
// Days older than RETENTION_DAYS are pruned on every write. Mutations are
// serialized through a promise queue and written atomically (tmp + rename),
// mirroring auth.ts.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const RETENTION_DAYS = 14;

interface UsageFile { days: Record<string, Record<string, number>> }

export interface UsageStore {
  /** Add token spend for a user (no-op for non-positive amounts). */
  add(username: string, tokens: number): Promise<void>;
  /** Tokens the user spent today (UTC day). */
  usedToday(username: string): Promise<number>;
  /** Today's full per-user map (admin dashboard). */
  today(): Promise<Record<string, number>>;
}

export function todayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function createUsageStore(viewerRoot: string, now: () => Date = () => new Date()): UsageStore {
  const dir = join(viewerRoot, '.auth');
  const path = join(dir, 'usage.json');

  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  async function load(): Promise<UsageFile> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as UsageFile;
      return parsed && typeof parsed.days === 'object' && parsed.days ? parsed : { days: {} };
    } catch {
      return { days: {} };
    }
  }

  async function persist(f: UsageFile): Promise<void> {
    await mkdir(dir, { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, JSON.stringify(f, null, 2) + '\n', 'utf-8');
    await rename(tmp, path);
  }

  function prune(f: UsageFile, today: string): void {
    const cutoff = new Date(now().getTime() - RETENTION_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
    for (const day of Object.keys(f.days)) {
      if (day < cutoff && day !== today) delete f.days[day];
    }
  }

  return {
    add(username, tokens) {
      if (!(tokens > 0)) return Promise.resolve();
      return enqueue(async () => {
        const f = await load();
        const day = todayKey(now());
        prune(f, day);
        const bucket = f.days[day] ?? (f.days[day] = {});
        bucket[username] = Math.round((bucket[username] ?? 0) + tokens);
        await persist(f);
      });
    },
    async usedToday(username) {
      const f = await load();
      return f.days[todayKey(now())]?.[username] ?? 0;
    },
    async today() {
      const f = await load();
      return { ...(f.days[todayKey(now())] ?? {}) };
    },
  };
}

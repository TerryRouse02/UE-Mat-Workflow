// server/agent/proposal-store.ts — the member→admin approval queue. A member
// turn's request_crawl / propose_db_edit no longer shows an approve button to
// the member (they cannot call the admin-only endpoints); instead the proposal
// lands here, the admin resolves it from Config → 團隊, and the outcome is
// injected back into the member's session as a（系統回報）.
//
// One JSON under viewer/.auth/ (team-private, like the usage ledger):
//   proposals.json  { proposals: AgentProposal[] }   (newest first, capped)

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const CAP = 100;

export type ProposalStatus = 'pending' | 'approved' | 'denied' | 'done' | 'failed';

export interface AgentProposal {
  id: string;
  kind: 'crawl' | 'db-edit';
  requester: string;
  sessionId: string;
  /** crawl: { kind, contentRoot } · db-edit: { nodeName, ueVersion, create, patch, rationale } */
  payload: Record<string, unknown>;
  createdAt: string;
  status: ProposalStatus;
  /** Deny reason / failure detail (shown in the inbox history). */
  note?: string;
  resolvedAt?: string;
}

export interface ProposalStore {
  list(): Promise<AgentProposal[]>;
  pendingCount(): Promise<number>;
  add(p: Omit<AgentProposal, 'id' | 'createdAt' | 'status'>): Promise<AgentProposal>;
  /** Patch a proposal by id; returns the updated record or null. */
  update(id: string, patch: Partial<Pick<AgentProposal, 'status' | 'note' | 'resolvedAt'>>): Promise<AgentProposal | null>;
  get(id: string): Promise<AgentProposal | null>;
}

export function createProposalStore(viewerRoot: string): ProposalStore {
  const dir = join(viewerRoot, '.auth');
  const path = join(dir, 'proposals.json');

  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  async function load(): Promise<AgentProposal[]> {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as { proposals?: AgentProposal[] };
      return Array.isArray(parsed.proposals) ? parsed.proposals : [];
    } catch {
      return [];
    }
  }

  async function persist(proposals: AgentProposal[]): Promise<void> {
    await mkdir(dir, { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmp, JSON.stringify({ proposals: proposals.slice(0, CAP) }, null, 2) + '\n', 'utf-8');
    await rename(tmp, path);
  }

  return {
    list: load,
    async pendingCount() {
      return (await load()).filter((p) => p.status === 'pending').length;
    },
    add(p) {
      return enqueue(async () => {
        const full: AgentProposal = {
          ...p,
          id: `prop-${Date.now()}-${randomBytes(3).toString('hex')}`,
          createdAt: new Date().toISOString(),
          status: 'pending',
        };
        const all = await load();
        all.unshift(full);
        await persist(all);
        return full;
      });
    },
    update(id, patch) {
      return enqueue(async () => {
        const all = await load();
        const p = all.find((x) => x.id === id);
        if (!p) return null;
        Object.assign(p, patch);
        await persist(all);
        return p;
      });
    },
    async get(id) {
      return (await load()).find((x) => x.id === id) ?? null;
    },
  };
}

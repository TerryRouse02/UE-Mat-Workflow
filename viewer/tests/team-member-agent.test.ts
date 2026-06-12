// team-member-agent.test.ts — the member-agent switch: owner-isolated private
// sessions, parallel chats across sessions, the stripped proposal tools, and
// self-service password change. FakeProvider only — no network, loopback bind.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, type RunningServer } from '../server/http-server.js';
import type { Provider, StreamEvent, ChatRequest, LLMConfig } from '../server/agent/provider/types.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function makeTmpRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'member-agt-'));
  mkdirSync(resolve(root, 'graphs'), { recursive: true });
  mkdirSync(resolve(root, 'tools', 'node-t3d-metadata'), { recursive: true });
  mkdirSync(resolve(root, 'viewer'), { recursive: true });
  try {
    symlinkSync(resolve(REPO_ROOT, 'agent-pack'), resolve(root, 'agent-pack'),
      process.platform === 'win32' ? 'junction' : 'dir');
  } catch { /* exists */ }
  return root;
}

function writeLocalConfig(root: string, config: Record<string, unknown>) {
  const path = resolve(root, 'tools', 'node-t3d-metadata', 'local.config.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

const json = (body: unknown, cookie?: string): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});

const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').match(/uemw_token=[^;]*/)![0];

/** A provider that records every request and replies with one text turn. */
class RecordingProvider implements Provider {
  requests: ChatRequest[] = [];
  /** Optional gate: the stream stalls until released (per call index). */
  gates = new Map<number, Promise<void>>();
  /** Optional fully scripted turns (consumed in order; falls back to text). */
  scripted: StreamEvent[][] = [];
  private calls = 0;
  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const idx = this.calls++;
    this.requests.push(req);
    const gate = this.gates.get(idx);
    if (gate) await gate;
    if (req.signal?.aborted) return;
    const turn = this.scripted.shift();
    if (turn) {
      for (const ev of turn) {
        if (req.signal?.aborted) return;
        yield ev;
      }
      return;
    }
    yield { type: 'text_delta', text: `回覆#${idx}` };
    yield { type: 'done', stopReason: 'end' };
  }
}

async function waitFor(cond: () => Promise<boolean>, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('waitFor timed out');
}

interface Team {
  base: string;
  server: RunningServer;
  root: string;
  admin: string;   // cookie
  artist: string;  // cookie
  provider: RecordingProvider;
}

async function setupTeam(): Promise<Team> {
  const root = makeTmpRoot();
  writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test', apiKey: 'sk-x' } });
  const provider = new RecordingProvider();
  const server = await startServer({
    repoRoot: root, port: 0, webDist: '', mode: 'team',
    providerFactory: (_c: LLMConfig) => provider,
  });
  const base = `http://localhost:${server.port}`;
  const setup = await fetch(`${base}/api/auth/setup`, json({ username: 'admin', password: 'password1' }));
  const admin = cookieOf(setup);
  await fetch(`${base}/api/auth/users`, json({ username: 'artist', password: 'password1', role: 'user' }, admin));
  const login = await fetch(`${base}/api/auth/login`, json({ username: 'artist', password: 'password1' }));
  const artist = cookieOf(login);
  return { base, server, root, admin, artist, provider };
}

async function teardown(t: Team) {
  await t.server.close();
  await rm(t.root, { recursive: true, force: true });
}

describe('member agent switch + owner isolation', () => {
  it('off by default → 403; on → members chat in their own sessions with proposal tools stripped', async () => {
    const t = await setupTeam();
    try {
      // Default: members are still locked out of the agent surface.
      expect((await fetch(`${t.base}/api/agent/sessions`, { headers: { cookie: t.artist } })).status).toBe(403);
      expect((await fetch(`${t.base}/api/agent/chat`, json({ text: 'hi' }, t.artist))).status).toBe(403);

      // Admin flips the switch (persists + reported by auth/status).
      expect((await fetch(`${t.base}/api/team`, json({ memberAgent: true }, t.admin))).status).toBe(200);
      const status = await (await fetch(`${t.base}/api/auth/status`, { headers: { cookie: t.artist } })).json();
      expect(status.memberAgent).toBe(true);

      // Member creates + chats in an own session.
      const created = await fetch(`${t.base}/api/agent/sessions`, { method: 'POST', headers: { cookie: t.artist } });
      expect(created.status).toBe(200);
      const { id: artistSession } = await created.json();
      const chat = await fetch(`${t.base}/api/agent/chat`, json({ text: '做個玻璃材質', sessionId: artistSession }, t.artist));
      expect(chat.status).toBe(200);
      await chat.text();

      // Members keep the proposal tools — their proposals divert into the
      // admin approval queue instead of showing approve buttons.
      const memberReq = t.provider.requests.at(-1)!;
      const toolNames = (memberReq.tools ?? []).map(td => td.name);
      expect(toolNames).toContain('request_crawl');
      expect(toolNames).toContain('propose_db_edit');
      expect(toolNames).toContain('web_search');

      // Admin turns keep the full toolset too.
      const adminChat = await fetch(`${t.base}/api/agent/chat`, json({ text: '管理員的問題' }, t.admin));
      expect(adminChat.status).toBe(200);
      await adminChat.text();
      const adminToolNames = (t.provider.requests.at(-1)!.tools ?? []).map(td => td.name);
      expect(adminToolNames).toContain('request_crawl');

      // Ownership: the member sees only their session; the admin sees both
      // (with owners). Foreign detail/delete 404 for the member.
      const artistList = await (await fetch(`${t.base}/api/agent/sessions`, { headers: { cookie: t.artist } })).json();
      expect(artistList.sessions.map((s: { id: string }) => s.id)).toEqual([artistSession]);
      expect(artistList.sessions[0].owner).toBe('artist');

      const adminList = await (await fetch(`${t.base}/api/agent/sessions`, { headers: { cookie: t.admin } })).json();
      expect(adminList.sessions.length).toBe(2);
      const owners = adminList.sessions.map((s: { owner?: string }) => s.owner).sort();
      expect(owners).toEqual(['admin', 'artist']);
      const adminSession = adminList.sessions.find((s: { owner?: string }) => s.owner === 'admin').id as string;

      expect((await fetch(`${t.base}/api/agent/sessions/${adminSession}`, { headers: { cookie: t.artist } })).status).toBe(404);
      expect((await fetch(`${t.base}/api/agent/sessions/${adminSession}`, { method: 'DELETE', headers: { cookie: t.artist } })).status).toBe(404);
      // Admin reads the member's session fine (admin 看全部).
      expect((await fetch(`${t.base}/api/agent/sessions/${artistSession}`, { headers: { cookie: t.admin } })).status).toBe(200);

      // Hard admin-only endpoints stay closed to members even with the switch on.
      expect((await fetch(`${t.base}/api/agent/db-edit`, json({}, t.artist))).status).toBe(403);
      expect((await fetch(`${t.base}/api/agent/test`, json({}, t.artist))).status).toBe(403);
      expect((await fetch(`${t.base}/api/agent/sessions/${artistSession}/public`, json({}, t.artist))).status).toBe(403);
    } finally {
      await teardown(t);
    }
  });

  it('two sessions stream in PARALLEL; the same session still 409s', async () => {
    const t = await setupTeam();
    try {
      await fetch(`${t.base}/api/team`, json({ memberAgent: true }, t.admin));
      const a = (await (await fetch(`${t.base}/api/agent/sessions`, { method: 'POST', headers: { cookie: t.admin } })).json()).id;
      const b = (await (await fetch(`${t.base}/api/agent/sessions`, { method: 'POST', headers: { cookie: t.artist } })).json()).id;

      // Gate the FIRST stream so it stays mid-turn while we test the others.
      let release!: () => void;
      t.provider.gates.set(0, new Promise<void>(r => { release = r; }));

      const slow = fetch(`${t.base}/api/agent/chat`, json({ text: '慢的', sessionId: a }, t.admin));
      await new Promise(r => setTimeout(r, 80)); // server marks session A streaming

      // Same session → 409.
      expect((await fetch(`${t.base}/api/agent/chat`, json({ text: '插隊', sessionId: a }, t.admin))).status).toBe(409);

      // DIFFERENT session → streams to completion while A is still running.
      const fast = await fetch(`${t.base}/api/agent/chat`, json({ text: '快的', sessionId: b }, t.artist));
      expect(fast.status).toBe(200);
      const fastBody = await fast.text();
      expect(fastBody).toContain('done');

      release();
      const slowRes = await slow;
      expect(slowRes.status).toBe(200);
      await slowRes.text();
    } finally {
      await teardown(t);
    }
  });
});

describe('member proposal approval queue', () => {
  it('member proposal → pendingApproval event → admin inbox → deny/approve inject reports', async () => {
    const t = await setupTeam();
    try {
      // The approve path WRITES nodes-ue5.7.json (then rolls back on the
      // failing audit). Replace the agent-pack symlink with a private copy so
      // the real repo file is never touched, even transiently.
      const { rmSync, cpSync } = await import('node:fs');
      rmSync(resolve(t.root, 'agent-pack'), { force: true, recursive: false });
      mkdirSync(resolve(t.root, 'agent-pack'), { recursive: true });
      for (const f of ['nodes-ue5.7.json', 'nodes-ue5.7.index.json', 'query-lib.js', 'query.js']) {
        cpSync(resolve(REPO_ROOT, 'agent-pack', f), resolve(t.root, 'agent-pack', f));
      }
      await fetch(`${t.base}/api/team`, json({ memberAgent: true }, t.admin));
      const sid = (await (await fetch(`${t.base}/api/agent/sessions`, { method: 'POST', headers: { cookie: t.artist } })).json()).id as string;

      // Scripted turns: two propose_db_edit rounds (request_crawl needs a
      // ready UE env, which a tmp root cannot fake over HTTP — the emit
      // interception is event-type-shared, so db-edit covers the queue path).
      t.provider.scripted = [
        [
          { type: 'tool_use', id: 'p1', name: 'propose_db_edit', input: { nodeName: 'Multiply', patch: { verified: true }, rationale: '已逐項核對' } },
          { type: 'done', stopReason: 'tool_use' },
        ],
        [{ type: 'text_delta', text: '已送出 DB 修改請求。' }, { type: 'done', stopReason: 'end' }],
        [
          { type: 'tool_use', id: 'p2', name: 'propose_db_edit', input: { nodeName: 'Lerp', patch: { verified: true }, rationale: '對照過編輯器' } },
          { type: 'done', stopReason: 'tool_use' },
        ],
        [{ type: 'text_delta', text: '已再送出。' }, { type: 'done', stopReason: 'end' }],
      ];

      // ① proposal — member stream carries pendingApproval.
      const c1 = await fetch(`${t.base}/api/agent/chat`, json({ text: 'Multiply 該標 verified', sessionId: sid }, t.artist));
      const body1 = await c1.text();
      expect(body1).toContain('"db_edit_proposal"');
      expect(body1).toContain('"pendingApproval":true');

      // Admin inbox sees it; member cannot reach the inbox.
      expect((await fetch(`${t.base}/api/agent/proposals`, { headers: { cookie: t.artist } })).status).toBe(403);
      let inbox = await (await fetch(`${t.base}/api/agent/proposals`, { headers: { cookie: t.admin } })).json() as { proposals: Array<{ id: string; kind: string; requester: string; status: string }> };
      expect(inbox.proposals.length).toBe(1);
      expect(inbox.proposals[0]).toMatchObject({ kind: 'db-edit', requester: 'artist', status: 'pending' });

      // Deny → a（系統回報）lands in the member session.
      const deny = await fetch(`${t.base}/api/agent/proposals/${inbox.proposals[0].id}`, json({ action: 'deny' }, t.admin));
      expect(deny.status).toBe(200);
      await waitFor(async () => {
        const detail = await (await fetch(`${t.base}/api/agent/sessions/${sid}`, { headers: { cookie: t.artist } })).json() as { transcript: unknown[] };
        return JSON.stringify(detail.transcript).includes('管理員拒絕');
      });

      // ② second proposal → approve. The tmp repo has no gen-node-index.js,
      // so the apply fails AND ROLLS BACK — the member still gets the report.
      const c2 = await fetch(`${t.base}/api/agent/chat`, json({ text: 'Lerp 也標一下', sessionId: sid }, t.artist));
      expect(await c2.text()).toContain('"pendingApproval":true');
      inbox = await (await fetch(`${t.base}/api/agent/proposals`, { headers: { cookie: t.admin } })).json() as typeof inbox;
      const dbProp = inbox.proposals.find(p => p.kind === 'db-edit' && p.status === 'pending')!;
      expect(dbProp).toBeTruthy();
      const approve = await fetch(`${t.base}/api/agent/proposals/${dbProp.id}`, json({ action: 'approve' }, t.admin));
      expect(approve.status).toBe(200);
      await waitFor(async () => {
        const detail = await (await fetch(`${t.base}/api/agent/sessions/${sid}`, { headers: { cookie: t.artist } })).json() as { transcript: unknown[] };
        return JSON.stringify(detail.transcript).includes('套用失敗');
      });
      const after = await (await fetch(`${t.base}/api/agent/proposals`, { headers: { cookie: t.admin } })).json() as typeof inbox;
      expect(after.proposals.find(p => p.id === dbProp.id)!.status).toBe('failed');
      // Already-resolved proposals refuse re-resolution.
      expect((await fetch(`${t.base}/api/agent/proposals/${dbProp.id}`, json({ action: 'approve' }, t.admin))).status).toBe(404);
    } finally {
      await teardown(t);
    }
  }, 20000);
});

describe('self-service password change', () => {
  it('verifies the old password, revokes other tokens, keeps this browser logged in', async () => {
    const t = await setupTeam();
    try {
      // Wrong old password → 401.
      expect((await fetch(`${t.base}/api/auth/password`, json({ oldPassword: 'nope-wrong', newPassword: 'password2' }, t.artist))).status).toBe(401);
      // Too-short new password → 400.
      expect((await fetch(`${t.base}/api/auth/password`, json({ oldPassword: 'password1', newPassword: 'short' }, t.artist))).status).toBe(400);

      // A second login session that should die with the change.
      const other = cookieOf(await fetch(`${t.base}/api/auth/login`, json({ username: 'artist', password: 'password1' })));

      const r = await fetch(`${t.base}/api/auth/password`, json({ oldPassword: 'password1', newPassword: 'password2' }, t.artist));
      expect(r.status).toBe(200);
      const fresh = cookieOf(r); // re-issued token keeps THIS browser in

      expect((await fetch(`${t.base}/api/env`, { headers: { cookie: fresh } })).status).toBe(200);
      expect((await fetch(`${t.base}/api/env`, { headers: { cookie: other } })).status).toBe(401);
      expect((await fetch(`${t.base}/api/auth/login`, json({ username: 'artist', password: 'password2' }))).status).toBe(200);
      expect((await fetch(`${t.base}/api/auth/login`, json({ username: 'artist', password: 'password1' }))).status).toBe(401);
    } finally {
      await teardown(t);
    }
  });
});

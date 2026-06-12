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
  private calls = 0;
  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const idx = this.calls++;
    this.requests.push(req);
    const gate = this.gates.get(idx);
    if (gate) await gate;
    if (req.signal?.aborted) return;
    yield { type: 'text_delta', text: `回覆#${idx}` };
    yield { type: 'done', stopReason: 'end' };
  }
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

      // The member turn offered NO proposal tools; web tools survive.
      const memberReq = t.provider.requests.at(-1)!;
      const toolNames = (memberReq.tools ?? []).map(td => td.name);
      expect(toolNames).not.toContain('request_crawl');
      expect(toolNames).not.toContain('propose_db_edit');
      expect(toolNames).toContain('web_search');

      // Admin turns keep the full toolset.
      const adminChat = await fetch(`${t.base}/api/agent/chat`, json({ text: '管理員的問題' }, t.admin));
      expect(adminChat.status).toBe(200);
      await adminChat.text();
      const adminToolNames = (t.provider.requests.at(-1)!.tools ?? []).map(td => td.name);
      expect(adminToolNames).toContain('request_crawl');
      expect(adminToolNames).toContain('propose_db_edit');

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

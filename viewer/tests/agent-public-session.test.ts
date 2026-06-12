// agent-public-session.test.ts — the team announcement channel:
// POST /api/agent/sessions/:id/public (designate/clear), GET
// /api/agent/public-session (transcript readable by every member), the
// `publicAgent` WS broadcast around a streaming turn, and the role gate
// (members read, only admins designate). FakeProvider only — no network.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { WebSocket } from 'ws';
import { startServer, type RunningServer } from '../server/http-server.js';
import type { Provider, StreamEvent, ChatRequest, LLMConfig } from '../server/agent/provider/types.js';
import type { AgentPublicSessionResponse } from '../server/agent/agent-types.js';

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..', '..');

function makeTmpRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'agt-pub-'));
  mkdirSync(resolve(root, 'graphs'), { recursive: true });
  mkdirSync(resolve(root, 'tools', 'node-t3d-metadata'), { recursive: true });
  mkdirSync(resolve(root, 'viewer'), { recursive: true });
  try { symlinkSync(resolve(REPO_ROOT, 'agent-pack'), resolve(root, 'agent-pack'), 'dir'); } catch { /* exists */ }
  return root;
}

function writeLocalConfig(root: string, config: Record<string, unknown>) {
  const path = resolve(root, 'tools', 'node-t3d-metadata', 'local.config.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

class FakeProvider implements Provider {
  constructor(private readonly turns: StreamEvent[][]) {}
  private callCount = 0;
  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const turn = this.turns[this.callCount++] ?? [
      { type: 'text_delta', text: '完成。' },
      { type: 'done', stopReason: 'end' },
    ];
    for (const event of turn) {
      if (req.signal?.aborted) return;
      yield event;
    }
  }
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function createSession(base: string, init: RequestInit = {}): Promise<string> {
  const r = await fetch(`${base}/api/agent/sessions`, { method: 'POST', ...init });
  expect(r.status).toBe(200);
  return (await r.json()).id as string;
}

/** Collect `publicAgent` WS messages into an array (caller closes the socket). */
function watchPublicAgent(port: number, headers?: Record<string, string>) {
  const messages: Array<{ id: string | null; streaming: boolean }> = [];
  const ws = new WebSocket(`ws://localhost:${port}`, { headers });
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.kind === 'publicAgent') messages.push({ id: msg.id, streaming: msg.streaming });
  });
  const open = new Promise<void>((res) => ws.on('open', () => res()));
  return { messages, ws, open };
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};

describe('announcement channel (local mode plumbing)', () => {
  it('designate → read → clear; deleting the public session clears the pointer', async () => {
    const root = makeTmpRoot();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const base = `http://localhost:${server.port}`;
    try {
      // Nothing designated yet.
      let pub = await (await fetch(`${base}/api/agent/public-session`)).json() as AgentPublicSessionResponse;
      expect(pub.id).toBeNull();

      // Unknown session id → 404.
      expect((await fetch(`${base}/api/agent/sessions/nope-123/public`, json({}))).status).toBe(404);

      const id = await createSession(base);
      expect((await fetch(`${base}/api/agent/sessions/${id}/public`, json({ public: true }))).status).toBe(200);

      pub = await (await fetch(`${base}/api/agent/public-session`)).json() as AgentPublicSessionResponse;
      expect(pub.id).toBe(id);
      expect(pub.streaming).toBe(false);
      expect(Array.isArray(pub.transcript)).toBe(true);

      // Clear it.
      expect((await fetch(`${base}/api/agent/sessions/${id}/public`, json({ public: false }))).status).toBe(200);
      pub = await (await fetch(`${base}/api/agent/public-session`)).json() as AgentPublicSessionResponse;
      expect(pub.id).toBeNull();

      // Re-designate, then DELETE the session — the pointer must die with it.
      await fetch(`${base}/api/agent/sessions/${id}/public`, json({}));
      expect((await fetch(`${base}/api/agent/sessions/${id}`, { method: 'DELETE' })).status).toBe(200);
      pub = await (await fetch(`${base}/api/agent/public-session`)).json() as AgentPublicSessionResponse;
      expect(pub.id).toBeNull();
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('broadcasts publicAgent on designate and around a streaming turn; transcript carries the turn', async () => {
    const root = makeTmpRoot();
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test-model', apiKey: 'sk-test' } });
    const factory = (_c: LLMConfig): Provider => new FakeProvider([[
      { type: 'text_delta', text: '公告：' },
      { type: 'text_delta', text: '今晚發佈 v2。' },
      { type: 'done', stopReason: 'end' },
    ]]);
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: factory });
    const base = `http://localhost:${server.port}`;
    const watcher = watchPublicAgent(server.port);
    try {
      await watcher.open;
      const id = await createSession(base);
      await fetch(`${base}/api/agent/sessions/${id}/public`, json({}));
      await waitFor(() => watcher.messages.length >= 1);
      expect(watcher.messages[0]).toEqual({ id, streaming: false });

      // A chat on the announcement session → streaming:true then streaming:false.
      const chat = await fetch(`${base}/api/agent/chat`, json({ text: '發個公告', sessionId: id }));
      expect(chat.status).toBe(200);
      await chat.text(); // drain the SSE stream to completion
      await waitFor(() => watcher.messages.some((m) => m.streaming === true));
      await waitFor(() => watcher.messages.filter((m) => m.streaming === false).length >= 2);

      const pub = await (await fetch(`${base}/api/agent/public-session`)).json() as AgentPublicSessionResponse;
      expect(pub.id).toBe(id);
      expect(JSON.stringify(pub.transcript)).toContain('今晚發佈 v2');

      // A late-joining socket gets the pointer replayed on connect.
      const late = watchPublicAgent(server.port);
      await late.open;
      await waitFor(() => late.messages.length >= 1);
      expect(late.messages[0]).toEqual({ id, streaming: false });
      late.ws.close();
    } finally {
      watcher.ws.close();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('announcement channel (team mode roles)', () => {
  it('members read the channel but cannot designate it; admins do both', async () => {
    const root = makeTmpRoot();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', mode: 'team' });
    const base = `http://localhost:${server.port}`;
    try {
      // Bootstrap admin + one member.
      const setup = await fetch(`${base}/api/auth/setup`, json({ username: 'admin', password: 'password1' }));
      const adminCookie = (setup.headers.get('set-cookie') ?? '').match(/uemw_token=[^;]*/)![0];
      await fetch(`${base}/api/auth/users`, {
        ...json({ username: 'artist', password: 'password1', role: 'user' }),
        headers: { 'content-type': 'application/json', cookie: adminCookie },
      });
      const login = await fetch(`${base}/api/auth/login`, json({ username: 'artist', password: 'password1' }));
      const artistCookie = (login.headers.get('set-cookie') ?? '').match(/uemw_token=[^;]*/)![0];

      const id = await createSession(base, { headers: { cookie: adminCookie } });

      // Member: cannot designate (admin-only), CAN read the channel.
      const deny = await fetch(`${base}/api/agent/sessions/${id}/public`, {
        ...json({}), headers: { 'content-type': 'application/json', cookie: artistCookie },
      });
      expect(deny.status).toBe(403);

      const ok = await fetch(`${base}/api/agent/sessions/${id}/public`, {
        ...json({}), headers: { 'content-type': 'application/json', cookie: adminCookie },
      });
      expect(ok.status).toBe(200);

      const pub = await (await fetch(`${base}/api/agent/public-session`, { headers: { cookie: artistCookie } })).json() as AgentPublicSessionResponse;
      expect(pub.id).toBe(id);

      // Member still cannot touch the rest of the agent surface.
      expect((await fetch(`${base}/api/agent/sessions`, { headers: { cookie: artistCookie } })).status).toBe(403);
      expect((await fetch(`${base}/api/agent/sessions/${id}`, { headers: { cookie: artistCookie } })).status).toBe(403);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

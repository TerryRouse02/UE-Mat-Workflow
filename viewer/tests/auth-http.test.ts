// auth-http.test.ts — team-mode HTTP integration: setup → login → cookie/Bearer
// access, role gating of the dangerous surface, user management, logout, and
// the WS upgrade gate. Servers run with mode:'team' while still binding
// loopback (the test override), so no test ever listens on a real interface.
// Also pins the local-mode regression: no auth anywhere.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { startServer, type RunningServer } from '../server/http-server.js';

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..', '..');

function makeTmpRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'auth-http-'));
  mkdirSync(resolve(root, 'graphs'), { recursive: true });
  mkdirSync(resolve(root, 'tools', 'node-t3d-metadata'), { recursive: true });
  mkdirSync(resolve(root, 'viewer'), { recursive: true });
  try { symlinkSync(resolve(REPO_ROOT, 'agent-pack'), resolve(root, 'agent-pack'), 'dir'); } catch { /* exists */ }
  return root;
}

async function withTeamServer(fn: (base: string, server: RunningServer) => Promise<void>) {
  const root = makeTmpRoot();
  const server = await startServer({ repoRoot: root, port: 0, webDist: '', mode: 'team' });
  try { await fn(`http://localhost:${server.port}`, server); }
  finally { await server.close(); await rm(root, { recursive: true, force: true }); }
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Extract the auth cookie pair (`uemw_token=...`) from a response. */
function cookieOf(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? '';
  const m = setCookie.match(/uemw_token=[^;]*/);
  expect(m, `expected auth cookie in: ${setCookie}`).not.toBeNull();
  return m![0];
}

async function setupAdmin(base: string): Promise<{ cookie: string; token: string }> {
  const res = await fetch(`${base}/api/auth/setup`, json({ username: 'admin', password: 'password1' }));
  expect(res.status).toBe(200);
  // Token rides the X-Auth-Token header (Bearer/CLI), never the JSON body.
  expect((await res.json()).token).toBeUndefined();
  return { cookie: cookieOf(res), token: res.headers.get('x-auth-token') as string };
}

describe('team mode: setup + login + status', () => {
  it('fresh server: status says needsSetup, every /api route is 401, setup creates the admin', async () => {
    await withTeamServer(async (base) => {
      const status = await (await fetch(`${base}/api/auth/status`)).json();
      expect(status).toMatchObject({ mode: 'team', needsSetup: true, authed: false });

      expect((await fetch(`${base}/api/env`)).status).toBe(401);
      expect((await fetch(`${base}/api/workmf`)).status).toBe(401);
      expect((await fetch(`${base}/api/agent/status`)).status).toBe(401);
      expect((await fetch(`${base}/api/config`, json({}))).status).toBe(401);

      const { cookie } = await setupAdmin(base);
      // Second setup attempt is refused.
      expect((await fetch(`${base}/api/auth/setup`, json({ username: 'evil', password: 'password1' }))).status).toBe(409);

      const authed = await (await fetch(`${base}/api/auth/status`, { headers: { cookie } })).json();
      expect(authed).toMatchObject({ mode: 'team', authed: true, username: 'admin', role: 'admin' });

      expect((await fetch(`${base}/api/env`, { headers: { cookie } })).status).toBe(200);
    });
  });

  it('login: wrong password 401, right password issues a working cookie AND Bearer token', async () => {
    await withTeamServer(async (base) => {
      await setupAdmin(base);

      expect((await fetch(`${base}/api/auth/login`, json({ username: 'admin', password: 'wrong-password' }))).status).toBe(401);

      const res = await fetch(`${base}/api/auth/login`, json({ username: 'admin', password: 'password1' }));
      expect(res.status).toBe(200);
      const cookie = cookieOf(res);
      const token = res.headers.get('x-auth-token')!;
      expect((await res.json()).token).toBeUndefined(); // never in the body

      expect((await fetch(`${base}/api/env`, { headers: { cookie } })).status).toBe(200);
      expect((await fetch(`${base}/api/env`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
      expect((await fetch(`${base}/api/env`, { headers: { authorization: 'Bearer forged' } })).status).toBe(401);
    });
  });

  it('logout revokes the token and clears the cookie', async () => {
    await withTeamServer(async (base) => {
      const { cookie } = await setupAdmin(base);
      const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
      expect(out.status).toBe(200);
      expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
      expect((await fetch(`${base}/api/env`, { headers: { cookie } })).status).toBe(401);
    });
  });
});

describe('team mode: roles + user management', () => {
  it('admin manages users; a "user" role keeps reads but loses the dangerous surface', async () => {
    await withTeamServer(async (base) => {
      const { cookie: admin } = await setupAdmin(base);

      // Create a regular member.
      const created = await fetch(`${base}/api/auth/users`, {
        ...json({ username: 'artist', password: 'password1', role: 'user' }),
        headers: { 'content-type': 'application/json', cookie: admin },
      });
      expect(created.status).toBe(200);

      const list = await (await fetch(`${base}/api/auth/users`, { headers: { cookie: admin } })).json();
      expect(list.users.map((u: { username: string }) => u.username).sort()).toEqual(['admin', 'artist']);

      const login = await fetch(`${base}/api/auth/login`, json({ username: 'artist', password: 'password1' }));
      const artist = cookieOf(login);

      // Allowed for members:
      expect((await fetch(`${base}/api/env`, { headers: { cookie: artist } })).status).toBe(200);
      expect((await fetch(`${base}/api/workmf`, { headers: { cookie: artist } })).status).toBe(200);
      expect((await fetch(`${base}/api/agent/status`, { headers: { cookie: artist } })).status).toBe(200);

      // Admin-only (403, not 401 — authenticated but not authorized):
      for (const [path, init] of [
        ['/api/config', json({})],
        ['/api/crawl', json({ kind: 'export' })],
        ['/api/crawl/cancel', { method: 'POST' }],
        ['/api/agent/chat', json({ message: 'hi' })],
        ['/api/agent/db-edit', json({})],
        ['/api/auth/users', json({ username: 'x', password: 'password1' })],
      ] as const) {
        const res = await fetch(`${base}${path}`, {
          ...(init as RequestInit),
          headers: { ...(init as RequestInit).headers as Record<string, string>, cookie: artist },
        });
        expect(res.status, `${path} should be admin-only`).toBe(403);
      }

      // Members cannot list users either.
      expect((await fetch(`${base}/api/auth/users`, { headers: { cookie: artist } })).status).toBe(403);

      // Admin resets the member's password → old login dies, new one works.
      const reset = await fetch(`${base}/api/auth/users/artist/password`, {
        ...json({ password: 'password2' }),
        headers: { 'content-type': 'application/json', cookie: admin },
      });
      expect(reset.status).toBe(200);
      expect((await fetch(`${base}/api/env`, { headers: { cookie: artist } })).status).toBe(401);
      expect((await fetch(`${base}/api/auth/login`, json({ username: 'artist', password: 'password2' }))).status).toBe(200);

      // Delete the member; the last admin is protected.
      expect((await fetch(`${base}/api/auth/users/artist`, { method: 'DELETE', headers: { cookie: admin } })).status).toBe(200);
      expect((await fetch(`${base}/api/auth/users/admin`, { method: 'DELETE', headers: { cookie: admin } })).status).toBe(400);
    });
  });
});

describe('team mode: WebSocket gate', () => {
  function wsResult(url: string, headers?: Record<string, string>): Promise<'open' | number> {
    return new Promise((resolveWs) => {
      const ws = new WebSocket(url, { headers });
      ws.on('message', () => { ws.close(); resolveWs('open'); }); // server sends `hello` on accept
      ws.on('close', (code) => resolveWs(code === 1000 ? 'open' : code));
      ws.on('error', () => { /* close fires after */ });
    });
  }

  it('rejects an upgrade without a token and accepts one with the cookie', async () => {
    await withTeamServer(async (base, server) => {
      const url = `ws://localhost:${server.port}`;
      const { cookie } = await setupAdmin(base);
      expect(await wsResult(url)).toBe(4401);
      expect(await wsResult(url, { cookie })).toBe('open');
    });
  });
});

describe('team mode: login rate limit', () => {
  it('blocks the IP after repeated failures', async () => {
    await withTeamServer(async (base) => {
      await setupAdmin(base);
      let status = 0;
      for (let i = 0; i < 12; i++) {
        status = (await fetch(`${base}/api/auth/login`, json({ username: 'admin', password: 'wrong-password' }))).status;
      }
      expect(status).toBe(429);
      // Even the RIGHT password is refused while blocked.
      expect((await fetch(`${base}/api/auth/login`, json({ username: 'admin', password: 'password1' }))).status).toBe(429);
    });
  });
});

describe('local mode regression', () => {
  it('no gate anywhere; auth endpoints report local mode', async () => {
    const root = makeTmpRoot();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const base = `http://localhost:${server.port}`;
    try {
      expect((await fetch(`${base}/api/env`)).status).toBe(200);
      expect((await fetch(`${base}/api/workmf`)).status).toBe(200);
      const status = await (await fetch(`${base}/api/auth/status`)).json();
      expect(status).toMatchObject({ mode: 'local', authed: true, role: 'admin', needsSetup: false });
      expect((await fetch(`${base}/api/auth/login`, json({ username: 'a', password: 'password1' }))).status).toBe(404);
      expect((await fetch(`${base}/api/auth/setup`, json({ username: 'a', password: 'password1' }))).status).toBe(404);
      expect((await fetch(`${base}/api/auth/users`)).status).toBe(404);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

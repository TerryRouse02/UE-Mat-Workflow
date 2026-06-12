// team-toggle.test.ts — the web-driven mode switch (POST /api/team):
// local → team enable (admin created BEFORE expose, live re-bind, auto-login
// cookie), team → local disable (accounts kept on disk), loopback/env-locked
// rejections, and the Secure-cookie flag. All on ephemeral ports.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startServer, type RunningServer } from '../server/http-server.js';

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..', '..');

function makeTmpRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'team-toggle-'));
  mkdirSync(resolve(root, 'graphs'), { recursive: true });
  mkdirSync(resolve(root, 'tools', 'node-t3d-metadata'), { recursive: true });
  mkdirSync(resolve(root, 'viewer'), { recursive: true });
  try { symlinkSync(resolve(REPO_ROOT, 'agent-pack'), resolve(root, 'agent-pack'), 'dir'); } catch { /* exists */ }
  return root;
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function withLocalServer(fn: (base: string, server: RunningServer, root: string) => Promise<void>) {
  const root = makeTmpRoot();
  const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
  try { await fn(`http://localhost:${server.port}`, server, root); }
  finally { await server.close(); await rm(root, { recursive: true, force: true }); }
}

describe('POST /api/team — enable from the web', () => {
  it('creates the admin BEFORE exposing, re-binds live on the same port, auto-logs the admin in', async () => {
    await withLocalServer(async (base, server, root) => {
      // Initial status: local, switchable, no accounts yet.
      const st0 = await (await fetch(`${base}/api/team`)).json();
      expect(st0).toMatchObject({ mode: 'local', envLocked: false, hasUsers: false, port: server.port });

      // Loopback target is refused — that would be team mode in name only.
      const loop = await fetch(`${base}/api/team`, json({ enabled: true, bindHost: '127.0.0.1', username: 'admin', password: 'password1' }));
      expect(loop.status).toBe(400);

      // Missing admin credentials on a fresh box is refused (no open window).
      const noCreds = await fetch(`${base}/api/team`, json({ enabled: true, bindHost: '0.0.0.0' }));
      expect(noCreds.status).toBe(400);
      expect(((await noCreds.json()) as { error: string }).error).toContain('管理員');

      // Proper enable: same port, team mode, cookie issued, share URLs returned.
      const on = await fetch(`${base}/api/team`, json({ enabled: true, bindHost: '0.0.0.0', username: 'admin', password: 'password1' }));
      expect(on.status).toBe(200);
      const onBody = await on.json() as { mode: string; port: number; urls: string[] };
      expect(onBody.mode).toBe('team');
      expect(onBody.port).toBe(server.port);
      expect(onBody.urls.length).toBeGreaterThan(0);
      const cookie = (on.headers.get('set-cookie') ?? '').match(/uemw_token=[^;]*/)![0];

      // The gate is live: unauthenticated 401, the auto-login cookie passes.
      expect((await fetch(`${base}/api/env`)).status).toBe(401);
      expect((await fetch(`${base}/api/env`, { headers: { cookie } })).status).toBe(200);
      const status = await (await fetch(`${base}/api/auth/status`, { headers: { cookie } })).json();
      expect(status).toMatchObject({ mode: 'team', authed: true, username: 'admin', role: 'admin' });

      // Persisted for the next boot.
      const cfg = JSON.parse(readFileSync(resolve(root, 'tools', 'node-t3d-metadata', 'local.config.json'), 'utf-8'));
      expect(cfg.Team).toMatchObject({ enabled: true, bindHost: '0.0.0.0' });
    });
  });

  it('disable keeps the accounts; re-enable reuses them without new credentials', async () => {
    await withLocalServer(async (base, _server, root) => {
      const on = await fetch(`${base}/api/team`, json({ enabled: true, bindHost: '0.0.0.0', username: 'admin', password: 'password1' }));
      const cookie = (on.headers.get('set-cookie') ?? '').match(/uemw_token=[^;]*/)![0];

      // Disable (admin-gated in team mode).
      expect((await fetch(`${base}/api/team`, json({ enabled: false }))).status).toBe(401); // no cookie
      const off = await fetch(`${base}/api/team`, { ...json({ enabled: false }), headers: { 'content-type': 'application/json', cookie } });
      expect(off.status).toBe(200);
      expect(((await off.json()) as { mode: string }).mode).toBe('local');

      // Back to open local mode; account files survive.
      expect((await fetch(`${base}/api/env`)).status).toBe(200);
      expect(existsSync(resolve(root, 'viewer', '.auth', 'users.json'))).toBe(true);
      expect(((await (await fetch(`${base}/api/team`)).json()) as { hasUsers: boolean }).hasUsers).toBe(true);

      // Re-enable without credentials: existing accounts carry over.
      const on2 = await fetch(`${base}/api/team`, json({ enabled: true, bindHost: '0.0.0.0' }));
      expect(on2.status).toBe(200);
      const login = await fetch(`${base}/api/auth/login`, json({ username: 'admin', password: 'password1' }));
      expect(login.status).toBe(200);
    });
  });

  it('secureCookies flag rides the same endpoint and marks the cookie', async () => {
    await withLocalServer(async (base) => {
      const on = await fetch(`${base}/api/team`, json({
        enabled: true, bindHost: '0.0.0.0', secureCookies: true,
        username: 'admin', password: 'password1',
      }));
      expect(on.status).toBe(200);
      expect(on.headers.get('set-cookie')).toContain('; Secure');
    });
  });

  it('is refused when BIND_HOST/env locks the mode', async () => {
    const root = makeTmpRoot();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', mode: 'team' });
    const base = `http://localhost:${server.port}`;
    try {
      await fetch(`${base}/api/auth/setup`, json({ username: 'admin', password: 'password1' }));
      const login = await fetch(`${base}/api/auth/login`, json({ username: 'admin', password: 'password1' }));
      const cookie = (login.headers.get('set-cookie') ?? '').match(/uemw_token=[^;]*/)![0];
      const r = await fetch(`${base}/api/team`, { ...json({ enabled: false }), headers: { 'content-type': 'application/json', cookie } });
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toContain('BIND_HOST');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

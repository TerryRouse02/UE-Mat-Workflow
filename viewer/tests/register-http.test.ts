// register-http.test.ts — self-registration + admin approval HTTP flow.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startServer, type RunningServer } from '../server/http-server.js';

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..', '..');

function makeTmpRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'register-http-'));
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

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function cookieOf(res: Response): string {
  const m = (res.headers.get('set-cookie') ?? '').match(/uemw_token=[^;]*/);
  return m![0];
}
async function setupAdmin(base: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/setup`, json({ username: 'admin', password: 'password1' }));
  expect(res.status).toBe(200);
  return cookieOf(res);
}
async function openRegistration(base: string, cookie: string) {
  const r = await fetch(`${base}/api/team`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ allowRegistration: true }) });
  expect(r.status).toBe(200);
}

describe('POST /api/auth/register', () => {
  it('403s when allowRegistration is off (the default)', async () => {
    await withTeamServer(async (base) => {
      await setupAdmin(base);
      const r = await fetch(`${base}/api/auth/register`, json({ username: 'alice', password: 'password1' }));
      expect(r.status).toBe(403);
    });
  });

  it('accepts a registration once opened; rejects a duplicate name and a too-short password', async () => {
    await withTeamServer(async (base) => {
      const cookie = await setupAdmin(base);
      await openRegistration(base, cookie);
      expect((await fetch(`${base}/api/auth/register`, json({ username: 'alice', password: 'password1' }))).status).toBe(200);
      expect((await fetch(`${base}/api/auth/register`, json({ username: 'alice', password: 'password1' }))).status).toBe(400);
      expect((await fetch(`${base}/api/auth/register`, json({ username: 'eve', password: 'short' }))).status).toBe(400);
      // a pending user cannot log in yet — transparent status
      const login = await fetch(`${base}/api/auth/login`, json({ username: 'alice', password: 'password1' }));
      expect(login.status).toBe(403);
      expect((await login.json()).error).toContain('審核中');
    });
  });

  it('rejects a name that already belongs to a real user', async () => {
    await withTeamServer(async (base) => {
      const cookie = await setupAdmin(base);
      await openRegistration(base, cookie);
      const r = await fetch(`${base}/api/auth/register`, json({ username: 'admin', password: 'password1' }));
      expect(r.status).toBe(400);
      expect((await r.json()).error).toContain('已被使用');
    });
  });
});

describe('admin approval', () => {
  it('approve creates a user with the 50K quota and lets them log in; deny blocks with a message', async () => {
    await withTeamServer(async (base) => {
      const cookie = await setupAdmin(base);
      await openRegistration(base, cookie);
      await fetch(`${base}/api/auth/register`, json({ username: 'alice', password: 'password1' }));
      await fetch(`${base}/api/auth/register`, json({ username: 'mallory', password: 'password1' }));

      const authed = { 'content-type': 'application/json', cookie };
      const list = await (await fetch(`${base}/api/auth/registrations`, { headers: { cookie } })).json();
      expect(list.registrations.map((p: { username: string }) => p.username).sort()).toEqual(['alice', 'mallory']);

      const ap = await fetch(`${base}/api/auth/registrations/alice`, { method: 'POST', headers: authed, body: JSON.stringify({ action: 'approve' }) });
      expect(ap.status).toBe(200);
      const team = await (await fetch(`${base}/api/team`, { headers: { cookie } })).json();
      expect(team.quotas?.alice).toBe(50000);
      const login = await fetch(`${base}/api/auth/login`, json({ username: 'alice', password: 'password1' }));
      expect(login.status).toBe(200);

      const dn = await fetch(`${base}/api/auth/registrations/mallory`, { method: 'POST', headers: authed, body: JSON.stringify({ action: 'deny' }) });
      expect(dn.status).toBe(200);
      const ml = await fetch(`${base}/api/auth/login`, json({ username: 'mallory', password: 'password1' }));
      expect(ml.status).toBe(403);
      expect((await ml.json()).error).toContain('拒絕');
    });
  });

  it('registrations endpoints are admin-only (401 without a token)', async () => {
    await withTeamServer(async (base) => {
      await setupAdmin(base);
      expect((await fetch(`${base}/api/auth/registrations`)).status).toBe(401);
      expect((await fetch(`${base}/api/auth/registrations/x`, json({ action: 'approve' }))).status).toBe(401);
    });
  });
});

describe('allowRegistration config', () => {
  it('defaults off, is echoed by status + team, and toggles via POST /api/team', async () => {
    await withTeamServer(async (base) => {
      const cookie = await setupAdmin(base);
      const s0 = await (await fetch(`${base}/api/auth/status`, { headers: { cookie } })).json();
      expect(s0.allowRegistration).toBe(false);
      await openRegistration(base, cookie);
      const s1 = await (await fetch(`${base}/api/auth/status`, { headers: { cookie } })).json();
      expect(s1.allowRegistration).toBe(true);
      const team = await (await fetch(`${base}/api/team`, { headers: { cookie } })).json();
      expect(team.allowRegistration).toBe(true);
    });
  });
});

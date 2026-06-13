// team-features.test.ts — the feature batch: web snapshot export
// (GET /api/export-html), human file management (POST /api/files), and
// member daily token quotas (Team.quotas + the usage ledger).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/http-server.js';
import { createUsageStore, todayKey } from '../server/agent/usage-store.js';
import type { Provider, StreamEvent, ChatRequest, LLMConfig } from '../server/agent/provider/types.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST_DIR = resolve(REPO_ROOT, 'viewer', 'web', 'dist');

const MINI_GRAPH = {
  schemaVersion: '1.0', type: 'Material', name: 'mini', ueVersion: '5.7',
  nodes: [
    { id: 'c1', type: 'Constant3Vector', params: { Constant: [1, 0, 0] } },
    { id: 'OUT', type: 'MaterialOutput', params: {} },
  ],
  connections: [{ from: 'c1:RGB', to: 'OUT:BaseColor' }],
};

function makeTmpRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'team-feat-'));
  mkdirSync(resolve(root, 'graphs', 'mini'), { recursive: true });
  mkdirSync(resolve(root, 'tools', 'node-t3d-metadata'), { recursive: true });
  mkdirSync(resolve(root, 'viewer'), { recursive: true });
  writeFileSync(resolve(root, 'graphs', 'mini', 'mini.matgraph.json'), JSON.stringify(MINI_GRAPH, null, 2));
  try {
    symlinkSync(resolve(REPO_ROOT, 'agent-pack'), resolve(root, 'agent-pack'),
      process.platform === 'win32' ? 'junction' : 'dir');
  } catch { /* exists */ }
  return root;
}

const json = (body: unknown, cookie?: string): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});

describe('GET /api/export-html', () => {
  it('bakes a downloadable single-file snapshot; rejects traversal', async () => {
    if (!existsSync(resolve(DIST_DIR, 'index.html'))) {
      console.warn('SKIP: viewer/web/dist absent; run pnpm build first');
      return;
    }
    const root = makeTmpRoot();
    const server = await startServer({ repoRoot: root, port: 0, webDist: DIST_DIR });
    const base = `http://localhost:${server.port}`;
    try {
      const r = await fetch(`${base}/api/export-html?name=${encodeURIComponent('mini/mini')}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/html');
      expect(r.headers.get('content-disposition')).toContain('mini.html');
      const html = await r.text();
      expect(html).toContain('__UE_MAT_EXPORT__');
      expect(html).toContain('mini/mini.matgraph.json');

      expect((await fetch(`${base}/api/export-html?name=../../etc/passwd`)).status).toBe(400);
      expect((await fetch(`${base}/api/export-html?name=`)).status).toBe(400);
      expect((await fetch(`${base}/api/export-html?name=nope/nope`)).status).toBe(500);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('POST /api/files', () => {
  it('rename rewrites the internal name; duplicate copies; delete removes; guards hold', async () => {
    const root = makeTmpRoot();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const base = `http://localhost:${server.port}`;
    try {
      // duplicate
      let r = await fetch(`${base}/api/files`, json({ op: 'duplicate', path: 'mini/mini.matgraph.json', to: 'mini/mini-copy.matgraph.json' }));
      expect(r.status).toBe(200);
      const copy = JSON.parse(readFileSync(resolve(root, 'graphs', 'mini', 'mini-copy.matgraph.json'), 'utf-8'));
      expect(copy.name).toBe('mini-copy');
      expect(existsSync(resolve(root, 'graphs', 'mini', 'mini.matgraph.json'))).toBe(true);

      // rename (move across folders)
      r = await fetch(`${base}/api/files`, json({ op: 'rename', path: 'mini/mini-copy.matgraph.json', to: 'renamed/metal.matgraph.json' }));
      expect(r.status).toBe(200);
      expect(existsSync(resolve(root, 'graphs', 'mini', 'mini-copy.matgraph.json'))).toBe(false);
      const moved = JSON.parse(readFileSync(resolve(root, 'graphs', 'renamed', 'metal.matgraph.json'), 'utf-8'));
      expect(moved.name).toBe('metal');

      // collision + traversal + missing + bad op
      expect((await fetch(`${base}/api/files`, json({ op: 'duplicate', path: 'mini/mini.matgraph.json', to: 'renamed/metal.matgraph.json' }))).status).toBe(409);
      expect((await fetch(`${base}/api/files`, json({ op: 'rename', path: 'mini/mini.matgraph.json', to: '../../evil.matgraph.json' }))).status).toBe(400);
      expect((await fetch(`${base}/api/files`, json({ op: 'delete', path: 'ghost/none.matgraph.json' }))).status).toBe(404);
      expect((await fetch(`${base}/api/files`, json({ op: 'chmod', path: 'mini/mini.matgraph.json' }))).status).toBe(400);

      // delete
      r = await fetch(`${base}/api/files`, json({ op: 'delete', path: 'renamed/metal.matgraph.json' }));
      expect(r.status).toBe(200);
      expect(existsSync(resolve(root, 'graphs', 'renamed', 'metal.matgraph.json'))).toBe(false);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('usage store', () => {
  it('accumulates per user per day and reports today', async () => {
    const tmp = mkdtempSync(resolve(tmpdir(), 'usage-'));
    try {
      const store = createUsageStore(tmp);
      await store.add('artist', 1200);
      await store.add('artist', 800.4);
      await store.add('admin', 50);
      await store.add('artist', -5); // ignored
      expect(await store.usedToday('artist')).toBe(2000);
      expect(await store.today()).toEqual({ artist: 2000, admin: 50 });
      expect(todayKey(new Date('2026-06-12T08:00:00Z'))).toBe('2026-06-12');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('member daily quota', () => {
  it('blocks the member with an inline SSE error once the ledger crosses the quota', async () => {
    const root = makeTmpRoot();
    writeFileSync(resolve(root, 'tools', 'node-t3d-metadata', 'local.config.json'),
      JSON.stringify({ Llm: { provider: 'anthropic', model: 'test', apiKey: 'sk-x' } }) + '\n');

    // Every turn reports a huge usage so one chat exhausts any small quota.
    const provider: Provider = {
      async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
        void req;
        yield { type: 'usage', inputTokens: 5_000, outputTokens: 100 };
        yield { type: 'text_delta', text: '好的' };
        yield { type: 'done', stopReason: 'end' };
      },
    };
    const server = await startServer({
      repoRoot: root, port: 0, webDist: '', mode: 'team',
      providerFactory: (_c: LLMConfig) => provider,
    });
    const base = `http://localhost:${server.port}`;
    try {
      const setup = await fetch(`${base}/api/auth/setup`, json({ username: 'admin', password: 'password1' }));
      const admin = (setup.headers.get('set-cookie') ?? '').match(/uemw_token=[^;]*/)![0];
      await fetch(`${base}/api/auth/users`, json({ username: 'artist', password: 'password1', role: 'user' }, admin));
      const login = await fetch(`${base}/api/auth/login`, json({ username: 'artist', password: 'password1' }));
      const artist = (login.headers.get('set-cookie') ?? '').match(/uemw_token=[^;]*/)![0];

      // Enable member agent + a 1000-token daily quota for artist.
      await fetch(`${base}/api/team`, json({ memberAgent: true, quotas: { artist: 1000 } }, admin));
      const team = await (await fetch(`${base}/api/team`, { headers: { cookie: admin } })).json();
      expect(team.quotas).toEqual({ artist: 1000 });

      // Turn 1 passes (ledger was 0) and books ~5100 tokens.
      const c1 = await fetch(`${base}/api/agent/chat`, json({ text: '第一回合' }, artist));
      expect(c1.status).toBe(200);
      expect(await c1.text()).toContain('done');

      // Turn 2 is refused inline with the quota message.
      const c2 = await fetch(`${base}/api/agent/chat`, json({ text: '第二回合' }, artist));
      expect(c2.status).toBe(200);
      const body2 = await c2.text();
      expect(body2).toContain('已達配額');
      expect(body2).not.toContain('回覆');

      // The dashboard sees the spend; the admin is never blocked.
      const team2 = await (await fetch(`${base}/api/team`, { headers: { cookie: admin } })).json();
      expect(team2.usageToday.artist).toBeGreaterThanOrEqual(5_000);
      const adminChat = await fetch(`${base}/api/agent/chat`, json({ text: '管理員不受限' }, admin));
      expect(adminChat.status).toBe(200);
      expect(await adminChat.text()).not.toContain('已達配額');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

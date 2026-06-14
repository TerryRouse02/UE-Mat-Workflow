// srv-config-language.test.ts — Team language config (a SOFT default the
// frontend uses to seed UI language) + per-turn language forwarded to the
// agent. Mirrors the memberLock persistence pattern, EXCEPT the server never
// enforces/overrides the per-turn value (unlike memberLock).
//
// Two seams:
//  1. POST /api/team {language} persists to local.config.json and is echoed by
//     GET /api/team + GET /api/auth/status (for ALL members).
//  2. The chat handler forwards body.language into runAgent's options.language,
//     defaulting to 'zh-Hant' and falling back to 'zh-Hant' on an invalid value.
//     runAgent is spied (the rest of ./agent/loop.js is the real module) so the
//     assertion depends only on the http-server wiring.

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Spy on runAgent while keeping every other export real (createSession,
// estimateMessagesTokens, VIEW_CONTEXT_PREFIX are all consumed by http-server).
const runAgentSpy = vi.fn();
vi.mock('../server/agent/loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/agent/loop.js')>();
  return {
    ...actual,
    runAgent: (...args: unknown[]) => {
      runAgentSpy(...args);
      // args: [userText, session, provider, model, ctx, emit, signal, options]
      const emit = args[5] as (e: { type: string }) => void;
      emit({ type: 'done' });
      return Promise.resolve();
    },
  };
});

import { startServer } from '../server/http-server.js';
import type { Provider, StreamEvent, ChatRequest, LLMConfig } from '../server/agent/provider/types.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

function makeTmpRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'srv-lang-'));
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

const localConfigPath = (root: string) =>
  resolve(root, 'tools', 'node-t3d-metadata', 'local.config.json');

const json = (body: unknown, cookie?: string): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});

const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').match(/uemw_token=[^;]*/)![0];

describe('Team language config (POST/GET /api/team + /api/auth/status)', () => {
  it('persists body.language, echoes it from GET /api/team and /api/auth/status for all members', async () => {
    const root = makeTmpRoot();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', mode: 'team' });
    const base = `http://localhost:${server.port}`;
    try {
      const setup = await fetch(`${base}/api/auth/setup`, json({ username: 'admin', password: 'password1' }));
      const admin = cookieOf(setup);
      await fetch(`${base}/api/auth/users`, json({ username: 'artist', password: 'password1', role: 'user' }, admin));
      const login = await fetch(`${base}/api/auth/login`, json({ username: 'artist', password: 'password1' }));
      const artist = cookieOf(login);

      // Default: no language configured yet.
      const team0 = await (await fetch(`${base}/api/team`, { headers: { cookie: admin } })).json();
      expect(team0.language).toBeUndefined();
      const status0 = await (await fetch(`${base}/api/auth/status`, { headers: { cookie: artist } })).json();
      expect(status0.language).toBeUndefined();

      // Admin sets the team default language to English.
      const set = await fetch(`${base}/api/team`, json({ language: 'en' }, admin));
      expect(set.status).toBe(200);

      // Persisted to local.config.json under Team.language.
      const saved = JSON.parse(readFileSync(localConfigPath(root), 'utf-8'));
      expect(saved.Team.language).toBe('en');

      // Echoed by GET /api/team.
      const team1 = await (await fetch(`${base}/api/team`, { headers: { cookie: admin } })).json();
      expect(team1.language).toBe('en');

      // Surfaced in /api/auth/status for the MEMBER too (a non-enforced seed).
      const statusMember = await (await fetch(`${base}/api/auth/status`, { headers: { cookie: artist } })).json();
      expect(statusMember.language).toBe('en');
      const statusAdmin = await (await fetch(`${base}/api/auth/status`, { headers: { cookie: admin } })).json();
      expect(statusAdmin.language).toBe('en');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads a saved Team.language at startup (local mode reads the on-disk config)', async () => {
    // NB: a test `mode: 'team'` override env-LOCKS the server, which by design
    // skips reading the on-disk Team config (savedTeam = {}). The startup-load
    // path only runs when NOT env-locked, i.e. plain local mode — mirroring how
    // memberLock/quotas/secureCookies also load only when unlocked.
    const root = makeTmpRoot();
    writeLocalConfig(root, { Team: { language: 'en' } });
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const base = `http://localhost:${server.port}`;
    try {
      const team = await (await fetch(`${base}/api/team`)).json();
      expect(team.language).toBe('en');
      // Local mode also surfaces it as the implicit-admin status seed.
      const status = await (await fetch(`${base}/api/auth/status`)).json();
      expect(status.mode).toBe('local');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an invalid language value (400, nothing persisted)', async () => {
    const root = makeTmpRoot();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', mode: 'team' });
    const base = `http://localhost:${server.port}`;
    try {
      const setup = await fetch(`${base}/api/auth/setup`, json({ username: 'admin', password: 'password1' }));
      const admin = cookieOf(setup);
      const bad = await fetch(`${base}/api/team`, json({ language: 'fr' }, admin));
      expect(bad.status).toBe(400);
      const team = await (await fetch(`${base}/api/team`, { headers: { cookie: admin } })).json();
      expect(team.language).toBeUndefined();
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('POST /api/agent/chat forwards body.language to runAgent', () => {
  const provider: Provider = {
    async *stream(_req: ChatRequest): AsyncGenerator<StreamEvent> {
      yield { type: 'done', stopReason: 'end' };
    },
  };

  function chatRoot(): string {
    const root = makeTmpRoot();
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test', apiKey: 'sk-x' } });
    return root;
  }

  it('forwards an explicit body.language into runAgent options.language', async () => {
    runAgentSpy.mockClear();
    const root = chatRoot();
    const server = await startServer({
      repoRoot: root, port: 0, webDist: '',
      providerFactory: (_c: LLMConfig) => provider,
    });
    const base = `http://localhost:${server.port}`;
    try {
      const r = await fetch(`${base}/api/agent/chat`, json({ text: 'hi', language: 'en' }));
      expect(r.status).toBe(200);
      await r.text();
      expect(runAgentSpy).toHaveBeenCalledTimes(1);
      const options = runAgentSpy.mock.calls[0][7] as { language?: string };
      expect(options.language).toBe('en');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('defaults to zh-Hant when body.language is absent', async () => {
    runAgentSpy.mockClear();
    const root = chatRoot();
    const server = await startServer({
      repoRoot: root, port: 0, webDist: '',
      providerFactory: (_c: LLMConfig) => provider,
    });
    const base = `http://localhost:${server.port}`;
    try {
      const r = await fetch(`${base}/api/agent/chat`, json({ text: 'hi' }));
      expect(r.status).toBe(200);
      await r.text();
      const options = runAgentSpy.mock.calls[0][7] as { language?: string };
      expect(options.language).toBe('zh-Hant');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to zh-Hant on an invalid body.language', async () => {
    runAgentSpy.mockClear();
    const root = chatRoot();
    const server = await startServer({
      repoRoot: root, port: 0, webDist: '',
      providerFactory: (_c: LLMConfig) => provider,
    });
    const base = `http://localhost:${server.port}`;
    try {
      const r = await fetch(`${base}/api/agent/chat`, json({ text: 'hi', language: 'fr' }));
      expect(r.status).toBe(200);
      await r.text();
      const options = runAgentSpy.mock.calls[0][7] as { language?: string };
      expect(options.language).toBe('zh-Hant');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does NOT override the per-turn language with the Team default (no server enforcement)', async () => {
    runAgentSpy.mockClear();
    const root = chatRoot();
    // Team default is English...
    const cfg = JSON.parse(readFileSync(localConfigPath(root), 'utf-8'));
    cfg.Team = { language: 'en' };
    writeFileSync(localConfigPath(root), JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
    const server = await startServer({
      repoRoot: root, port: 0, webDist: '',
      providerFactory: (_c: LLMConfig) => provider,
    });
    const base = `http://localhost:${server.port}`;
    try {
      // ...but the client sent zh-Hant for this turn — the server must respect it.
      const r = await fetch(`${base}/api/agent/chat`, json({ text: 'hi', language: 'zh-Hant' }));
      expect(r.status).toBe(200);
      await r.text();
      const options = runAgentSpy.mock.calls[0][7] as { language?: string };
      expect(options.language).toBe('zh-Hant');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

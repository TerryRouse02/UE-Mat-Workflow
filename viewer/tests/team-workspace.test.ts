// team-workspace.test.ts — member personal workspaces (graphs/users/<name>/),
// presence, and the 系統主Agent live delta stream.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { startServer, type RunningServer } from '../server/http-server.js';
import type { Provider, StreamEvent, ChatRequest, LLMConfig } from '../server/agent/provider/types.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const MINI = (name: string) => JSON.stringify({
  schemaVersion: '1.0', type: 'Material', name, ueVersion: '5.7',
  nodes: [{ id: 'OUT', type: 'MaterialOutput', params: {} }],
  connections: [],
}, null, 2);

function makeTmpRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'team-ws-'));
  for (const dir of ['graphs/shared', 'graphs/users/artist/glass', 'graphs/users/bob/secret', 'tools/node-t3d-metadata', 'viewer']) {
    mkdirSync(resolve(root, dir), { recursive: true });
  }
  writeFileSync(resolve(root, 'graphs/shared/shared.matgraph.json'), MINI('shared'));
  writeFileSync(resolve(root, 'graphs/users/artist/glass/glass.matgraph.json'), MINI('glass'));
  writeFileSync(resolve(root, 'graphs/users/bob/secret/secret.matgraph.json'), MINI('secret'));
  writeFileSync(resolve(root, 'tools/node-t3d-metadata/local.config.json'),
    JSON.stringify({ Llm: { provider: 'anthropic', model: 'test', apiKey: 'sk-x' } }) + '\n');
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
const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').match(/uemw_token=[^;]*/)![0];

class ScriptedProvider implements Provider {
  scripted: StreamEvent[][] = [];
  /** Every ChatRequest seen — lock tests assert thinking/tool composition. */
  requests: ChatRequest[] = [];
  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(req);
    const turn = this.scripted.shift() ?? [
      { type: 'text_delta', text: '完成。' }, { type: 'done', stopReason: 'end' },
    ];
    for (const ev of turn) {
      if (req.signal?.aborted) return;
      yield ev;
    }
  }
}

interface Harness { base: string; server: RunningServer; root: string; admin: string; artist: string; provider: ScriptedProvider }

async function setup(): Promise<Harness> {
  const root = makeTmpRoot();
  const provider = new ScriptedProvider();
  const server = await startServer({
    repoRoot: root, port: 0, webDist: '', mode: 'team',
    providerFactory: (_c: LLMConfig) => provider,
  });
  const base = `http://localhost:${server.port}`;
  const admin = cookieOf(await fetch(`${base}/api/auth/setup`, json({ username: 'admin', password: 'password1' })));
  await fetch(`${base}/api/auth/users`, json({ username: 'artist', password: 'password1', role: 'user' }, admin));
  const artist = cookieOf(await fetch(`${base}/api/auth/login`, json({ username: 'artist', password: 'password1' })));
  return { base, server, root, admin, artist, provider };
}

/** Open a WS with cookies and collect messages until closed. */
function openWs(port: number, cookie: string) {
  const ws = new WebSocket(`ws://localhost:${port}`, { headers: { cookie } });
  const messages: Array<Record<string, unknown>> = [];
  ws.on('message', raw => { try { messages.push(JSON.parse(raw.toString())); } catch { /* skip */ } });
  const opened = new Promise<void>(res => ws.on('open', () => res()));
  return { ws, messages, opened };
}

const until = async (cond: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
  expect(cond()).toBe(true);
};

describe('personal workspaces', () => {
  it('members see shared + their own dir only; admin sees all; reads/writes are guarded', async () => {
    const h = await setup();
    const artistWs = openWs(h.server.port, h.artist);
    const adminWs = openWs(h.server.port, h.admin);
    try {
      await artistWs.opened; await adminWs.opened;
      await until(() => artistWs.messages.some(m => m.kind === 'hello'));
      await until(() => adminWs.messages.some(m => m.kind === 'hello'));

      const paths = (msgs: Array<Record<string, unknown>>) =>
        ((msgs.find(m => m.kind === 'hello') as { files: Array<{ path: string }> }).files).map(f => f.path).sort();

      expect(paths(artistWs.messages)).toEqual([
        'shared/shared.matgraph.json',
        'users/artist/glass/glass.matgraph.json',
      ]);
      expect(paths(adminWs.messages)).toContain('users/bob/secret/secret.matgraph.json');

      // Member opening another member's file → graphError, no graph payload.
      artistWs.ws.send(JSON.stringify({ kind: 'open', path: 'users/bob/secret/secret.matgraph.json' }));
      await until(() => artistWs.messages.some(m => m.kind === 'graphError'));
      expect(artistWs.messages.some(m => m.kind === 'graph')).toBe(false);

      // HTTP guards: file ops + snapshot export on foreign personal files.
      const mv = await fetch(`${h.base}/api/files`, json({ op: 'rename', path: 'users/bob/secret/secret.matgraph.json', to: 'users/bob/secret/x.matgraph.json' }, h.artist));
      expect(mv.status).toBe(403);
      expect((await fetch(`${h.base}/api/export-html?name=${encodeURIComponent('users/bob/secret/secret')}`, { headers: { cookie: h.artist } })).status).toBe(403);
      // Stateless graph fetch (the diff view's source) honours the same wall.
      expect((await fetch(`${h.base}/api/graph?path=${encodeURIComponent('users/bob/secret/secret.matgraph.json')}`, { headers: { cookie: h.artist } })).status).toBe(403);
      expect((await fetch(`${h.base}/api/graph?path=${encodeURIComponent('shared/shared.matgraph.json')}`, { headers: { cookie: h.artist } })).status).toBe(200);
      // Own + shared stay manageable.
      expect((await fetch(`${h.base}/api/files`, json({ op: 'duplicate', path: 'users/artist/glass/glass.matgraph.json', to: 'users/artist/glass/glass2.matgraph.json' }, h.artist))).status).toBe(200);

      // Import into the personal workspace.
      const imp = await fetch(`${h.base}/api/import`, json({
        name: 'my_import', dest: 'personal',
        graph: { type: 'Material', name: 'my_import', ueVersion: '5.7', schemaVersion: '1.0', nodes: [{ id: 'OUT', type: 'MaterialOutput', params: {} }], connections: [] },
      }, h.artist));
      expect(imp.status).toBe(200);
      expect(((await imp.json()) as { path: string }).path.startsWith('users/artist/')).toBe(true);

      // Presence: both names online via GET /api/team.
      const team = await (await fetch(`${h.base}/api/team`, { headers: { cookie: h.admin } })).json() as { online: string[] };
      expect(team.online).toEqual(['admin', 'artist']);
    } finally {
      artistWs.ws.close(); adminWs.ws.close();
      await h.server.close();
      await rm(h.root, { recursive: true, force: true });
    }
  });

  it('member agent cannot write into another member\'s personal dir', async () => {
    const h = await setup();
    try {
      await fetch(`${h.base}/api/team`, json({ memberAgent: true }, h.admin));
      const sid = (await (await fetch(`${h.base}/api/agent/sessions`, { method: 'POST', headers: { cookie: h.artist } })).json()).id as string;
      h.provider.scripted = [
        [
          { type: 'tool_use', id: 'w1', name: 'write_graph', input: {
            path: 'users/bob/hack/hack.matgraph.json',
            graph: { type: 'Material', name: 'hack', ueVersion: '5.7', schemaVersion: '1.0', nodes: [{ id: 'OUT', type: 'MaterialOutput', params: {} }], connections: [] },
          } },
          { type: 'done', stopReason: 'tool_use' },
        ],
        [{ type: 'text_delta', text: '寫不進去。' }, { type: 'done', stopReason: 'end' }],
      ];
      const r = await fetch(`${h.base}/api/agent/chat`, json({ text: '寫到 bob 的目錄', sessionId: sid }, h.artist));
      const body = await r.text();
      expect(body).toContain('"name":"write_graph","ok":false');
      const probe = await fetch(`${h.base}/api/agent/sessions/${sid}`, { headers: { cookie: h.admin } });
      expect(probe.status).toBe(200);
      // And the file truly does not exist.
      const { existsSync } = await import('node:fs');
      expect(existsSync(resolve(h.root, 'graphs/users/bob/hack/hack.matgraph.json'))).toBe(false);
    } finally {
      await h.server.close();
      await rm(h.root, { recursive: true, force: true });
    }
  });
});

describe('member agent lock (admin-set thinking/🌐)', () => {
  it('locked member turns run with the admin values; admin stays free; clearing restores control', async () => {
    const h = await setup();
    try {
      await fetch(`${h.base}/api/team`, json({ memberAgent: true }, h.admin));

      // Invalid lock shape → 400; valid lock persists and is exposed.
      expect((await fetch(`${h.base}/api/team`, json({ memberLock: { thinking: 'turbo', webSearch: true } }, h.admin))).status).toBe(400);
      expect((await fetch(`${h.base}/api/team`, json({ memberLock: { thinking: 'off', webSearch: false } }, h.admin))).status).toBe(200);
      const team = await (await fetch(`${h.base}/api/team`, { headers: { cookie: h.admin } })).json() as { memberLock: unknown };
      expect(team.memberLock).toEqual({ thinking: 'off', webSearch: false });
      // Members read the lock from auth status (the UI grays the controls).
      const st = await (await fetch(`${h.base}/api/auth/status`, { headers: { cookie: h.artist } })).json() as { memberLock?: unknown };
      expect(st.memberLock).toEqual({ thinking: 'off', webSearch: false });

      // A locked member sends thinking:high + 🌐 on — the server overrides both.
      const sid = (await (await fetch(`${h.base}/api/agent/sessions`, { method: 'POST', headers: { cookie: h.artist } })).json()).id as string;
      h.provider.scripted = [[{ type: 'text_delta', text: 'ok' }, { type: 'done', stopReason: 'end' }]];
      await (await fetch(`${h.base}/api/agent/chat`, json({ text: '測試', sessionId: sid, thinking: 'high' }, h.artist))).text();
      const memberReq = h.provider.requests.at(-1)!;
      expect(memberReq.thinking).toBeUndefined();
      expect((memberReq.tools ?? []).map(t => t.name)).not.toContain('web_search');

      // The admin's own turns are never locked.
      const asid = (await (await fetch(`${h.base}/api/agent/sessions`, { method: 'POST', headers: { cookie: h.admin } })).json()).id as string;
      h.provider.scripted = [[{ type: 'text_delta', text: 'ok' }, { type: 'done', stopReason: 'end' }]];
      await (await fetch(`${h.base}/api/agent/chat`, json({ text: '測試', sessionId: asid, thinking: 'low' }, h.admin))).text();
      const adminReq = h.provider.requests.at(-1)!;
      expect(adminReq.thinking).toBe('low');
      expect((adminReq.tools ?? []).map(t => t.name)).toContain('web_search');

      // memberLock:null clears the lock; member control is restored.
      expect((await fetch(`${h.base}/api/team`, json({ memberLock: null }, h.admin))).status).toBe(200);
      h.provider.scripted = [[{ type: 'text_delta', text: 'ok' }, { type: 'done', stopReason: 'end' }]];
      await (await fetch(`${h.base}/api/agent/chat`, json({ text: '再測', sessionId: sid, thinking: 'high' }, h.artist))).text();
      expect(h.provider.requests.at(-1)!.thinking).toBe('high');
    } finally {
      await h.server.close();
      await rm(h.root, { recursive: true, force: true });
    }
  });
});

describe('member agent default write target', () => {
  it('a NEW graph from a member agent lands in users/<member>/, not the shared root', async () => {
    const h = await setup();
    try {
      await fetch(`${h.base}/api/team`, json({ memberAgent: true }, h.admin));
      const sid = (await (await fetch(`${h.base}/api/agent/sessions`, { method: 'POST', headers: { cookie: h.artist } })).json()).id as string;
      h.provider.scripted = [
        [
          { type: 'tool_use', id: 'w2', name: 'write_graph', input: {
            path: 'metal/metal.matgraph.json',
            graph: { type: 'Material', name: 'metal', ueVersion: '5.7', schemaVersion: '1.0', nodes: [{ id: 'OUT', type: 'MaterialOutput', params: {} }], connections: [] },
          } },
          { type: 'done', stopReason: 'tool_use' },
        ],
        [{ type: 'text_delta', text: '已寫入你的工作區。' }, { type: 'done', stopReason: 'end' }],
      ];
      const r = await fetch(`${h.base}/api/agent/chat`, json({ text: '做一個金屬材質', sessionId: sid }, h.artist));
      const body = await r.text();
      expect(body).toContain('users/artist/metal/metal.matgraph.json');

      const { existsSync } = await import('node:fs');
      expect(existsSync(resolve(h.root, 'graphs/users/artist/metal/metal.matgraph.json'))).toBe(true);
      expect(existsSync(resolve(h.root, 'graphs/metal/metal.matgraph.json'))).toBe(false);
    } finally {
      await h.server.close();
      await rm(h.root, { recursive: true, force: true });
    }
  });
});

describe('系統主Agent live stream', () => {
  it('viewers receive publicAgentDelta events while the designated session streams', async () => {
    const h = await setup();
    const viewer = openWs(h.server.port, h.artist);
    try {
      await viewer.opened;
      const sid = (await (await fetch(`${h.base}/api/agent/sessions`, { method: 'POST', headers: { cookie: h.admin } })).json()).id as string;
      await fetch(`${h.base}/api/agent/sessions/${sid}/public`, json({}, h.admin));

      h.provider.scripted = [[
        { type: 'text_delta', text: '今晚' },
        { type: 'text_delta', text: '發佈 v3。' },
        { type: 'done', stopReason: 'end' },
      ]];
      const chat = await fetch(`${h.base}/api/agent/chat`, json({ text: '發公告', sessionId: sid }, h.admin));
      await chat.text();

      await until(() => viewer.messages.filter(m => m.kind === 'publicAgentDelta').length >= 2);
      const deltas = viewer.messages.filter(m => m.kind === 'publicAgentDelta') as Array<{ id: string; event: { type: string; text?: string } }>;
      expect(deltas.every(d => d.id === sid)).toBe(true);
      expect(deltas.map(d => d.event).filter(e => e.type === 'text').map(e => e.text).join('')).toContain('今晚發佈 v3。');
    } finally {
      viewer.ws.close();
      await h.server.close();
      await rm(h.root, { recursive: true, force: true });
    }
  });
});

describe('public-deploy hardening: infra/path redaction + cross-member explain', () => {
  it('hides infra URLs + VPS paths from members and refuses cross-member explain', async () => {
    const h = await setup();
    try {
      // Give the saved config real infra URLs + absolute UE paths so redaction is observable.
      writeFileSync(resolve(h.root, 'tools/node-t3d-metadata/local.config.json'),
        JSON.stringify({
          Llm: { provider: 'anthropic', model: 'test', apiKey: 'sk-secret', baseUrl: 'http://10.0.0.5:1234/v1' },
          Web: { proxyUrl: 'http://127.0.0.1:7890', searxngBaseUrl: 'http://10.0.0.9:8888' },
          ProjectPath: '/srv/secret/MyGame.uproject', EngineRoot: '/opt/UE_5.7',
        }) + '\n');

      // /api/agent/status — admin sees infra URLs; member never does; apiKey never serialized.
      const adminStatus = await (await fetch(`${h.base}/api/agent/status`, { headers: { cookie: h.admin } })).json();
      expect(adminStatus.baseUrl).toBe('http://10.0.0.5:1234/v1');
      expect(adminStatus.webProxyUrl).toBe('http://127.0.0.1:7890');
      expect(adminStatus).not.toHaveProperty('apiKey');
      const memberStatus = await (await fetch(`${h.base}/api/agent/status`, { headers: { cookie: h.artist } })).json();
      expect(memberStatus.provider).toBe('anthropic');   // capability still visible
      expect(memberStatus.hasApiKey).toBe(true);
      expect(memberStatus.baseUrl).toBeUndefined();
      expect(memberStatus.searxngBaseUrl).toBeUndefined();
      expect(memberStatus.webProxyUrl).toBeUndefined();

      // /api/env — admin sees absolute paths; member gets them nulled and no path leaks via details.
      const adminEnv = await (await fetch(`${h.base}/api/env`, { headers: { cookie: h.admin } })).json();
      expect(adminEnv.projectPath).toBe('/srv/secret/MyGame.uproject');
      expect(adminEnv.engineRoot).toBe('/opt/UE_5.7');
      const memberEnv = await (await fetch(`${h.base}/api/env`, { headers: { cookie: h.artist } })).json();
      expect(memberEnv.projectPath).toBeNull();
      expect(memberEnv.engineRoot).toBeNull();
      expect(JSON.stringify(memberEnv)).not.toContain('/srv/secret');

      // /api/agent/explain — a member cannot read another member's private graph topology.
      const cross = await fetch(`${h.base}/api/agent/explain`,
        json({ nodeType: 'Multiply', graphPath: 'users/bob/secret/secret.matgraph.json', nodeId: 'OUT' }, h.artist));
      const crossBody = await cross.json();
      expect(crossBody.ok).toBe(false);
      expect(crossBody.error).toContain('無權');
    } finally {
      await h.server.close();
      await rm(h.root, { recursive: true, force: true });
    }
  });
});

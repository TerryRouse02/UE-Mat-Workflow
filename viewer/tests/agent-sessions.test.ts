// M7 persistent-session tests — /api/agent/sessions CRUD, explicit sessionId
// binding on chat, transcript persistence/replay, and survival across a
// server restart. Zero real API calls (providerFactory injection).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { startServer } from '../server/http-server.js';
import type { Provider, StreamEvent, ChatRequest, LLMConfig } from '../server/agent/provider/types.js';
import type {
  AgentSseEvent,
  AgentSessionsListResponse,
  AgentSessionCreateResponse,
  AgentSessionDetail,
} from '../server/agent/agent-types.js';
import { createSessionStore, appendTranscript } from '../server/agent/session-store.js';
import type { AgentTranscriptEntry } from '../server/agent/agent-types.js';

// ---------------------------------------------------------------------------
// Helpers (mirrors agent-http.test.ts)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..', '..');

function makeTmpRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'agt-sess-'));
  mkdirSync(resolve(root, 'graphs'), { recursive: true });
  mkdirSync(resolve(root, 'tools', 'node-t3d-metadata'), { recursive: true });
  mkdirSync(resolve(root, 'viewer'), { recursive: true });
  try {
    symlinkSync(resolve(REPO_ROOT, 'agent-pack'), resolve(root, 'agent-pack'), 'dir');
  } catch { /* already exists */ }
  return root;
}

function writeLocalConfig(root: string, config: Record<string, unknown>) {
  const path = resolve(root, 'tools', 'node-t3d-metadata', 'local.config.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function llmConfigured(root: string) {
  writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test-model', apiKey: 'sk-sess' } });
}

/** Provider that records the messages of every stream() call and echoes scripted turns. */
class RecordingProvider implements Provider {
  requests: ChatRequest[] = [];
  constructor(private readonly turns: StreamEvent[][]) {}
  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(req);
    const turn = this.turns[this.requests.length - 1] ?? [
      { type: 'text_delta', text: '好的。' },
      { type: 'done', stopReason: 'end' },
    ];
    for (const ev of turn) yield ev;
  }
}

async function drainSse(response: Response): Promise<AgentSseEvent[]> {
  const events: AgentSseEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const ev = JSON.parse(line.slice(6)) as AgentSseEvent;
        events.push(ev);
        if (ev.type === 'done') return events;
      } catch { /* skip */ }
    }
  }
  return events;
}

async function chat(port: number, body: Record<string, unknown>): Promise<AgentSseEvent[]> {
  const r = await fetch(`http://localhost:${port}/api/agent/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
  return drainSse(r);
}

// ---------------------------------------------------------------------------
// session-store unit
// ---------------------------------------------------------------------------

describe('session-store', () => {
  it('appendTranscript coalesces consecutive text/thinking events', () => {
    const t: AgentTranscriptEntry[] = [];
    appendTranscript(t, { kind: 'user', text: 'hi' });
    appendTranscript(t, { kind: 'event', event: { type: 'text', text: '你' } });
    appendTranscript(t, { kind: 'event', event: { type: 'text', text: '好' } });
    appendTranscript(t, { kind: 'event', event: { type: 'thinking', text: 'a' } });
    appendTranscript(t, { kind: 'event', event: { type: 'thinking', text: 'b' } });
    appendTranscript(t, { kind: 'event', event: { type: 'text', text: '！' } });
    appendTranscript(t, { kind: 'event', event: { type: 'done' } });

    expect(t).toEqual([
      { kind: 'user', text: 'hi' },
      { kind: 'event', event: { type: 'text', text: '你好' } },
      { kind: 'event', event: { type: 'thinking', text: 'ab' } },
      { kind: 'event', event: { type: 'text', text: '！' } },
      { kind: 'event', event: { type: 'done' } },
    ]);
  });

  it('save/load round-trips and list sorts newest first; bad ids are rejected', async () => {
    const root = makeTmpRoot();
    const store = createSessionStore(resolve(root, 'viewer'));
    const base = {
      ueVersion: '5.7', totalTokens: 12, turnSeq: 1,
      messages: [], transcript: [{ kind: 'user', text: 'q' } as AgentTranscriptEntry],
    };
    await store.save({ ...base, id: 'older', title: 'A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
    await store.save({ ...base, id: 'newer', title: 'B', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' });

    const loaded = await store.load('older');
    expect(loaded?.title).toBe('A');
    expect(loaded?.transcript).toHaveLength(1);

    const metas = await store.list();
    expect(metas.map(m => m.id)).toEqual(['newer', 'older']);
    expect(metas[0].turns).toBe(1);

    // Traversal-shaped ids never hit the filesystem.
    expect(await store.load('../../etc/passwd')).toBeNull();
    await expect(store.save({ ...base, id: '../evil', title: '', createdAt: '', updatedAt: '' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Endpoint CRUD
// ---------------------------------------------------------------------------

describe('/api/agent/sessions CRUD', () => {
  it('create → list → detail → delete lifecycle', async () => {
    const root = makeTmpRoot();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    try {
      const created = await fetch(`http://localhost:${server.port}/api/agent/sessions`, { method: 'POST' });
      expect(created.status).toBe(200);
      const { id } = await created.json() as AgentSessionCreateResponse;
      expect(id).toMatch(/^session-/);

      const list = await (await fetch(`http://localhost:${server.port}/api/agent/sessions`)).json() as AgentSessionsListResponse;
      expect(list.sessions.map(s => s.id)).toContain(id);

      const detail = await (await fetch(`http://localhost:${server.port}/api/agent/sessions/${id}`)).json() as AgentSessionDetail;
      expect(detail.id).toBe(id);
      expect(detail.transcript).toEqual([]);

      const del = await fetch(`http://localhost:${server.port}/api/agent/sessions/${id}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      const after = await (await fetch(`http://localhost:${server.port}/api/agent/sessions`)).json() as AgentSessionsListResponse;
      expect(after.sessions.map(s => s.id)).not.toContain(id);
      const gone = await fetch(`http://localhost:${server.port}/api/agent/sessions/${id}`);
      expect(gone.status).toBe(404);
    } finally {
      await server.close();
    }
  }, 10000);

  it('cross-origin create/delete are rejected with 403', async () => {
    const root = makeTmpRoot();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    try {
      const evil = { origin: 'http://evil.example.com', host: `localhost:${server.port}` };
      const c = await fetch(`http://localhost:${server.port}/api/agent/sessions`, { method: 'POST', headers: evil });
      expect(c.status).toBe(403);
      const d = await fetch(`http://localhost:${server.port}/api/agent/sessions/session-x`, { method: 'DELETE', headers: evil });
      expect(d.status).toBe(403);
    } finally {
      await server.close();
    }
  }, 5000);
});

// ---------------------------------------------------------------------------
// Explicit sessionId binding — THE inheritance-bug regression
// ---------------------------------------------------------------------------

describe('chat sessionId binding', () => {
  it('two sessions never share history (new session does not inherit memory)', async () => {
    const root = makeTmpRoot();
    llmConfigured(root);
    const provider = new RecordingProvider([]);
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: () => provider });
    try {
      const mk = async () =>
        ((await (await fetch(`http://localhost:${server.port}/api/agent/sessions`, { method: 'POST' })).json()) as AgentSessionCreateResponse).id;

      const s1 = await mk();
      await chat(server.port, { text: '會話一的秘密', sessionId: s1 });

      const s2 = await mk();
      await chat(server.port, { text: '你還記得什麼？', sessionId: s2 });

      // The second session's request must contain ONLY its own message.
      const req2 = provider.requests[1];
      const flat = JSON.stringify(req2.messages);
      expect(flat).toContain('你還記得什麼？');
      expect(flat).not.toContain('會話一的秘密');

      // Returning to session 1 restores its history.
      await chat(server.port, { text: '繼續', sessionId: s1 });
      const req3 = provider.requests[2];
      expect(JSON.stringify(req3.messages)).toContain('會話一的秘密');
    } finally {
      await server.close();
    }
  }, 15000);

  it('chat with an unknown sessionId returns 404 and releases the single-flight lock', async () => {
    const root = makeTmpRoot();
    llmConfigured(root);
    const provider = new RecordingProvider([]);
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: () => provider });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/agent/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi', sessionId: 'session-does-not-exist' }),
      });
      expect(r.status).toBe(404);
      // Lock must be released — a valid follow-up chat succeeds.
      const events = await chat(server.port, { text: 'hi again' });
      expect(events.at(-1)?.type).toBe('done');
    } finally {
      await server.close();
    }
  }, 10000);
});

// ---------------------------------------------------------------------------
// Persistence: transcript content + survival across server restart
// ---------------------------------------------------------------------------

describe('session persistence', () => {
  const VALID_GRAPH = {
    schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'persist_me',
    nodes: [
      { id: 'c', type: 'ScalarParameter', params: { ParameterName: 'X', DefaultValue: 1 } },
      { id: 'OUT', type: 'MaterialOutput' },
    ],
    connections: [{ from: 'c:Value', to: 'OUT:Roughness' }],
  };

  it('persists a replayable transcript including tool events and coalesced text', async () => {
    const root = makeTmpRoot();
    llmConfigured(root);
    const provider = new RecordingProvider([
      [
        { type: 'tool_use', id: 'w1', name: 'write_graph', input: { path: 'p/persist.matgraph.json', graph: VALID_GRAPH } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: '建立' },
        { type: 'text_delta', text: '完成！' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: () => provider });
    try {
      const { id } = await (await fetch(`http://localhost:${server.port}/api/agent/sessions`, { method: 'POST' })).json() as AgentSessionCreateResponse;
      await chat(server.port, { text: '做一個材質', sessionId: id });

      // The on-disk file exists and the detail endpoint replays it.
      const files = await readdir(resolve(root, 'viewer', '.agent-sessions'));
      expect(files).toContain(`${id}.json`);

      const detail = await (await fetch(`http://localhost:${server.port}/api/agent/sessions/${id}`)).json() as AgentSessionDetail;
      expect(detail.title).toBe('做一個材質');
      const kinds = detail.transcript.map(e => (e.kind === 'user' ? 'user' : e.event.type));
      expect(kinds[0]).toBe('user');
      expect(kinds).toContain('tool_start');
      expect(kinds).toContain('tool_end');
      expect(kinds).toContain('graph_written');
      // Coalescing: the two text deltas arrive as ONE text entry.
      const textEntries = detail.transcript.filter(e => e.kind === 'event' && e.event.type === 'text');
      expect(textEntries).toHaveLength(1);
      expect((textEntries[0] as { event: { text: string } }).event.text).toBe('建立完成！');

      // The raw file must not leak the api key (it stores history, not config).
      const raw = await readFile(resolve(root, 'viewer', '.agent-sessions', `${id}.json`), 'utf-8');
      expect(raw).not.toContain('sk-sess');
    } finally {
      await server.close();
    }
  }, 15000);

  it('a session survives a server restart: list, replay, and continue', async () => {
    const root = makeTmpRoot();
    llmConfigured(root);

    // Server #1: create + one turn.
    const p1 = new RecordingProvider([]);
    const server1 = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: () => p1 });
    let id: string;
    try {
      ({ id } = await (await fetch(`http://localhost:${server1.port}/api/agent/sessions`, { method: 'POST' })).json() as AgentSessionCreateResponse);
      await chat(server1.port, { text: '重啟前的訊息', sessionId: id });
    } finally {
      await server1.close();
    }

    // Server #2 over the same root: the session is listed, replayable, and
    // continuing it feeds the OLD history back to the provider.
    const p2 = new RecordingProvider([]);
    const server2 = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: () => p2 });
    try {
      const list = await (await fetch(`http://localhost:${server2.port}/api/agent/sessions`)).json() as AgentSessionsListResponse;
      expect(list.sessions.map(s => s.id)).toContain(id);

      const detail = await (await fetch(`http://localhost:${server2.port}/api/agent/sessions/${id}`)).json() as AgentSessionDetail;
      expect(detail.transcript.some(e => e.kind === 'user' && e.text === '重啟前的訊息')).toBe(true);

      await chat(server2.port, { text: '重啟後繼續', sessionId: id });
      expect(JSON.stringify(p2.requests[0].messages)).toContain('重啟前的訊息');
    } finally {
      await server2.close();
    }
  }, 15000);

  it('undo binds to the session named in the body', async () => {
    const root = makeTmpRoot();
    llmConfigured(root);
    const graphAbs = resolve(root, 'graphs', 'p', 'undo_sess.matgraph.json');
    const provider = new RecordingProvider([
      [
        { type: 'tool_use', id: 'w1', name: 'write_graph', input: { path: 'p/undo_sess.matgraph.json', graph: VALID_GRAPH } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text_delta', text: '好了。' }, { type: 'done', stopReason: 'end' }],
    ]);
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: () => provider });
    try {
      const { id } = await (await fetch(`http://localhost:${server.port}/api/agent/sessions`, { method: 'POST' })).json() as AgentSessionCreateResponse;
      await chat(server.port, { text: '寫圖', sessionId: id });
      expect(existsSync(graphAbs)).toBe(true);

      const undoR = await fetch(`http://localhost:${server.port}/api/agent/undo`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: id }),
      });
      const undoBody = await undoR.json() as { ok: boolean };
      expect(undoBody.ok).toBe(true);
      // Pre-image was "absent" → undo deletes the file.
      expect(existsSync(graphAbs)).toBe(false);
    } finally {
      await server.close();
    }
  }, 15000);
});

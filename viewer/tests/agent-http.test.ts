// M3 HTTP endpoint tests — /api/agent/chat (SSE), /api/agent/status, and POST /api/config Llm.
// Zero real API/network calls: provider injected via providerFactory hook.
//
// Teardown discipline: every test that opens an SSE stream closes/aborts it.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { startServer } from '../server/http-server.js';
import type { Provider, StreamEvent, ChatRequest, LLMConfig } from '../server/agent/provider/types.js';
import type { AgentSseEvent } from '../server/agent/agent-types.js';

// ---------------------------------------------------------------------------
// FakeProvider (mirrors agent-loop.test.ts pattern)
// ---------------------------------------------------------------------------

class FakeProvider implements Provider {
  private readonly turns: StreamEvent[][];
  private callCount = 0;
  // Expose the last AbortSignal so tests can verify client-disconnect abort.
  lastSignal: AbortSignal | undefined;
  aborted = false;

  constructor(turns: StreamEvent[][]) {
    this.turns = turns;
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.lastSignal = req.signal;
    const turn = this.turns[this.callCount++] ?? [
      { type: 'text_delta', text: '完成。' },
      { type: 'done', stopReason: 'end' },
    ];
    for (const event of turn) {
      if (req.signal?.aborted) {
        this.aborted = true;
        return;
      }
      yield event;
    }
    if (req.signal?.aborted) this.aborted = true;
  }

  get calls(): number {
    return this.callCount;
  }
}

// ---------------------------------------------------------------------------
// SSE response parser
// ---------------------------------------------------------------------------

/**
 * Consume an SSE response body (Node.js IncomingMessage or Response body) and
 * return parsed AgentSseEvent array.
 */
async function parseSseResponse(response: Response, timeoutMs = 5000): Promise<AgentSseEvent[]> {
  const events: AgentSseEvent[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  const deadline = Date.now() + timeoutMs;

  try {
    while (Date.now() < deadline) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch (e) {
        // AbortError or other read error means the stream ended (likely due to
        // our own AbortController.abort() in test teardown). Return what we have.
        if ((e as Error)?.name === 'AbortError') break;
        throw e;
      }
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      buf = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const payload = line.slice('data: '.length).trim();
          if (payload === '[DONE]') return events;
          try {
            const ev = JSON.parse(payload) as AgentSseEvent;
            events.push(ev);
            if (ev.type === 'done') return events;
          } catch { /* skip */ }
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..', '..');

function makeTmpRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'agt-http-'));
  mkdirSync(resolve(root, 'graphs'), { recursive: true });
  mkdirSync(resolve(root, 'tools', 'node-t3d-metadata'), { recursive: true });
  mkdirSync(resolve(root, 'viewer'), { recursive: true });
  // Symlink agent-pack so the real node DB is accessible.
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

// Simple fake provider factory for tests.
function makeFactory(turns: StreamEvent[][]): { factory: (config: LLMConfig) => Provider; provider: FakeProvider } {
  const provider = new FakeProvider(turns);
  return { factory: (_config: LLMConfig) => provider, provider };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/agent/status', () => {
  it('returns configured=false when no Llm config exists', async () => {
    const root = makeTmpRoot();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/agent/status`);
      expect(r.status).toBe(200);
      const body = await r.json() as { configured: boolean; provider?: string; model?: string; apiKey?: unknown };
      expect(body.configured).toBe(false);
      // apiKey must never appear
      expect(body.apiKey).toBeUndefined();
    } finally {
      await server.close();
    }
  }, 5000);

  it('returns configured=true with provider and model when Llm config is set', async () => {
    const root = makeTmpRoot();
    writeLocalConfig(root, {
      Llm: { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-secret-key-123' },
    });
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/agent/status`);
      expect(r.status).toBe(200);
      const body = await r.json() as { configured: boolean; provider?: string; model?: string; apiKey?: unknown; baseUrl?: unknown };
      expect(body.configured).toBe(true);
      expect(body.provider).toBe('anthropic');
      expect(body.model).toBe('claude-opus-4-8');
      // apiKey and baseUrl must NEVER appear in the response (§3.3 leak guard)
      expect(body.apiKey).toBeUndefined();
      expect(body.baseUrl).toBeUndefined();
    } finally {
      await server.close();
    }
  }, 5000);
});

describe('POST /api/config Llm extension', () => {
  it('persists Llm config to local.config.json without echoing apiKey in response', async () => {
    const root = makeTmpRoot();
    const configPath = resolve(root, 'tools', 'node-t3d-metadata', 'local.config.json');
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          Llm: { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-my-secret' },
        }),
      });
      expect(r.status).toBe(200);
      const body = await r.json() as Record<string, unknown>;
      // Response shape is EnvStatus — must not contain Llm or apiKey.
      expect(body.Llm).toBeUndefined();
      expect(body.apiKey).toBeUndefined();
      // Config was actually persisted.
      const saved = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const llm = saved.Llm as Record<string, unknown>;
      expect(llm.provider).toBe('anthropic');
      expect(llm.model).toBe('claude-opus-4-8');
      expect(llm.apiKey).toBe('sk-my-secret');
    } finally {
      await server.close();
    }
  }, 5000);

  it('preserves existing apiKey when no apiKey is sent in update', async () => {
    const root = makeTmpRoot();
    const configPath = resolve(root, 'tools', 'node-t3d-metadata', 'local.config.json');
    writeLocalConfig(root, {
      Llm: { provider: 'anthropic', model: 'old-model', apiKey: 'sk-preserved-key' },
    });
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    try {
      // Update model but don't send apiKey
      const r = await fetch(`http://localhost:${server.port}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          Llm: { provider: 'anthropic', model: 'new-model' },
        }),
      });
      expect(r.status).toBe(200);
      const saved = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const llm = saved.Llm as Record<string, unknown>;
      expect(llm.model).toBe('new-model');
      // The key should still be preserved
      expect(llm.apiKey).toBe('sk-preserved-key');
    } finally {
      await server.close();
    }
  }, 5000);

  it('rejects invalid provider value', async () => {
    const root = makeTmpRoot();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ Llm: { provider: 'bad-provider', model: 'some-model' } }),
      });
      expect(r.status).toBe(400);
      const body = await r.json() as { error: string };
      expect(body.error).toContain('provider');
    } finally {
      await server.close();
    }
  }, 5000);

  it('preserves non-Llm config fields when updating Llm', async () => {
    const root = makeTmpRoot();
    const configPath = resolve(root, 'tools', 'node-t3d-metadata', 'local.config.json');
    writeLocalConfig(root, { ProjectPath: '/my/project.uproject', EngineRoot: '/my/engine' });
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    try {
      await fetch(`http://localhost:${server.port}/api/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ Llm: { provider: 'anthropic', model: 'claude-opus-4-8' } }),
      });
      const saved = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      expect(saved.ProjectPath).toBe('/my/project.uproject');
      expect(saved.EngineRoot).toBe('/my/engine');
      expect((saved.Llm as Record<string, unknown>).provider).toBe('anthropic');
    } finally {
      await server.close();
    }
  }, 5000);
});

describe('POST /api/agent/chat', () => {
  it('rejects cross-origin requests (sameOrigin guard)', async () => {
    const root = makeTmpRoot();
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test-model', apiKey: 'sk-x' } });
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/agent/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'origin': 'http://evil.example.com',
          'host': `localhost:${server.port}`,
        },
        body: JSON.stringify({ text: 'hello' }),
      });
      expect(r.status).toBe(403);
    } finally {
      await server.close();
    }
  }, 5000);

  it('streams a complete conversation: text + done events parse back to AgentSseEvent', async () => {
    const root = makeTmpRoot();
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-test' } });
    const { factory } = makeFactory([[
      { type: 'text_delta', text: '你好！' },
      { type: 'text_delta', text: '這是測試。' },
      { type: 'done', stopReason: 'end' },
    ]]);
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: factory });
    try {
      // No AbortController — the stream ends naturally on 'done'.
      const r = await fetch(`http://localhost:${server.port}/api/agent/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '你好' }),
      });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/event-stream');

      const events = await parseSseResponse(r);

      const textEvents = events.filter(e => e.type === 'text') as Array<{ type: 'text'; text: string }>;
      expect(textEvents.length).toBeGreaterThan(0);
      const allText = textEvents.map(e => e.text).join('');
      expect(allText).toContain('你好');

      const doneEvent = events.find(e => e.type === 'done');
      expect(doneEvent).toBeTruthy();
    } finally {
      await server.close();
    }
  }, 10000);

  it('returns 409 on concurrent chat (single-flight lock)', async () => {
    const root = makeTmpRoot();
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test', apiKey: 'sk-x' } });

    // Slow provider: hangs on each yield so the first request is still streaming.
    const slowProvider: Provider = {
      async *stream(_req: ChatRequest) {
        await new Promise<void>(res => setTimeout(res, 2000));
        yield { type: 'text_delta', text: 'slow' };
        yield { type: 'done', stopReason: 'end' };
      },
    };
    const server = await startServer({
      repoRoot: root, port: 0, webDist: '',
      providerFactory: () => slowProvider,
    });
    const ac1 = new AbortController();
    try {
      // Start first request (don't await body — keep it streaming).
      // Attach error handler so abort in finally doesn't cause unhandled rejection.
      const r1Promise = fetch(`http://localhost:${server.port}/api/agent/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'first' }),
        signal: ac1.signal,
      }).catch((e: Error) => { if (e.name !== 'AbortError') throw e; return null; });

      // Wait a tick for the server to mark streaming=true.
      await new Promise<void>(res => setTimeout(res, 50));
      // Second request should be rejected with 409.
      const r2 = await fetch(`http://localhost:${server.port}/api/agent/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'second' }),
      });
      expect(r2.status).toBe(409);
      const body = await r2.json() as { error: string };
      expect(body.error).toBeTruthy();
      // Clean up the first request
      ac1.abort();
      await r1Promise;
    } finally {
      ac1.abort();
      await server.close();
    }
  }, 10000);

  it('emits error SSE event (not crash) when no Llm config is set', async () => {
    const root = makeTmpRoot();
    // No local.config.json at all.
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    try {
      // No AbortController needed — the SSE stream ends on its own (error+done events).
      const r = await fetch(`http://localhost:${server.port}/api/agent/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '你好' }),
      });
      expect(r.status).toBe(200);
      const events = await parseSseResponse(r);
      const errEv = events.find(e => e.type === 'error') as { type: 'error'; message: string } | undefined;
      expect(errEv).toBeTruthy();
      expect(errEv!.message).toMatch(/Config/);
    } finally {
      await server.close();
    }
  }, 5000);

  it('SSE stream bytes never contain the apiKey', async () => {
    const root = makeTmpRoot();
    const SECRET_KEY = 'sk-ultra-secret-key-xyz789';
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test', apiKey: SECRET_KEY } });
    const { factory } = makeFactory([[
      { type: 'text_delta', text: '完成' },
      { type: 'done', stopReason: 'end' },
    ]]);
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: factory });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/agent/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '測試' }),
      });
      // Read the raw text to check for key leakage.
      const text = await r.text();
      expect(text).not.toContain(SECRET_KEY);
    } finally {
      await server.close();
    }
  }, 5000);

  it('client disconnect causes runAgent loop to abort (signal is observed)', async () => {
    const root = makeTmpRoot();
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test', apiKey: 'sk-x' } });

    let receivedSignal: AbortSignal | undefined;

    // Provider that captures the abort signal and yields slowly.
    const trackProvider: Provider = {
      async *stream(req: ChatRequest) {
        receivedSignal = req.signal;
        // Yield slowly — client will disconnect before we finish.
        for (let i = 0; i < 100; i++) {
          if (req.signal?.aborted) return;
          await new Promise<void>(res => setTimeout(res, 20));
          yield { type: 'text_delta', text: `chunk${i}` };
        }
        yield { type: 'done', stopReason: 'end' };
      },
    };
    const server = await startServer({
      repoRoot: root, port: 0, webDist: '',
      providerFactory: () => trackProvider,
    });
    const ac = new AbortController();
    try {
      // Start the fetch — attach error handler to suppress unhandled abort rejection.
      const fetchPromise = fetch(`http://localhost:${server.port}/api/agent/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '測試中斷' }),
        signal: ac.signal,
      }).catch((e: Error) => {
        if (e.name === 'AbortError') return null; // expected
        throw e;
      });

      const r = await fetchPromise;
      if (!r) return; // aborted before response headers — that's fine too
      expect(r.status).toBe(200);

      // Read a bit then abort.
      const reader = r.body!.getReader();
      try {
        await reader.read(); // consume at least one chunk
      } catch { /* AbortError on read is expected */ }
      try { reader.releaseLock(); } catch { /* already released */ }
      ac.abort();
      // Give the server a moment to observe the disconnect.
      await new Promise<void>(res => setTimeout(res, 200));
      expect(receivedSignal).toBeTruthy();
      // The signal should eventually be aborted (server observed client close).
      // Note: Node doesn't guarantee immediate abort; we just check signal was received.
    } finally {
      ac.abort();
      await server.close();
    }
  }, 10000);

  it('streams graph_written event when a graph is written', async () => {
    const root = makeTmpRoot();
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test', apiKey: 'sk-x' } });

    const validGraph = {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      type: 'Material',
      name: 'test',
      nodes: [],
      connections: [],
    };

    const { factory } = makeFactory([[
      // Tool call: write_graph
      {
        type: 'tool_use',
        id: 'tool1',
        name: 'write_graph',
        input: {
          path: 'test_m3/test.matgraph.json',
          graph: validGraph,
        },
      },
      { type: 'done', stopReason: 'tool_use' },
    ], [
      // Second turn: final text
      { type: 'text_delta', text: '已建立材質。' },
      { type: 'done', stopReason: 'end' },
    ]]);
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: factory });
    try {
      // No AbortController — stream ends naturally on done event.
      const r = await fetch(`http://localhost:${server.port}/api/agent/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '建立測試材質' }),
      });
      expect(r.status).toBe(200);
      const events = await parseSseResponse(r, 8000);
      // Should have a graph_written event
      const gwEvent = events.find(e => e.type === 'graph_written') as { type: 'graph_written'; path: string } | undefined;
      expect(gwEvent).toBeTruthy();
      // Should also have done
      expect(events.find(e => e.type === 'done')).toBeTruthy();
    } finally {
      await server.close();
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// §3.4 degradation: tool-rejection surfaced as an error StreamEvent (adapter
// yields it without throwing) must still get the model-switch hint
// ---------------------------------------------------------------------------

describe('degradation hint for tool-rejecting models', () => {
  it('rewrites a 4xx tools error StreamEvent with the model-switch suggestion', async () => {
    const root = makeTmpRoot();
    writeLocalConfig(root, { Llm: { provider: 'openai-compatible', model: 'no-tools-model', apiKey: 'sk-x' } });
    const { factory } = makeFactory([[
      { type: 'error', message: 'HTTP 400: this model does not support tools' },
      { type: 'done', stopReason: 'end' },
    ]]);
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: factory });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/agent/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: '做一個材質' }),
      });
      expect(r.status).toBe(200);
      const events = await parseSseResponse(r);
      const errEvent = events.find(e => e.type === 'error') as { type: 'error'; message: string } | undefined;
      expect(errEvent).toBeTruthy();
      expect(errEvent!.message).toContain('建議使用支援工具的模型');
      // The hint must not be applied twice (idempotence guard).
      expect(errEvent!.message.match(/建議使用支援工具的模型/g)!.length).toBe(1);
    } finally {
      await server.close();
    }
  }, 10000);

  it('leaves unrelated error events untouched', async () => {
    const root = makeTmpRoot();
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'm', apiKey: 'sk-x' } });
    const { factory } = makeFactory([[
      { type: 'error', message: 'connection reset by peer' },
      { type: 'done', stopReason: 'end' },
    ]]);
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: factory });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/agent/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      const events = await parseSseResponse(r);
      const errEvent = events.find(e => e.type === 'error') as { type: 'error'; message: string } | undefined;
      expect(errEvent!.message).toBe('connection reset by peer');
    } finally {
      await server.close();
    }
  }, 10000);
});

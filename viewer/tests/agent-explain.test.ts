// M5 server-side tests: explain.ts unit tests + POST /api/agent/explain endpoint.
//
// Zero real API calls — FakeProvider injected throughout.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { explainNode, buildGraphContext, RESERVED_NODE_DESCRIPTIONS } from '../server/agent/explain.js';
import { startServer } from '../server/http-server.js';
import type { Provider, StreamEvent, ChatRequest, LLMConfig } from '../server/agent/provider/types.js';
import type { AgentExplainResponse } from '../server/agent/agent-types.js';

// ---------------------------------------------------------------------------
// FakeProvider
// ---------------------------------------------------------------------------

class FakeProvider implements Provider {
  private readonly turns: StreamEvent[][];
  private callCount = 0;
  lastRequest: ChatRequest | undefined;

  constructor(turns: StreamEvent[][]) {
    this.turns = turns;
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.lastRequest = req;
    const turn = this.turns[this.callCount++] ?? [
      { type: 'text_delta', text: '節點解說。' },
      { type: 'done', stopReason: 'end' },
    ];
    for (const event of turn) {
      if (req.signal?.aborted) return;
      yield event;
    }
  }

  get calls(): number { return this.callCount; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..', '..');

function makeTmpRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'exp-http-'));
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

function makeFactory(turns: StreamEvent[][]): { factory: (cfg: LLMConfig) => Provider; provider: FakeProvider } {
  const provider = new FakeProvider(turns);
  return { factory: (_: LLMConfig) => provider, provider };
}

// ---------------------------------------------------------------------------
// explainNode unit tests
// ---------------------------------------------------------------------------

describe('explainNode()', () => {
  it('collects text_delta events into a string', async () => {
    const provider = new FakeProvider([[
      { type: 'text_delta', text: '這是 ' },
      { type: 'text_delta', text: 'Multiply 節點' },
      { type: 'done', stopReason: 'end' },
    ]]);
    const text = await explainNode(provider, 'test-model', {
      nodeType: 'Multiply',
      ueVersion: '5.7',
      dbEntry: { description: '乘法節點', inputs: [], outputs: [] },
    });
    expect(text).toBe('這是 Multiply 節點');
  });

  it('throws when an error event is received', async () => {
    const provider = new FakeProvider([[
      { type: 'error', message: '模型不可用' },
      { type: 'done', stopReason: 'end' },
    ]]);
    await expect(
      explainNode(provider, 'test-model', { nodeType: 'Multiply', ueVersion: '5.7' })
    ).rejects.toThrow('模型不可用');
  });

  it('sends NO tools in the ChatRequest (assert req.tools is undefined/empty)', async () => {
    const provider = new FakeProvider([[
      { type: 'text_delta', text: '解說' },
      { type: 'done', stopReason: 'end' },
    ]]);
    await explainNode(provider, 'test-model', { nodeType: 'Lerp', ueVersion: '5.7' });
    const req = provider.lastRequest!;
    expect(req.tools === undefined || (Array.isArray(req.tools) && req.tools.length === 0)).toBe(true);
  });

  it('passes maxTokens to the ChatRequest', async () => {
    const provider = new FakeProvider([[
      { type: 'text_delta', text: '解說' },
      { type: 'done', stopReason: 'end' },
    ]]);
    await explainNode(provider, 'test-model', { nodeType: 'Lerp', ueVersion: '5.7' }, 512);
    const req = provider.lastRequest!;
    expect(req.maxTokens).toBe(512);
  });

  it('uses default maxTokens when not provided', async () => {
    const provider = new FakeProvider([[
      { type: 'text_delta', text: '解說' },
      { type: 'done', stopReason: 'end' },
    ]]);
    await explainNode(provider, 'test-model', { nodeType: 'Lerp', ueVersion: '5.7' });
    const req = provider.lastRequest!;
    expect(req.maxTokens).toBeDefined();
    expect(typeof req.maxTokens).toBe('number');
    expect(req.maxTokens! > 0).toBe(true);
  });

  it('includes graphContext in the user message when provided', async () => {
    const provider = new FakeProvider([[
      { type: 'text_delta', text: '解說' },
      { type: 'done', stopReason: 'end' },
    ]]);
    await explainNode(provider, 'test-model', {
      nodeType: 'Lerp',
      ueVersion: '5.7',
      graphContext: '接收 A, B；輸出到 MaterialOutput',
    });
    const req = provider.lastRequest!;
    const userContent = req.messages[0].content;
    const text = userContent.find(b => b.type === 'text') as { type: 'text'; text: string };
    expect(text.text).toContain('接收 A, B；輸出到 MaterialOutput');
  });

  it('works without graphContext (no mention of context in user message)', async () => {
    const provider = new FakeProvider([[
      { type: 'text_delta', text: '解說' },
      { type: 'done', stopReason: 'end' },
    ]]);
    await explainNode(provider, 'test-model', { nodeType: 'Lerp', ueVersion: '5.7' });
    const req = provider.lastRequest!;
    const userContent = req.messages[0].content;
    const text = userContent.find(b => b.type === 'text') as { type: 'text'; text: string };
    expect(text.text).not.toContain('連線狀況');
  });

  it("default language is 繁體中文 (zh system prompt + zh user suffix)", async () => {
    const provider = new FakeProvider([[
      { type: 'text_delta', text: '解說' },
      { type: 'done', stopReason: 'end' },
    ]]);
    await explainNode(provider, 'test-model', { nodeType: 'Lerp', ueVersion: '5.7' });
    const req = provider.lastRequest!;
    expect(req.system).toContain('繁體中文');
    const text = req.messages[0].content.find(b => b.type === 'text') as { type: 'text'; text: string };
    expect(text.text).toContain('請用繁體中文白話解說這個節點。');
  });

  it("language: 'en' uses an English system prompt and English user instruction", async () => {
    const provider = new FakeProvider([[
      { type: 'text_delta', text: 'explanation' },
      { type: 'done', stopReason: 'end' },
    ]]);
    await explainNode(provider, 'test-model', { nodeType: 'Lerp', ueVersion: '5.7', language: 'en' });
    const req = provider.lastRequest!;
    // English persona, not the zh one.
    expect(req.system).toMatch(/English/i);
    expect(req.system).not.toContain('繁體中文');
    // The zh suffix instruction is dropped in favour of an English one.
    const text = req.messages[0].content.find(b => b.type === 'text') as { type: 'text'; text: string };
    expect(text.text).not.toContain('請用繁體中文白話解說這個節點。');
    expect(text.text).toMatch(/English/i);
  });
});

// ---------------------------------------------------------------------------
// RESERVED_NODE_DESCRIPTIONS
// ---------------------------------------------------------------------------

describe('RESERVED_NODE_DESCRIPTIONS', () => {
  it('contains all four reserved types', () => {
    expect('MaterialOutput' in RESERVED_NODE_DESCRIPTIONS).toBe(true);
    expect('FunctionInput' in RESERVED_NODE_DESCRIPTIONS).toBe(true);
    expect('FunctionOutput' in RESERVED_NODE_DESCRIPTIONS).toBe(true);
    expect('MaterialFunctionCall' in RESERVED_NODE_DESCRIPTIONS).toBe(true);
  });

  it('descriptions are non-empty zh-TW strings', () => {
    for (const [, desc] of Object.entries(RESERVED_NODE_DESCRIPTIONS)) {
      expect(typeof desc).toBe('string');
      expect(desc.length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------------------
// buildGraphContext
// ---------------------------------------------------------------------------

describe('buildGraphContext()', () => {
  it('returns a connections summary for a node with connections', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'gc-'));
    const graphsRoot = resolve(root, 'graphs');
    mkdirSync(graphsRoot, { recursive: true });
    const graphPath = 'test/graph.matgraph.json';
    const graphFile = resolve(graphsRoot, graphPath);
    mkdirSync(dirname(graphFile), { recursive: true });
    writeFileSync(graphFile, JSON.stringify({
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'test',
      nodes: [{ id: 'n1', type: 'Multiply' }, { id: 'n2', type: 'MaterialOutput' }],
      connections: [{ from: 'n1:Output', to: 'n2:BaseColor' }],
    }), 'utf-8');

    const ctx = await buildGraphContext(graphsRoot, graphPath, 'n1');
    expect(ctx).toBeDefined();
    expect(ctx).toContain('n2');
  });

  it('returns undefined for path outside graphsRoot (traversal guard)', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'gc-'));
    const graphsRoot = resolve(root, 'graphs');
    mkdirSync(graphsRoot, { recursive: true });
    // Path with ../ escape
    const ctx = await buildGraphContext(graphsRoot, '../etc/passwd', 'n1');
    expect(ctx).toBeUndefined();
  });

  it('returns undefined for non-.matgraph.json extension', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'gc-'));
    const graphsRoot = resolve(root, 'graphs');
    mkdirSync(graphsRoot, { recursive: true });
    const ctx = await buildGraphContext(graphsRoot, 'test/graph.json', 'n1');
    expect(ctx).toBeUndefined();
  });

  it('returns undefined when graph file does not exist', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'gc-'));
    const graphsRoot = resolve(root, 'graphs');
    mkdirSync(graphsRoot, { recursive: true });
    const ctx = await buildGraphContext(graphsRoot, 'nonexistent.matgraph.json', 'n1');
    expect(ctx).toBeUndefined();
  });

  it('returns "沒有連線" message for a node with no connections', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'gc-'));
    const graphsRoot = resolve(root, 'graphs');
    mkdirSync(graphsRoot, { recursive: true });
    const graphPath = 'test/graph.matgraph.json';
    const graphFile = resolve(graphsRoot, graphPath);
    mkdirSync(dirname(graphFile), { recursive: true });
    writeFileSync(graphFile, JSON.stringify({
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'test',
      nodes: [{ id: 'n1', type: 'Multiply' }],
      connections: [],
    }), 'utf-8');
    const ctx = await buildGraphContext(graphsRoot, graphPath, 'n1');
    expect(ctx).toContain('沒有連線');
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent/explain HTTP endpoint tests
// ---------------------------------------------------------------------------

describe('POST /api/agent/explain', () => {
  it('sameOrigin guard: cross-origin request is rejected with 403', async () => {
    const root = makeTmpRoot();
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test', apiKey: 'sk-x' } });
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/agent/explain`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'http://evil.example.com',
          host: `localhost:${server.port}`,
        },
        body: JSON.stringify({ nodeType: 'Multiply' }),
      });
      expect(r.status).toBe(403);
    } finally {
      await server.close();
    }
  }, 5000);

  it('returns {ok:false} when LLM is not configured', async () => {
    const root = makeTmpRoot();
    // No local.config.json → no LLM config.
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/agent/explain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeType: 'Multiply' }),
      });
      expect(r.status).toBe(200);
      const body = await r.json() as AgentExplainResponse;
      expect(body.ok).toBe(false);
      if (!body.ok) {
        expect(body.error).toBeTruthy();
        expect(body.error).toContain('Config');
      }
    } finally {
      await server.close();
    }
  }, 5000);

  it('returns {ok:false} for unknown nodeType', async () => {
    const root = makeTmpRoot();
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test', apiKey: 'sk-x' } });
    const { factory } = makeFactory([[
      { type: 'text_delta', text: '解說' },
      { type: 'done', stopReason: 'end' },
    ]]);
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: factory });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/agent/explain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeType: 'CompletelyFakeNodeXYZABC' }),
      });
      expect(r.status).toBe(200);
      const body = await r.json() as AgentExplainResponse;
      expect(body.ok).toBe(false);
      if (!body.ok) {
        expect(body.error).toContain('查無此節點型別');
      }
    } finally {
      await server.close();
    }
  }, 5000);

  it('returns {ok:false} when nodeType is empty string', async () => {
    const root = makeTmpRoot();
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test', apiKey: 'sk-x' } });
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/agent/explain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeType: '' }),
      });
      expect(r.status).toBe(200);
      const body = await r.json() as AgentExplainResponse;
      expect(body.ok).toBe(false);
    } finally {
      await server.close();
    }
  }, 5000);

  it('returns {ok:true, text} for a known node type with FakeProvider', async () => {
    const root = makeTmpRoot();
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test', apiKey: 'sk-x' } });
    const { factory } = makeFactory([[
      { type: 'text_delta', text: 'Multiply 節點乘兩個值。' },
      { type: 'done', stopReason: 'end' },
    ]]);
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: factory });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/agent/explain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeType: 'Multiply', ueVersion: '5.7' }),
      });
      expect(r.status).toBe(200);
      const body = await r.json() as AgentExplainResponse;
      expect(body.ok).toBe(true);
      if (body.ok) {
        expect(body.text).toBe('Multiply 節點乘兩個值。');
      }
    } finally {
      await server.close();
    }
  }, 5000);

  it('works for a reserved node type (MaterialOutput)', async () => {
    const root = makeTmpRoot();
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test', apiKey: 'sk-x' } });
    const { factory } = makeFactory([[
      { type: 'text_delta', text: '這是輸出節點。' },
      { type: 'done', stopReason: 'end' },
    ]]);
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: factory });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/agent/explain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeType: 'MaterialOutput' }),
      });
      expect(r.status).toBe(200);
      const body = await r.json() as AgentExplainResponse;
      expect(body.ok).toBe(true);
      if (body.ok) {
        expect(body.text).toBeTruthy();
      }
    } finally {
      await server.close();
    }
  }, 5000);

  it('apiKey is never present in the response body', async () => {
    const root = makeTmpRoot();
    const SECRET_KEY = 'sk-ultra-secret-m5-key';
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test', apiKey: SECRET_KEY } });
    const { factory } = makeFactory([[
      { type: 'text_delta', text: '解說文字' },
      { type: 'done', stopReason: 'end' },
    ]]);
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: factory });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/agent/explain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeType: 'Multiply' }),
      });
      const rawText = await r.text();
      expect(rawText).not.toContain(SECRET_KEY);
    } finally {
      await server.close();
    }
  }, 5000);

  it('graphPath outside graphs/ degrades to no-context but still returns {ok:true}', async () => {
    const root = makeTmpRoot();
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test', apiKey: 'sk-x' } });
    const { factory } = makeFactory([[
      { type: 'text_delta', text: '解說' },
      { type: 'done', stopReason: 'end' },
    ]]);
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: factory });
    try {
      const r = await fetch(`http://localhost:${server.port}/api/agent/explain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Malicious graphPath with traversal
        body: JSON.stringify({ nodeType: 'Multiply', graphPath: '../../etc/passwd', nodeId: 'n1' }),
      });
      expect(r.status).toBe(200);
      const body = await r.json() as AgentExplainResponse;
      // Should still succeed, just without graph context.
      expect(body.ok).toBe(true);
    } finally {
      await server.close();
    }
  }, 5000);

  it('explain does NOT 409 while a chat is streaming (independence)', async () => {
    const root = makeTmpRoot();
    writeLocalConfig(root, { Llm: { provider: 'anthropic', model: 'test', apiKey: 'sk-x' } });

    // Stall provider for chat: doesn't yield until released.
    let releaseChatStall: (() => void) | undefined;
    const chatProvider: Provider = {
      async *stream(_req: ChatRequest) {
        await new Promise<void>(res => { releaseChatStall = res; setTimeout(res, 8000); });
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'done', stopReason: 'end' };
      },
    };
    // Explain provider: fast.
    const { factory: explainFactory } = makeFactory([[
      { type: 'text_delta', text: '解說獨立' },
      { type: 'done', stopReason: 'end' },
    ]]);

    // We need two separate servers to avoid the single-flight lock.
    // But actually explain is independent — it should NOT be blocked even on
    // the same server. We test this with a split factory.
    let useExplainProvider = false;
    const splitFactory = (_cfg: LLMConfig): Provider => {
      if (useExplainProvider) return explainFactory(_cfg);
      return chatProvider;
    };

    const server = await startServer({ repoRoot: root, port: 0, webDist: '', providerFactory: splitFactory });
    const ac = new AbortController();
    try {
      // Start a slow chat (don't await).
      const chatPromise = fetch(`http://localhost:${server.port}/api/agent/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'slow' }),
        signal: ac.signal,
      }).catch(e => { if ((e as Error).name === 'AbortError') return null; throw e; });

      // Wait for chat to start streaming.
      await new Promise<void>(res => setTimeout(res, 100));

      // Now send explain — should NOT be blocked by the chat single-flight.
      useExplainProvider = true;
      const r = await fetch(`http://localhost:${server.port}/api/agent/explain`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeType: 'Multiply' }),
      });
      // Explain must not return 409.
      expect(r.status).toBe(200);
      const body = await r.json() as AgentExplainResponse;
      expect(body.ok).toBe(true);

      ac.abort();
      releaseChatStall?.();
      await chatPromise;
    } finally {
      ac.abort();
      releaseChatStall?.();
      try { await server.close(); } catch { /* already closed */ }
    }
  }, 15000);
});

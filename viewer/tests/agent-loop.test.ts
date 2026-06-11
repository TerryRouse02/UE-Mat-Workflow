// M2 loop.ts + checkpoint.ts tests — all driven by FakeProvider.
// Zero real network calls.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { runAgent, createSession, MAX_ITERS, TOKEN_CEILING, VIEW_CONTEXT_PREFIX, type AgentLoopSession, type EmitFn, type RunAgentOptions } from '../server/agent/loop.js';
import { createCheckpointStore } from '../server/agent/checkpoint.js';
import type { Provider, StreamEvent, ChatRequest } from '../server/agent/provider/types.js';
import type { ToolContext } from '../server/agent/tools.js';
import type { AgentSseEvent } from '../server/agent/agent-types.js';

// ---------------------------------------------------------------------------
// Repo root (for real agent-pack data + DB lookups)
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..', '..');

// ---------------------------------------------------------------------------
// FakeProvider
// ---------------------------------------------------------------------------

/**
 * A scripted provider that pops a pre-set turn array on each stream() call.
 * Each turn is an array of StreamEvents to yield.  When turns run out, yields
 * a minimal text+done response.
 */
class FakeProvider implements Provider {
  private readonly turns: StreamEvent[][];
  private callCount = 0;

  constructor(turns: StreamEvent[][]) {
    this.turns = turns;
  }

  async *stream(_req: ChatRequest): AsyncGenerator<StreamEvent> {
    const turn = this.turns[this.callCount++] ?? [
      { type: 'text_delta', text: '好的，已完成。' },
      { type: 'done', stopReason: 'end' },
    ];
    for (const event of turn) {
      yield event;
    }
  }

  get calls(): number {
    return this.callCount;
  }
}

// ---------------------------------------------------------------------------
// Collect helper
// ---------------------------------------------------------------------------

async function runAndCollect(
  userText: string,
  session: AgentLoopSession,
  provider: FakeProvider,
  ctx: ToolContext,
  signal?: AbortSignal,
  options?: RunAgentOptions,
): Promise<AgentSseEvent[]> {
  const events: AgentSseEvent[] = [];
  const emit: EmitFn = (e) => events.push(e);
  await runAgent(userText, session, provider, 'fake-model', ctx, emit, signal, options);
  return events;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let ctx: ToolContext;
let session: AgentLoopSession;

const VALID_GRAPH = {
  schemaVersion: '1.0',
  ueVersion: '5.7',
  type: 'Material',
  name: 'glowing_water',
  nodes: [
    { id: 'emit_col', type: 'VectorParameter', params: { ParameterName: 'EmissiveColor', DefaultValue: [0, 0.5, 1, 1] } },
    { id: 'emit_pow', type: 'ScalarParameter', params: { ParameterName: 'EmissivePower', DefaultValue: 3 } },
    { id: 'mul', type: 'Multiply' },
    { id: 'OUT', type: 'MaterialOutput' },
  ],
  connections: [
    { from: 'emit_col:RGB', to: 'mul:A' },
    { from: 'emit_pow:Result', to: 'mul:B' },
    { from: 'mul:Result', to: 'OUT:EmissiveColor' },
  ],
};

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ue-loop-test-'));
  await mkdir(join(tmpDir, 'graphs'), { recursive: true });

  const checkpointStore = createCheckpointStore(join(tmpDir, 'viewer'), 'test-session');

  ctx = {
    repoRoot: REPO_ROOT,
    graphsRoot: join(tmpDir, 'graphs'),
    ueVersion: '5.7',
    workMfIndexPath: join(REPO_ROOT, 'agent-pack', 'workmf-index.json'),
    beforeWrite: async (absPath: string, turnId: string) => {
      await checkpointStore.snapshotFile(turnId || 'turn-0', absPath);
    },
  };

  session = createSession('test-session', '5.7');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// §1  Simple text-only response
// ---------------------------------------------------------------------------

describe('text-only response', () => {
  it('emits text events and done', async () => {
    const provider = new FakeProvider([
      [
        { type: 'text_delta', text: '你好！' },
        { type: 'text_delta', text: '請問要做什麼材質？' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    const events = await runAndCollect('你好', session, provider, ctx);

    const textEvents = events.filter((e) => e.type === 'text');
    expect(textEvents.length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)?.type).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// §2  Tool call → result loop → final text
// ---------------------------------------------------------------------------

describe('single tool call round-trip', () => {
  it('emits tool_start, tool_end, and final done', async () => {
    const provider = new FakeProvider([
      // Turn 1: model calls search_nodes
      [
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'search_nodes',
          input: { query: 'multiply' },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // Turn 2: model gives final text
      [
        { type: 'text_delta', text: '搜尋完成。' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    const events = await runAndCollect('幫我搜尋節點', session, provider, ctx);

    const toolStart = events.find((e) => e.type === 'tool_start');
    expect(toolStart).toBeDefined();
    if (toolStart?.type === 'tool_start') {
      expect(toolStart.name).toBe('search_nodes');
    }

    const toolEnd = events.find((e) => e.type === 'tool_end');
    expect(toolEnd).toBeDefined();
    if (toolEnd?.type === 'tool_end') {
      expect(toolEnd.ok).toBe(true);
    }

    expect(events.at(-1)?.type).toBe('done');
    expect(provider.calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §3  write_graph — valid graph lands on disk, emits diff + graph_written
// ---------------------------------------------------------------------------

describe('write_graph happy path', () => {
  it('writes valid matgraph to disk and emits diff + graph_written', async () => {
    const graphPath = 'proj/glowing_water.matgraph.json';
    const provider = new FakeProvider([
      // Turn 1: model calls write_graph
      [
        {
          type: 'tool_use',
          id: 'call-w1',
          name: 'write_graph',
          input: { path: graphPath, graph: VALID_GRAPH },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // Turn 2: final text
      [
        { type: 'text_delta', text: '發光水材質已建立！' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    const events = await runAndCollect('做一個會發光的水材質', session, provider, ctx);

    // File must exist
    const absPath = join(ctx.graphsRoot, graphPath);
    const raw = await readFile(absPath, 'utf-8');
    const written = JSON.parse(raw);
    expect(written.name).toBe('glowing_water');

    // graph_written event emitted
    const gwEvent = events.find((e) => e.type === 'graph_written');
    expect(gwEvent).toBeDefined();
    if (gwEvent?.type === 'graph_written') {
      expect(gwEvent.path).toBe(graphPath);
    }

    expect(events.at(-1)?.type).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// §4  Self-correction: invalid graph on first try, valid on second
// ---------------------------------------------------------------------------

describe('self-correction on invalid graph', () => {
  it('retries after validation error and eventually writes valid graph', async () => {
    const badGraph = {
      // Missing 'type' field — schema will reject this
      schemaVersion: '1.0',
      ueVersion: '5.7',
      name: 'bad',
      nodes: [],
      connections: [],
    };

    const graphPath = 'proj/corrected.matgraph.json';
    const provider = new FakeProvider([
      // Turn 1: model tries to write a bad graph
      [
        {
          type: 'tool_use',
          id: 'call-bad',
          name: 'write_graph',
          input: { path: graphPath, graph: badGraph },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // Turn 2: model tries with a valid graph (after seeing the error in tool_result)
      [
        {
          type: 'tool_use',
          id: 'call-good',
          name: 'write_graph',
          input: { path: graphPath, graph: VALID_GRAPH },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // Turn 3: final text
      [
        { type: 'text_delta', text: '已修正！' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    const events = await runAndCollect('建立一個材質', session, provider, ctx);

    // First tool_end should be an error
    const toolEnds = events.filter((e) => e.type === 'tool_end');
    expect(toolEnds.length).toBeGreaterThanOrEqual(2);
    const firstEnd = toolEnds[0];
    if (firstEnd?.type === 'tool_end') {
      expect(firstEnd.ok).toBe(false);
    }
    const secondEnd = toolEnds[1];
    if (secondEnd?.type === 'tool_end') {
      expect(secondEnd.ok).toBe(true);
    }

    // File must exist with valid content
    const absPath = join(ctx.graphsRoot, graphPath);
    const raw = await readFile(absPath, 'utf-8');
    const written = JSON.parse(raw);
    expect(written.name).toBe('glowing_water');

    expect(events.at(-1)?.type).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// §5  MAX_ITERS limit
// ---------------------------------------------------------------------------

describe('MAX_ITERS limit', () => {
  it('emits limit(iters) event when hitting the iteration ceiling', async () => {
    // Provide MAX_ITERS+1 turns that all call a tool (model never settles)
    const turns: StreamEvent[][] = Array.from({ length: MAX_ITERS + 1 }, (_, i) => [
      {
        type: 'tool_use',
        id: `call-${i}`,
        name: 'search_nodes',
        input: { query: 'test' },
      },
      { type: 'done', stopReason: 'tool_use' },
    ]);

    const provider = new FakeProvider(turns);
    const events = await runAndCollect('keep searching', session, provider, ctx);

    const limitEvent = events.find((e) => e.type === 'limit');
    expect(limitEvent).toBeDefined();
    if (limitEvent?.type === 'limit') {
      expect(limitEvent.kind).toBe('iters');
    }
    expect(events.at(-1)?.type).toBe('done');
    // Should not exceed MAX_ITERS calls
    expect(provider.calls).toBeLessThanOrEqual(MAX_ITERS);
  });
});

// ---------------------------------------------------------------------------
// §6  TOKEN_CEILING limit
// ---------------------------------------------------------------------------

describe('TOKEN_CEILING limit', () => {
  it('emits limit(cost) event when cumulative tokens exceed ceiling in a text-only turn', async () => {
    // Simulate a usage event that pushes tokens over the ceiling within a single
    // text-only response (no tool calls).  The loop must emit limit(cost) even
    // though the loop exits via the text-only break, not the post-tools check.
    const provider = new FakeProvider([
      [
        { type: 'text_delta', text: '分析中...' },
        { type: 'usage', inputTokens: TOKEN_CEILING + 1, outputTokens: 0 },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    const events = await runAndCollect('費用超限測試', session, provider, ctx);

    // totalTokens must be updated.
    expect(session.totalTokens).toBeGreaterThan(TOKEN_CEILING);

    // A limit(cost) event must be emitted even for a text-only response that
    // crosses the ceiling.
    const limitEvent = events.find((e) => e.type === 'limit');
    expect(limitEvent).toBeDefined();
    if (limitEvent?.type === 'limit') {
      expect(limitEvent.kind).toBe('cost');
    }
    expect(events.at(-1)?.type).toBe('done');
  });

  it('emits limit(cost) event at start of next iter when ceiling was already hit', async () => {
    // Pre-seed the CONTEXT size above the ceiling (the gate compares context,
    // not cumulative spend).
    session.contextTokens = TOKEN_CEILING;

    // Provider is configured with a tool call turn so the loop would iterate
    const provider = new FakeProvider([
      [
        { type: 'text_delta', text: '已達上限。' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    const events = await runAndCollect('再試一次', session, provider, ctx);

    const limitEvent = events.find((e) => e.type === 'limit');
    expect(limitEvent).toBeDefined();
    if (limitEvent?.type === 'limit') {
      expect(limitEvent.kind).toBe('cost');
    }
    expect(events.at(-1)?.type).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// §6b  Regression: no double limit event when cost ceiling fires after tool round
// ---------------------------------------------------------------------------

describe('TOKEN_CEILING after tool round — no double limit event', () => {
  it('emits exactly one limit(cost) event when ceiling is hit after tool dispatch', async () => {
    const provider = new FakeProvider([
      // Turn 1: model calls search_nodes; the round's usage reports a context
      // larger than the ceiling, so the post-tools check must stop the loop.
      [
        {
          type: 'tool_use',
          id: 'call-ceil-1',
          name: 'search_nodes',
          input: { query: 'multiply' },
        },
        { type: 'usage', inputTokens: TOKEN_CEILING + 10, outputTokens: 0 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // Turn 2 would emit more text but must never be reached.
      [
        { type: 'text_delta', text: '不應該出現' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    const events = await runAndCollect('cost ceil after tool', session, provider, ctx);

    // Exactly one limit event, kind must be 'cost'.
    const limitEvents = events.filter((e) => e.type === 'limit');
    expect(limitEvents).toHaveLength(1);
    if (limitEvents[0]?.type === 'limit') {
      expect(limitEvents[0].kind).toBe('cost');
    }
    // Must never have reached turn 2.
    expect(provider.calls).toBe(1);
    expect(events.at(-1)?.type).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// §7  Abort signal
// ---------------------------------------------------------------------------

describe('abort signal', () => {
  it('stops streaming when signal is aborted before first call', async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = new FakeProvider([
      [
        { type: 'text_delta', text: '這不應該出現' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    const events = await runAndCollect('test', session, provider, ctx, controller.signal);
    // Always ends with done regardless of abort
    expect(events.at(-1)?.type).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// §8  Usage event estimation fallback
// ---------------------------------------------------------------------------

describe('usage estimation', () => {
  it('emits estimated usage when provider sends no usage event', async () => {
    const provider = new FakeProvider([
      [
        { type: 'text_delta', text: '這是一段長文字，用來估算 token 數量。' },
        { type: 'done', stopReason: 'end' },
        // No usage event
      ],
    ]);

    const events = await runAndCollect('估算測試', session, provider, ctx);
    const usageEvent = events.find((e) => e.type === 'usage');
    expect(usageEvent).toBeDefined();
    if (usageEvent?.type === 'usage') {
      expect(usageEvent.estimated).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// §9  createSession
// ---------------------------------------------------------------------------

describe('createSession', () => {
  it('creates a fresh session with correct defaults', () => {
    const s = createSession('abc', '5.7', 'proj/mat.matgraph.json');
    expect(s.id).toBe('abc');
    expect(s.ueVersion).toBe('5.7');
    expect(s.graphPath).toBe('proj/mat.matgraph.json');
    expect(s.messages).toHaveLength(0);
    expect(s.totalTokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §10  Checkpoint + undo
// ---------------------------------------------------------------------------

describe('checkpoint and undo', () => {
  it('snapshotFile records pre-image and undoLastTurn restores it', async () => {
    const viewerRoot = join(tmpDir, 'viewer');
    const store = createCheckpointStore(viewerRoot, 'sess-1');
    const targetPath = join(tmpDir, 'target.matgraph.json');

    // Write original content
    await writeFile(targetPath, '{"original":true}\n', 'utf-8');

    // Snapshot before "write"
    await store.snapshotFile('turn-1', targetPath);

    // Overwrite the file (simulated write)
    await writeFile(targetPath, '{"modified":true}\n', 'utf-8');

    // Undo
    const restored = await store.undoLastTurn();
    expect(restored).not.toBeNull();
    expect(restored!.length).toBe(1);
    expect(restored![0]).toBe(targetPath);

    // File should be back to original
    const after = await readFile(targetPath, 'utf-8');
    expect(JSON.parse(after).original).toBe(true);
  });

  it('snapshotFile records absent sentinel when file did not exist', async () => {
    const viewerRoot = join(tmpDir, 'viewer');
    const store = createCheckpointStore(viewerRoot, 'sess-2');
    const targetPath = join(tmpDir, 'new_file.matgraph.json');

    // File does not exist — snapshot records sentinel
    await store.snapshotFile('turn-1', targetPath);

    // Create the file
    await mkdir(join(tmpDir), { recursive: true });
    await writeFile(targetPath, '{"created":true}\n', 'utf-8');

    // Undo — file should be deleted
    const restored = await store.undoLastTurn();
    expect(restored).not.toBeNull();

    // File should no longer exist
    let exists = false;
    try {
      await readFile(targetPath, 'utf-8');
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('undoLastTurn returns null when no turns exist', async () => {
    const viewerRoot = join(tmpDir, 'viewer');
    const store = createCheckpointStore(viewerRoot, 'sess-empty');
    const result = await store.undoLastTurn();
    expect(result).toBeNull();
  });

  it('turnIds() returns stack in oldest-to-newest order', async () => {
    const viewerRoot = join(tmpDir, 'viewer');
    const store = createCheckpointStore(viewerRoot, 'sess-order');
    const f = join(tmpDir, 'f.matgraph.json');
    await writeFile(f, '{}', 'utf-8');

    await store.snapshotFile('turn-a', f);
    await store.snapshotFile('turn-b', f);

    expect(store.turnIds()).toEqual(['turn-a', 'turn-b']);
  });

  it('multiple turns: undo pops one at a time', async () => {
    const viewerRoot = join(tmpDir, 'viewer');
    const store = createCheckpointStore(viewerRoot, 'sess-multi');
    const f = join(tmpDir, 'multi.json');

    await writeFile(f, '{"v":1}\n', 'utf-8');
    await store.snapshotFile('turn-1', f);
    await writeFile(f, '{"v":2}\n', 'utf-8');
    await store.snapshotFile('turn-2', f);
    await writeFile(f, '{"v":3}\n', 'utf-8');

    // Undo turn-2: restores v=2
    await store.undoLastTurn();
    const afterUndo2 = JSON.parse(await readFile(f, 'utf-8'));
    expect(afterUndo2.v).toBe(2);

    // Undo turn-1: restores v=1
    await store.undoLastTurn();
    const afterUndo1 = JSON.parse(await readFile(f, 'utf-8'));
    expect(afterUndo1.v).toBe(1);

    // No more turns
    const result = await store.undoLastTurn();
    expect(result).toBeNull();
  });

  it('undoLastTurn with allowedRoot skips entries outside the root', async () => {
    // Regression test: the allowedRoot confinement guard must block restoration
    // of snapshot entries whose decoded paths lie outside the allowed directory.
    const viewerRoot = join(tmpDir, 'viewer');
    const store = createCheckpointStore(viewerRoot, 'sess-confinement');

    // Set up an "allowed" directory and an "outside" path.
    const allowedRoot = join(tmpDir, 'graphs');
    await mkdir(allowedRoot, { recursive: true });

    // An outside path (sibling of tmpDir, not inside allowedRoot).
    const outsidePath = join(tmpDir, 'tools', 'should-not-be-touched.txt');
    await mkdir(dirname(outsidePath), { recursive: true });
    await writeFile(outsidePath, 'original', 'utf-8');

    // A safe path inside allowedRoot.
    const safePath = join(allowedRoot, 'safe.matgraph.json');
    await writeFile(safePath, '{"v":1}', 'utf-8');

    // Snapshot both paths in the same turn.
    await store.snapshotFile('turn-1', outsidePath);  // will be skipped
    await store.snapshotFile('turn-1', safePath);     // will be restored

    // Overwrite both files to simulate agent writes.
    await writeFile(outsidePath, 'ROGUE_REPLACEMENT', 'utf-8');
    await writeFile(safePath, '{"v":2}', 'utf-8');

    // Undo with allowedRoot — only safePath should be restored.
    const restored = await store.undoLastTurn(allowedRoot);
    expect(restored).not.toBeNull();

    // safePath must be restored to {"v":1}.
    const safeContent = JSON.parse(await readFile(safePath, 'utf-8'));
    expect(safeContent.v).toBe(1);

    // outsidePath must NOT have been restored — still holds ROGUE_REPLACEMENT.
    const outsideContent = await readFile(outsidePath, 'utf-8');
    expect(outsideContent).toBe('ROGUE_REPLACEMENT');

    // The return value must contain both: safePath as a normal entry and
    // outsidePath marked with the !SKIPPED: prefix.
    expect(restored!.some(p => p === safePath)).toBe(true);
    expect(restored!.some(p => p === '!SKIPPED:' + outsidePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §11  write_graph with beforeWrite checkpoint integration
// ---------------------------------------------------------------------------

describe('write_graph + checkpoint beforeWrite integration', () => {
  it('beforeWrite is called before the file is written', async () => {
    const calls: string[] = [];
    const hookCtx: ToolContext = {
      ...ctx,
      beforeWrite: async (absPath: string, _turnId: string) => {
        calls.push(absPath);
      },
    };

    const graphPath = 'mat/checkpoint_test.matgraph.json';
    const provider = new FakeProvider([
      [
        {
          type: 'tool_use',
          id: 'call-cpt',
          name: 'write_graph',
          input: { path: graphPath, graph: VALID_GRAPH },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: '完成。' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    await runAndCollect('建立材質', session, provider, hookCtx);

    expect(calls.length).toBe(1);
    expect(calls[0]).toMatch(/checkpoint_test\.matgraph\.json$/);
  });
});

// ---------------------------------------------------------------------------
// §12  __parse_error__ tool: loop converts to is_error tool_result
// ---------------------------------------------------------------------------

describe('__parse_error__ handling', () => {
  it('loop survives a __parse_error__ event and continues', async () => {
    const provider = new FakeProvider([
      // Turn 1: provider emits a parse error (bad JSON from adapter)
      [
        {
          type: 'tool_use',
          id: 'pe-1',
          name: '__parse_error__',
          input: { original_tool: 'write_graph', raw: '{bad', error: 'SyntaxError' },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // Turn 2: final text
      [
        { type: 'text_delta', text: '抱歉，讓我重試。' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    const events = await runAndCollect('test parse error', session, provider, ctx);
    // Should complete without throwing
    expect(events.at(-1)?.type).toBe('done');
    // The __parse_error__ must have been converted to an is_error tool_result
    // and sent back to the model (turn 2), proving self-correction routing.
    expect(provider.calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §13  M2 acceptance: raw validation error never surfaces in text/diff events
// ---------------------------------------------------------------------------

describe('self-repair: raw error text never surfaces in text/diff events', () => {
  it('emitted text and diff events contain no raw validation error strings', async () => {
    const badGraph = {
      // Missing 'type' field — validation will produce a raw error
      schemaVersion: '1.0',
      ueVersion: '5.7',
      name: 'bad',
      nodes: [],
      connections: [],
    };

    const graphPath = 'proj/no_leak.matgraph.json';
    const provider = new FakeProvider([
      // Turn 1: invalid graph — will be rejected with validation errors
      [
        {
          type: 'tool_use',
          id: 'call-bad2',
          name: 'write_graph',
          input: { path: graphPath, graph: badGraph },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // Turn 2: model self-corrects with a valid graph
      [
        {
          type: 'tool_use',
          id: 'call-good2',
          name: 'write_graph',
          input: { path: graphPath, graph: VALID_GRAPH },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // Turn 3: final narrative text
      [
        { type: 'text_delta', text: '材質已修正完成，發光效果已套用。' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    const events = await runAndCollect('建立材質', session, provider, ctx);

    // Collect all text content from text and diff events
    const textContent = events
      .filter((e) => e.type === 'text')
      .map((e) => (e as { type: 'text'; text: string }).text)
      .join('');
    const diffContent = events
      .filter((e) => e.type === 'diff')
      .flatMap((e) => (e as { type: 'diff'; lines: string[] }).lines)
      .join('\n');

    // Raw validation error strings must not appear in user-facing text or diff events.
    // validateGraph produces 'missing required field: type' for a graph with no type field.
    expect(textContent).not.toContain('missing required field');
    expect(textContent).not.toContain('type must be "Material"');
    expect(diffContent).not.toContain('missing required field');

    // The valid graph must exist on disk
    const absPath = join(ctx.graphsRoot, graphPath);
    const raw = await readFile(absPath, 'utf-8');
    const written = JSON.parse(raw);
    expect(written.name).toBe('glowing_water');

    expect(events.at(-1)?.type).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// §14  M2 acceptance: checkpoint — multiple writes to one path in one turn
//      → undo restores the ORIGINAL pre-image, not the intermediate state
// ---------------------------------------------------------------------------

describe('checkpoint: multiple writes to same path in one turn', () => {
  it('undo restores the ORIGINAL content when the same path is written twice in one turn', async () => {
    const viewerRoot = join(tmpDir, 'viewer');
    const store = createCheckpointStore(viewerRoot, 'sess-multi-write');
    const targetPath = join(tmpDir, 'multi_write.matgraph.json');

    // Write original content
    await writeFile(targetPath, '{"v":"original"}\n', 'utf-8');

    // First write — snapshot should capture "original"
    await store.snapshotFile('turn-1', targetPath);
    await writeFile(targetPath, '{"v":"first_write"}\n', 'utf-8');

    // Second write — snapshot should be a no-op (same path, same turn)
    await store.snapshotFile('turn-1', targetPath);
    await writeFile(targetPath, '{"v":"second_write"}\n', 'utf-8');

    // Verify current state is second_write
    const current = JSON.parse(await readFile(targetPath, 'utf-8'));
    expect(current.v).toBe('second_write');

    // Undo: must restore to "original", not "first_write"
    const restored = await store.undoLastTurn();
    expect(restored).not.toBeNull();
    expect(restored!.length).toBe(1); // only ONE snapshot recorded

    const after = JSON.parse(await readFile(targetPath, 'utf-8'));
    expect(after.v).toBe('original');
  });
});

// ---------------------------------------------------------------------------
// §15  M2 acceptance: usage — scripted usage events accumulate with estimated:false
// ---------------------------------------------------------------------------

describe('usage: scripted usage events have estimated:false', () => {
  it('emits usage with estimated:false when provider sends real usage events', async () => {
    const provider = new FakeProvider([
      [
        { type: 'text_delta', text: '處理中。' },
        { type: 'usage', inputTokens: 100, outputTokens: 50 },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    const events = await runAndCollect('token test', session, provider, ctx);
    const usageEvent = events.find((e) => e.type === 'usage');
    expect(usageEvent).toBeDefined();
    if (usageEvent?.type === 'usage') {
      expect(usageEvent.inputTokens).toBe(100);
      expect(usageEvent.outputTokens).toBe(50);
      expect(usageEvent.estimated).toBe(false);
    }
    expect(session.totalTokens).toBe(150);
  });

  it('accumulates tokens across multiple provider rounds', async () => {
    const graphPath = 'proj/accum_test.matgraph.json';
    const provider = new FakeProvider([
      // Round 1: search_nodes + usage
      [
        {
          type: 'tool_use',
          id: 'call-s1',
          name: 'search_nodes',
          input: { query: 'multiply' },
        },
        { type: 'usage', inputTokens: 200, outputTokens: 30 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // Round 2: write_graph + usage
      [
        {
          type: 'tool_use',
          id: 'call-w1',
          name: 'write_graph',
          input: { path: graphPath, graph: VALID_GRAPH },
        },
        { type: 'usage', inputTokens: 300, outputTokens: 80 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // Round 3: final text + usage
      [
        { type: 'text_delta', text: '完成。' },
        { type: 'usage', inputTokens: 150, outputTokens: 20 },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    await runAndCollect('累計 token 測試', session, provider, ctx);

    // 200+30 + 300+80 + 150+20 = 780
    expect(session.totalTokens).toBe(780);

    // Reset session and re-run to capture events
    session = createSession('test-session-accum', '5.7');
    const events = await runAndCollect('累計 token 測試', session, new FakeProvider([
      [
        {
          type: 'tool_use',
          id: 'call-s2',
          name: 'search_nodes',
          input: { query: 'multiply' },
        },
        { type: 'usage', inputTokens: 200, outputTokens: 30 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: '完成。' },
        { type: 'usage', inputTokens: 150, outputTokens: 20 },
        { type: 'done', stopReason: 'end' },
      ],
    ]), ctx);

    const uEvents = events.filter((e) => e.type === 'usage');
    expect(uEvents.length).toBe(2);
    for (const ev of uEvents) {
      if (ev.type === 'usage') {
        expect(ev.estimated).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §16  M2 acceptance: abort mid-stream — no half-written graph left on disk
// ---------------------------------------------------------------------------

describe('abort mid-stream: no partial graph written', () => {
  it('abort signal after first text delta leaves no graph file on disk', async () => {
    const graphPath = 'proj/abort_test.matgraph.json';
    const absPath = join(ctx.graphsRoot, graphPath);
    const controller = new AbortController();

    const provider: Provider = {
      async *stream() {
        // Emit a text delta, then abort before tool call
        yield { type: 'text_delta', text: '開始建立...' };
        // Abort externally
        controller.abort();
        // Subsequent events should be ignored by the loop
        yield { type: 'tool_use', id: 'call-abort', name: 'write_graph', input: { path: graphPath, graph: VALID_GRAPH } };
        yield { type: 'done', stopReason: 'tool_use' };
      },
    };

    const events = await runAndCollect('abort test', session, provider as FakeProvider, ctx, controller.signal);

    // Always ends with done (loop's terminal event even on abort)
    expect(events.at(-1)?.type).toBe('done');

    // Graph file must NOT exist (write was never reached or committed)
    let exists = false;
    try {
      await readFile(absPath, 'utf-8');
      exists = true;
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §11b  beforeWrite receives per-USER-turn turnId (not per-call, not per-iter)
//        — all writes made while serving one user message form ONE undo step
// ---------------------------------------------------------------------------

describe('beforeWrite receives per-user-turn turnId', () => {
  it('writes across separate LLM iterations of one user turn share the same turnId', async () => {
    const turnIds: string[] = [];
    const graph1Path = 'proj/g1.matgraph.json';
    const graph2Path = 'proj/g2.matgraph.json';

    const hookCtx: ToolContext = {
      ...ctx,
      beforeWrite: async (_absPath: string, turnId: string) => {
        turnIds.push(turnId);
      },
    };

    const provider = new FakeProvider([
      // Iteration 1: two write_graph calls in one LLM response.
      [
        {
          type: 'tool_use',
          id: 'call-w1',
          name: 'write_graph',
          input: { path: graph1Path, graph: VALID_GRAPH },
        },
        {
          type: 'tool_use',
          id: 'call-w2',
          name: 'write_graph',
          input: { path: graph2Path, graph: { ...VALID_GRAPH, name: 'g2' } },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // Iteration 2: a third write in a LATER iteration of the same user turn.
      [
        {
          type: 'tool_use',
          id: 'call-w3',
          name: 'write_graph',
          input: { path: graph1Path, graph: { ...VALID_GRAPH, name: 'g1b' } },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: '完成。' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    await runAndCollect('three writes one user turn', session, provider, hookCtx);

    // All three writes must share ONE turnId — undo reverts the whole exchange.
    expect(turnIds).toHaveLength(3);
    expect(new Set(turnIds).size).toBe(1);
    // TurnId must not embed a call.id segment (format: <sessionId>-turn<N>).
    expect(turnIds[0]).toMatch(/^test-session-turn\d+$/);
  });

  it('separate runAgent calls on one session get DIFFERENT turnIds', async () => {
    const turnIds: string[] = [];
    const hookCtx: ToolContext = {
      ...ctx,
      beforeWrite: async (_absPath: string, turnId: string) => {
        turnIds.push(turnId);
      },
    };

    const writeTurn = (id: string, name: string): StreamEvent[][] => [
      [
        {
          type: 'tool_use',
          id,
          name: 'write_graph',
          input: { path: 'proj/seq.matgraph.json', graph: { ...VALID_GRAPH, name } },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: '好了。' },
        { type: 'done', stopReason: 'end' },
      ],
    ];

    await runAndCollect('第一句', session, new FakeProvider(writeTurn('c1', 'v1')), hookCtx);
    await runAndCollect('第二句', session, new FakeProvider(writeTurn('c2', 'v2')), hookCtx);

    // Reused turnIds across user turns would make the checkpoint store skip
    // the second pre-image — undo would then restore pre-FIRST-turn state.
    expect(turnIds).toHaveLength(2);
    expect(turnIds[0]).not.toBe(turnIds[1]);
  });
});

// ---------------------------------------------------------------------------
// §11c  Regression: cross-user-turn undo restores the PREVIOUS turn's result,
//        not the state from before the first turn (turnId collision bug)
// ---------------------------------------------------------------------------

describe('checkpoint across user turns: undo reverts exactly one user turn', () => {
  it('after two user turns writing the same file, undo restores turn-1 output (not deletion)', async () => {
    const viewerRoot = join(tmpDir, 'viewer');
    const store = createCheckpointStore(viewerRoot, 'test-session');
    const hookCtx: ToolContext = {
      ...ctx,
      beforeWrite: async (absPath: string, turnId: string) => {
        await store.snapshotFile(turnId, absPath);
      },
    };

    const graphPath = 'proj/two_turns.matgraph.json';
    const absPath = join(ctx.graphsRoot, graphPath);

    const writeTurn = (id: string, name: string): StreamEvent[][] => [
      [
        {
          type: 'tool_use',
          id,
          name: 'write_graph',
          input: { path: graphPath, graph: { ...VALID_GRAPH, name } },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: '好了。' },
        { type: 'done', stopReason: 'end' },
      ],
    ];

    // User turn 1 creates the file (pre-image: absent). User turn 2 rewrites it.
    await runAndCollect('做一個發光材質', session, new FakeProvider(writeTurn('t1', 'turn_one')), hookCtx);
    await runAndCollect('改成藍色', session, new FakeProvider(writeTurn('t2', 'turn_two')), hookCtx);

    expect(JSON.parse(await readFile(absPath, 'utf-8')).name).toBe('turn_two');

    // Undo must revert ONLY user turn 2 → file contains turn 1's output.
    // (With colliding turnIds the second pre-image is never recorded and undo
    // restores the absent sentinel — deleting the file and losing turn 1.)
    const restored = await store.undoLastTurn();
    expect(restored).not.toBeNull();
    expect(JSON.parse(await readFile(absPath, 'utf-8')).name).toBe('turn_one');

    // A second undo reverts user turn 1 → file did not exist → deleted.
    await store.undoLastTurn();
    await expect(readFile(absPath, 'utf-8')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// §11d  Regression: role alternation across runAgent calls — a turn that ends
//        with tool_results (iters ceiling) must not be followed by a second
//        consecutive user message on the next call
// ---------------------------------------------------------------------------

describe('role alternation across user turns', () => {
  it('user text after an iters-ceiling turn merges into the trailing tool_result message', async () => {
    // maxIters=1 forces the first call to end right after a tool round,
    // leaving a user-role tool_results message as the session tail.
    const toolOnlyTurn: StreamEvent[][] = [
      [
        { type: 'tool_use', id: 'alt-1', name: 'search_nodes', input: { query: 'noise' } },
        { type: 'done', stopReason: 'tool_use' },
      ],
    ];
    await runAndCollect('找一個雜訊節點', session, new FakeProvider(toolOnlyTurn), ctx, undefined, { maxIters: 1 });
    expect(session.messages.at(-1)?.role).toBe('user');

    await runAndCollect('然後呢', session, new FakeProvider([]), ctx);

    // Roles must strictly alternate — consecutive same-role messages make the
    // next Anthropic request invalid.
    for (let i = 1; i < session.messages.length; i++) {
      expect(session.messages[i].role).not.toBe(session.messages[i - 1].role);
    }
    // The second user text must still be present (merged into the tail message).
    const hasMergedText = session.messages.some(
      (m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text === '然後呢'),
    );
    expect(hasMergedText).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §16b  Regression: abort between two parallel tool calls must not leave a
//        partial tool_result list in session.messages
// ---------------------------------------------------------------------------

describe('abort mid-dispatch: partial tool results not appended', () => {
  it('session.messages has no mismatched tool_result user message after mid-dispatch abort', async () => {
    const controller = new AbortController();
    let callCount = 0;

    // Custom provider: yields two tool_use blocks.
    const provider: Provider = {
      async *stream() {
        yield { type: 'tool_use', id: 'call-A', name: 'search_nodes', input: { query: 'a' } };
        yield { type: 'tool_use', id: 'call-B', name: 'search_nodes', input: { query: 'b' } };
        yield { type: 'done', stopReason: 'tool_use' };
      },
    };

    // Wrap dispatchTool via ctx to abort after first call completes.
    // We simulate this by aborting after the first tool_start event.
    const events: AgentSseEvent[] = [];
    const emit: EmitFn = (e) => {
      events.push(e);
      // Abort signal after the first tool_start so the second call is skipped.
      if (e.type === 'tool_start') {
        callCount++;
        if (callCount === 1) controller.abort();
      }
    };

    await runAgent('abort partial tool test', session, provider as FakeProvider, 'fake-model', ctx, emit, controller.signal);

    // EVERY assistant message containing tool_use blocks must be followed by a
    // user message answering each of them — the API rejects dangling tool_use.
    // (Synthetic aborted results fill the gap for calls that were skipped.)
    const msgs = session.messages;
    for (let i = 0; i < msgs.length; i++) {
      const cur = msgs[i];
      if (cur.role !== 'assistant') continue;
      const toolUseCount = cur.content.filter((b) => b.type === 'tool_use').length;
      if (toolUseCount === 0) continue;
      const next = msgs[i + 1];
      expect(next?.role).toBe('user');
      const toolResultCount = next!.content.filter((b) => b.type === 'tool_result').length;
      expect(toolResultCount).toBe(toolUseCount);
    }

    // The skipped second call must be answered with an is_error result.
    const lastUser = msgs.at(-1);
    expect(lastUser?.role).toBe('user');
    const errResults = lastUser!.content.filter((b) => b.type === 'tool_result' && b.isError);
    expect(errResults.length).toBeGreaterThanOrEqual(1);

    // An abort is not an iteration ceiling — no limit event may be emitted.
    expect(events.some((e) => e.type === 'limit')).toBe(false);

    // Always ends with done.
    expect(events.at(-1)?.type).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// §18  tool_start summary: validate_graph shows the path (precedence bug)
// ---------------------------------------------------------------------------

describe('tool_start summary for validate_graph', () => {
  it('shows the path when one is given, (inline) only for inline graphs', async () => {
    const provider = new FakeProvider([
      [
        { type: 'tool_use', id: 'vg-1', name: 'validate_graph', input: { path: 'proj/check_me.matgraph.json' } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'tool_use', id: 'vg-2', name: 'validate_graph', input: { graph: VALID_GRAPH } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: '檢查完成。' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    const events = await runAndCollect('檢查圖形', session, provider, ctx);
    const summaries = events
      .filter((e) => e.type === 'tool_start')
      .map((e) => (e as { type: 'tool_start'; summary: string }).summary);

    expect(summaries[0]).toContain('proj/check_me.matgraph.json');
    expect(summaries[0]).not.toContain('(inline)');
    expect(summaries[1]).toContain('(inline)');
  });
});

// ---------------------------------------------------------------------------
// §17  M2 acceptance: options injection — tiny maxIters / tokenCeiling
// ---------------------------------------------------------------------------

describe('RunAgentOptions injection', () => {
  it('respects injected maxIters=2 to limit iterations', async () => {
    // 5 tool-call turns — should stop after 2
    const turns: StreamEvent[][] = Array.from({ length: 5 }, (_, i) => [
      {
        type: 'tool_use',
        id: `call-opt-${i}`,
        name: 'search_nodes',
        input: { query: 'test' },
      },
      { type: 'done', stopReason: 'tool_use' },
    ]);

    const provider = new FakeProvider(turns);
    const events = await runAndCollect(
      'options test',
      session,
      provider,
      ctx,
      undefined,
      { maxIters: 2 },
    );

    const limitEvent = events.find((e) => e.type === 'limit');
    expect(limitEvent).toBeDefined();
    if (limitEvent?.type === 'limit') {
      expect(limitEvent.kind).toBe('iters');
    }
    // Should have stopped at or before 2 calls
    expect(provider.calls).toBeLessThanOrEqual(2);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('respects injected tokenCeiling=10 to emit cost limit', async () => {
    // Pre-seed tokens just at ceiling
    session.totalTokens = 10;

    const provider = new FakeProvider([
      [
        { type: 'text_delta', text: '好' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    // With tokenCeiling=10 and session already at 10, should emit limit immediately
    const events = await runAndCollect('ceiling test', session, provider, ctx, undefined, { tokenCeiling: 10 });

    const limitEvent = events.find((e) => e.type === 'limit');
    expect(limitEvent).toBeDefined();
    if (limitEvent?.type === 'limit') {
      expect(limitEvent.kind).toBe('cost');
    }
    expect(events.at(-1)?.type).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// §19  Thinking: SSE forwarding + history round-trip placement
// ---------------------------------------------------------------------------

describe('thinking events', () => {
  it('forwards thinking_delta as SSE thinking and stores thinking_block in history before text', async () => {
    const provider = new FakeProvider([
      [
        { type: 'thinking_delta', text: '先想' },
        { type: 'thinking_delta', text: '一下' },
        { type: 'thinking_block', block: { type: 'thinking', thinking: '先想一下', signature: 'sig-x' } },
        { type: 'text_delta', text: '好的，開始。' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    const events = await runAndCollect('做一個材質', session, provider, ctx, undefined, { thinking: 'medium' });

    const thinkingEvents = events.filter(e => e.type === 'thinking');
    expect(thinkingEvents.map(e => (e as { text: string }).text)).toEqual(['先想', '一下']);

    // The assistant history message must carry the complete thinking block
    // FIRST (Anthropic requires it ahead of text/tool_use on round-trip).
    const assistant = session.messages.find(m => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant!.content[0]).toEqual({ type: 'thinking', thinking: '先想一下', signature: 'sig-x' });
    expect(assistant!.content[1]).toEqual({ type: 'text', text: '好的，開始。' });

    // thinking_block must never surface as a user-visible event.
    expect(events.some(e => (e as { type: string }).type === 'thinking_block')).toBe(false);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('passes the thinking level through to every ChatRequest of the turn', async () => {
    const seen: Array<string | undefined> = [];
    const provider: Provider = {
      async *stream(req: ChatRequest) {
        seen.push(req.thinking);
        if (seen.length === 1) {
          yield { type: 'tool_use', id: 'th-1', name: 'search_nodes', input: { query: 'noise' } };
          yield { type: 'done', stopReason: 'tool_use' };
        } else {
          yield { type: 'text_delta', text: '完成。' };
          yield { type: 'done', stopReason: 'end' };
        }
      },
    };

    await runAndCollect('找雜訊節點', session, provider as FakeProvider, ctx, undefined, { thinking: 'high' });
    expect(seen).toEqual(['high', 'high']);
  });
});

// ---------------------------------------------------------------------------
// §20  Compaction (M11-1): summarize old turns into session memory + trim
// ---------------------------------------------------------------------------

import { createMemoryStore } from '../server/agent/memory-store.js';

describe('compaction', () => {
  /** Recording provider: captures every ChatRequest, pops scripted turns. */
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

  function seedTurns(n: number): void {
    for (let i = 1; i <= n; i++) {
      session.messages.push({ role: 'user', content: [{ type: 'text', text: `第${i}輪請求` }] });
      session.messages.push({ role: 'assistant', content: [{ type: 'text', text: `第${i}輪回覆` }] });
    }
  }

  it('summarizes dropped turns into session memory, trims history, emits compacted', async () => {
    const memory = createMemoryStore(join(tmpDir, 'viewer'), 'test-session');
    const memCtx: ToolContext = { ...ctx, memory };
    seedTurns(6);
    session.contextTokens = 200_000;

    const provider = new RecordingProvider([
      // Call #1 = the summarizer (tool-less one-shot).
      [{ type: 'text_delta', text: '摘要：使用者要做發光材質，已建立 proj/glow。' }, { type: 'done', stopReason: 'end' }],
      // Call #2 = the actual turn.
      [{ type: 'text_delta', text: '繼續處理。' }, { type: 'done', stopReason: 'end' }],
    ]);

    const events: AgentSseEvent[] = [];
    await runAgent('繼續', session, provider, 'fake-model', memCtx, e => events.push(e), undefined, {
      compactThreshold: 100,
      compactKeepTurns: 2,
    });

    // compacted event emitted with the dropped-turn count (6 seeded − 2 kept = 4).
    const compacted = events.find(e => e.type === 'compacted');
    expect(compacted).toBeDefined();
    if (compacted?.type === 'compacted') expect(compacted.message).toContain('4 輪');

    // The summary landed in session memory…
    expect(await memory.read('session')).toContain('使用者要做發光材質');
    // …and the summarizer was tool-less.
    expect(provider.requests[0].tools).toBeUndefined();

    // History trimmed: dropped turns gone, kept turns + new exchange intact,
    // starting at a text-only user message with strictly alternating roles.
    const flat = JSON.stringify(session.messages);
    expect(flat).not.toContain('第1輪請求');
    expect(flat).not.toContain('第4輪回覆');
    expect(flat).toContain('第5輪請求');
    expect(flat).toContain('第6輪回覆');
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[0].content.every(b => b.type === 'text')).toBe(true);
    for (let i = 1; i < session.messages.length; i++) {
      expect(session.messages[i].role).not.toBe(session.messages[i - 1].role);
    }

    // The MAIN call's system prompt carries the fresh summary (memory read
    // happens after compaction), and totalTokens was re-estimated downward.
    expect(provider.requests[1].system ?? '').toContain('使用者要做發光材質');
    expect(session.totalTokens).toBeLessThan(100_000);
  });

  it('compact_context tool: model-triggered compaction works below the auto threshold', async () => {
    const memory = createMemoryStore(join(tmpDir, 'viewer'), 'tool-compact');
    const memCtx: ToolContext = { ...ctx, memory };
    seedTurns(6);
    session.totalTokens = 10; // far below threshold — only the tool can compact

    const provider = new RecordingProvider([
      // Call #1 = the turn: the model decides to compact.
      [
        { type: 'tool_use', id: 'cc-1', name: 'compact_context', input: {} },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // Call #2 = the summarizer one-shot triggered by the tool.
      [{ type: 'text_delta', text: '摘要：先前六輪的重點。' }, { type: 'done', stopReason: 'end' }],
      // Call #3 = the turn continues after the tool result.
      [{ type: 'text_delta', text: '已完成壓縮。' }, { type: 'done', stopReason: 'end' }],
    ]);

    const events: AgentSseEvent[] = [];
    await runAgent('壓縮上下文', session, provider, 'fake-model', memCtx, e => events.push(e), undefined, {
      compactThreshold: 1_000_000, compactKeepTurns: 2,
    });

    // Tool surfaced with the zh-TW step line and succeeded.
    expect(events.some(e => e.type === 'tool_start' && e.name === 'compact_context')).toBe(true);
    const end = events.find(e => e.type === 'tool_end' && e.name === 'compact_context');
    expect(end?.type === 'tool_end' && end.ok).toBe(true);
    expect(events.some(e => e.type === 'compacted')).toBe(true);

    // Summary written to session memory; old turns trimmed; the in-flight
    // turn (its user message + assistant tool_use tail) survived the cut.
    expect(await memory.read('session')).toContain('先前六輪的重點');
    const flat = JSON.stringify(session.messages);
    expect(flat).not.toContain('第1輪請求');
    expect(flat).toContain('壓縮上下文');
    expect(flat).toContain('已完成壓縮');
    for (let i = 1; i < session.messages.length; i++) {
      expect(session.messages[i].role).not.toBe(session.messages[i - 1].role);
    }

    // The model received an informative tool result (dropped-turn count).
    const lastReq = JSON.stringify(provider.requests[2].messages);
    expect(lastReq).toContain('已將先前');
  });

  it('compact_context tool: reports not-enough-history instead of failing hard', async () => {
    const memory = createMemoryStore(join(tmpDir, 'viewer'), 'tool-compact-short');
    const memCtx: ToolContext = { ...ctx, memory };
    // No seeded turns — only the in-flight one. Nothing to compact.
    const provider = new RecordingProvider([
      [
        { type: 'tool_use', id: 'cc-2', name: 'compact_context', input: {} },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [{ type: 'text_delta', text: '目前對話還不長。' }, { type: 'done', stopReason: 'end' }],
    ]);

    const events: AgentSseEvent[] = [];
    await runAgent('壓縮', session, provider, 'fake-model', memCtx, e => events.push(e), undefined, {
      compactThreshold: 1_000_000, compactKeepTurns: 2,
    });

    const end = events.find(e => e.type === 'tool_end' && e.name === 'compact_context');
    expect(end?.type === 'tool_end' && end.ok).toBe(false);
    expect(events.some(e => e.type === 'compacted')).toBe(false);
    // The tool result explains why (fed back to the model, not thrown).
    expect(JSON.stringify(provider.requests[1].messages)).toContain('無須壓縮');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('does not compact below threshold or without a memory store', async () => {
    seedTurns(6);
    session.totalTokens = 50; // below custom threshold

    const memory = createMemoryStore(join(tmpDir, 'viewer'), 'test-session');
    const p1 = new RecordingProvider([]);
    await runAgent('hi', session, p1, 'fake-model', { ...ctx, memory }, () => {}, undefined, {
      compactThreshold: 100_000, compactKeepTurns: 2,
    });
    expect(p1.requests).toHaveLength(1); // no summarizer call
    expect(JSON.stringify(session.messages)).toContain('第1輪請求');

    // Above threshold but NO memory store → also a no-op.
    session.totalTokens = 200_000;
    const p2 = new RecordingProvider([]);
    await runAgent('again', session, p2, 'fake-model', ctx, () => {}, undefined, {
      compactThreshold: 100, compactKeepTurns: 2,
    });
    expect(p2.requests).toHaveLength(1);
    expect(JSON.stringify(session.messages)).toContain('第1輪請求');
  });

  it('a failed summarizer leaves the history intact (safe no-op)', async () => {
    const memory = createMemoryStore(join(tmpDir, 'viewer'), 'test-session');
    seedTurns(6);
    session.contextTokens = 200_000;

    const provider = new RecordingProvider([
      [{ type: 'error', message: 'HTTP 500: summarizer down' }],
      [{ type: 'text_delta', text: '照常回覆。' }, { type: 'done', stopReason: 'end' }],
    ]);

    const events: AgentSseEvent[] = [];
    await runAgent('繼續', session, provider, 'fake-model', { ...ctx, memory }, e => events.push(e), undefined, {
      compactThreshold: 100, compactKeepTurns: 2,
    });

    expect(events.some(e => e.type === 'compacted')).toBe(false);
    expect(JSON.stringify(session.messages)).toContain('第1輪請求');
    expect(await memory.read('session')).toBe('');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('skips when there is no safe cut point (all turns merged with tool results)', async () => {
    const memory = createMemoryStore(join(tmpDir, 'viewer'), 'test-session');
    // Two "turns" whose user messages all carry tool_results (merged-tail shape).
    session.messages = [
      { role: 'user', content: [{ type: 'text', text: '起始' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search_nodes', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'r' }, { type: 'text', text: '混合' }] },
      { role: 'assistant', content: [{ type: 'text', text: '回覆' }] },
    ];
    session.totalTokens = 200_000;

    const provider = new RecordingProvider([]);
    const events: AgentSseEvent[] = [];
    await runAgent('next', session, provider, 'fake-model', { ...ctx, memory }, e => events.push(e), undefined, {
      compactThreshold: 100, compactKeepTurns: 1,
    });

    // Only ONE safe start ('起始') ≤ keepTurns → no compaction, single main call.
    expect(provider.requests).toHaveLength(1);
    expect(events.some(e => e.type === 'compacted')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Viewer-action events: export_request / crawl_proposal / rename's graph_written
// ---------------------------------------------------------------------------

describe('viewer-action event fan-out', () => {
  it('export_to_clipboard success emits export_request with the path', async () => {
    await writeFile(
      join(ctx.graphsRoot, 'm.matgraph.json'),
      JSON.stringify(VALID_GRAPH, null, 2) + '\n',
      'utf-8',
    );
    const provider = new FakeProvider([
      [
        { type: 'tool_use', id: 't1', name: 'export_to_clipboard', input: { path: 'm.matgraph.json' } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: '已複製，去 UE 按 Ctrl+V 貼上。' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);
    const events = await runAndCollect('幫我匯出到剪貼簿', session, provider, ctx);
    const exp = events.filter(e => e.type === 'export_request');
    expect(exp).toEqual([{ type: 'export_request', path: 'm.matgraph.json' }]);
  });

  it('request_crawl success emits crawl_proposal (a proposal, never a run)', async () => {
    const readyCtx: ToolContext = {
      ...ctx,
      probeEnvFn: async () => ({ ready: true, platform: 'win32', projectPath: 'p', engineRoot: 'e', checks: {} }) as never,
    };
    const provider = new FakeProvider([
      [
        { type: 'tool_use', id: 't1', name: 'request_crawl', input: { kind: 'workmf' } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: '已送出爬取請求，請按確認後告訴我。' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);
    const events = await runAndCollect('找不到我的MF，去爬一下', session, provider, readyCtx);
    const props = events.filter(e => e.type === 'crawl_proposal');
    expect(props).toEqual([{ type: 'crawl_proposal', kind: 'workmf', contentRoot: '/Game' }]);
  });

  it('rename_graph emits diff lines and graph_written for the NEW path', async () => {
    await writeFile(
      join(ctx.graphsRoot, 'old.matgraph.json'),
      JSON.stringify(VALID_GRAPH, null, 2) + '\n',
      'utf-8',
    );
    const provider = new FakeProvider([
      [
        { type: 'tool_use', id: 't1', name: 'rename_graph', input: { from: 'old.matgraph.json', to: 'new.matgraph.json' } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: '改好名了。' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);
    const events = await runAndCollect('改個名', session, provider, ctx);
    const written = events.filter(e => e.type === 'graph_written');
    expect(written).toEqual([{ type: 'graph_written', path: 'new.matgraph.json' }]);
    const diff = events.filter(e => e.type === 'diff').flatMap(e => (e as { lines: string[] }).lines);
    expect(diff.join('')).toContain('改名');
  });
});

// ---------------------------------------------------------------------------
// Viewport context block (options.viewContext)
// ---------------------------------------------------------------------------

describe('viewport context block', () => {
  it('appends a VIEW_CONTEXT_PREFIX text block after the user text', async () => {
    const provider = new FakeProvider([
      [
        { type: 'text_delta', text: '了解。' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);
    await runAndCollect('這個節點是做什麼的？', session, provider, ctx, undefined, {
      viewContext: '目前開啟的圖：demo/a.matgraph.json；使用者選取的節點 id：mul',
    });
    const first = session.messages[0];
    expect(first.role).toBe('user');
    const texts = first.content.filter(b => b.type === 'text') as { type: 'text'; text: string }[];
    expect(texts).toHaveLength(2);
    expect(texts[0].text).toBe('這個節點是做什麼的？');
    expect(texts[1].text.startsWith(VIEW_CONTEXT_PREFIX)).toBe(true);
    expect(texts[1].text).toContain('demo/a.matgraph.json');
    expect(texts[1].text).toContain('mul');
  });

  it('no viewContext → single text block, and empty/whitespace context is dropped', async () => {
    const provider = new FakeProvider([]);
    await runAndCollect('你好', session, provider, ctx, undefined, { viewContext: '   ' });
    const texts = session.messages[0].content.filter(b => b.type === 'text');
    expect(texts).toHaveLength(1);
  });
});

describe('db_edit_proposal viewer event', () => {
  it('propose_db_edit emits a db_edit_proposal event with the patch payload', async () => {
    const provider = new FakeProvider([
      [
        {
          type: 'tool_use', id: 't1', name: 'propose_db_edit',
          input: { nodeName: 'Multiply', patch: { verified: true }, rationale: '依 UE 5.7 文件查證' },
        },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: '已送出 DB 修改提案，請確認。' },
        { type: 'done', stopReason: 'end' },
      ],
    ]);
    const events = await runAndCollect('這個節點的 verified 標錯了', session, provider, ctx);
    const props = events.filter(e => e.type === 'db_edit_proposal');
    expect(props).toEqual([{
      type: 'db_edit_proposal',
      nodeName: 'Multiply',
      ueVersion: '5.7',
      patch: { verified: true },
      rationale: '依 UE 5.7 文件查證',
    }]);
  });
});

describe('contextTokens vs totalTokens (compaction-too-eager regression)', () => {
  it('contextTokens tracks the LAST round, totalTokens accumulates spend', async () => {
    const provider = new FakeProvider([
      [
        { type: 'tool_use', id: 'c1', name: 'search_nodes', input: { query: 'multiply' } },
        { type: 'usage', inputTokens: 10_000, outputTokens: 200 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'tool_use', id: 'c2', name: 'search_nodes', input: { query: 'lerp' } },
        { type: 'usage', inputTokens: 11_000, outputTokens: 200 },
        { type: 'done', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: '好了。' },
        { type: 'usage', inputTokens: 12_000, outputTokens: 300 },
        { type: 'done', stopReason: 'end' },
      ],
    ]);
    await runAndCollect('做個材質', session, provider, ctx);
    // Spend: all three rounds summed. Context: the last round only — summing
    // re-sent history was what made auto-compaction fire way too early.
    expect(session.totalTokens).toBe(33_700);
    expect(session.contextTokens).toBe(12_300);
  });
});

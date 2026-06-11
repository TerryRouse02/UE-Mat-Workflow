// tests/eval/runner.ts — executes eval scenarios against the REAL agent stack:
// runAgent + tools + checkpoint store, with a scripted provider. The runner
// enforces global invariants after every step in addition to the scenario's
// own expectations:
//
//   1. Each chat step's event stream ends with exactly one 'done'.
//   2. No 'error' events; no 'limit' events unless the step expects one.
//   3. Session history stays Anthropic-legal: roles strictly alternate and
//      every assistant tool_use is answered by a matching tool_result.
//   4. Every .matgraph.json on disk passes the full validation gate at all
//      times — the agent never leaves an invalid graph behind.
//   5. No node in any written graph carries x/y positions (layout is dagre's).
//   6. User-facing text/diff events never contain raw English validation
//      error strings (those belong in tool_results, for the model only).
//   7. Undo never restores a path outside graphsRoot (no !SKIPPED entries).

import { expect } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative, resolve } from 'node:path';
import { runAgent, createSession, type AgentLoopSession } from '../../server/agent/loop.js';
import { createCheckpointStore, type CheckpointStore } from '../../server/agent/checkpoint.js';
import { createMemoryStore, type MemoryStore } from '../../server/agent/memory-store.js';
import { dispatchTool, type ToolContext } from '../../server/agent/tools.js';
import type { Provider, StreamEvent, ChatRequest, ContentBlock } from '../../server/agent/provider/types.js';
import type { AgentSseEvent } from '../../server/agent/agent-types.js';
import type { Scenario, ChatStep, UndoStep, FileExpectation, GraphFile } from './scenario.js';

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..', '..', '..');

/**
 * Raw validation/tool error markers that must never surface in user-facing
 * text or diff events. Narrations are zh-TW; raw errors are English — any of
 * these leaking means a tool_result was echoed to the user.
 */
const RAW_ERROR_MARKERS = [
  'missing required field',
  'unknown node type',
  'applyError',
  'validateErrors',
  'must not contain',
  'already exists',
  'not found',
  'directory traversal',
];

// ---------------------------------------------------------------------------
// Scripted provider — strict: overrunning the script fails the scenario
// ---------------------------------------------------------------------------

class ScriptedProvider implements Provider {
  private callCount = 0;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *stream(_req: ChatRequest): AsyncGenerator<StreamEvent> {
    const turn = this.turns[this.callCount++];
    if (!turn) {
      throw new Error(
        `scenario script exhausted: provider.stream() call #${this.callCount} but only ${this.turns.length} turn(s) scripted`,
      );
    }
    for (const event of turn) yield event;
  }

  get calls(): number {
    return this.callCount;
  }
}

// ---------------------------------------------------------------------------
// runScenario
// ---------------------------------------------------------------------------

export async function runScenario(scenario: Scenario): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'ue-agent-eval-'));
  try {
    const graphsRoot = join(tmp, 'graphs');
    await mkdir(graphsRoot, { recursive: true });

    const store = createCheckpointStore(join(tmp, 'viewer'), 'eval-session');
    const memory = createMemoryStore(join(tmp, 'viewer'), 'eval-session');
    const ctx: ToolContext = {
      repoRoot: REPO_ROOT,
      graphsRoot,
      ueVersion: '5.7',
      workMfIndexPath: join(REPO_ROOT, 'agent-pack', 'workmf-index.json'),
      beforeWrite: async (absPath, turnId) => {
        await store.snapshotFile(turnId || 'turn-0', absPath);
      },
      memory,
    };

    // Seed files (pre-existing user graphs).
    for (const [rel, graph] of Object.entries(scenario.seedFiles ?? {})) {
      const abs = join(graphsRoot, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, JSON.stringify(graph, null, 2) + '\n', 'utf-8');
    }
    // Seeds must be valid themselves — a broken seed invalidates the scenario.
    await assertDiskInvariants(ctx, `${scenario.name} (seed)`);

    const session = createSession('eval-session', '5.7');

    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      const where = `${scenario.name} step ${i + 1} (${step.kind})`;
      if (step.kind === 'chat') {
        await runChatStep(step, where, scenario, session, ctx, memory);
      } else {
        await runUndoStep(step, where, store, ctx);
      }
      await assertDiskInvariants(ctx, where);
      await assertFileExpectations(step.expect?.files, ctx, where);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Chat step
// ---------------------------------------------------------------------------

async function runChatStep(
  step: ChatStep,
  where: string,
  scenario: Scenario,
  session: AgentLoopSession,
  ctx: ToolContext,
  memory: MemoryStore,
): Promise<void> {
  const provider = new ScriptedProvider(step.turns);
  const events: AgentSseEvent[] = [];
  await runAgent(
    step.user,
    session,
    provider,
    'eval-model',
    ctx,
    (e) => events.push(e),
    undefined,
    scenario.options,
  );

  const exp = step.expect ?? {};

  // --- Global event invariants ---
  const dones = events.filter((e) => e.type === 'done');
  expect(dones.length, `${where}: exactly one done event`).toBe(1);
  expect(events.at(-1)?.type, `${where}: stream must end with done`).toBe('done');
  expect(
    events.filter((e) => e.type === 'error'),
    `${where}: no error events expected`,
  ).toEqual([]);

  const limits = events.filter((e) => e.type === 'limit');
  if (exp.limit) {
    expect(limits.length, `${where}: exactly one limit event`).toBe(1);
    if (limits[0]?.type === 'limit') {
      expect(limits[0].kind, `${where}: limit kind`).toBe(exp.limit);
    }
  } else {
    expect(limits, `${where}: no limit events expected`).toEqual([]);
  }

  // --- User-facing content: no raw error leakage ---
  const textContent = events
    .filter((e) => e.type === 'text')
    .map((e) => (e as { type: 'text'; text: string }).text)
    .join('');
  const diffLines = events
    .filter((e) => e.type === 'diff')
    .flatMap((e) => (e as { type: 'diff'; lines: string[] }).lines);
  const userFacing = textContent + '\n' + diffLines.join('\n');
  for (const marker of RAW_ERROR_MARKERS) {
    expect(
      userFacing.includes(marker),
      `${where}: raw error marker "${marker}" leaked into user-facing text/diff`,
    ).toBe(false);
  }

  // --- Session history invariants (Anthropic legality) ---
  assertHistoryInvariants(session, where);

  // --- Script consumption ---
  const expectedCalls = exp.providerCalls ?? step.turns.length;
  expect(provider.calls, `${where}: provider.stream() call count`).toBe(expectedCalls);

  // --- Scenario expectations ---
  if (exp.toolCalls) {
    const names = events
      .filter((e) => e.type === 'tool_start')
      .map((e) => (e as { type: 'tool_start'; name: string }).name);
    expect(names, `${where}: tool_start sequence`).toEqual(exp.toolCalls);
  }
  if (exp.toolEndOk) {
    const oks = events
      .filter((e) => e.type === 'tool_end')
      .map((e) => (e as { type: 'tool_end'; ok: boolean }).ok);
    expect(oks, `${where}: tool_end ok sequence`).toEqual(exp.toolEndOk);
  }
  for (const want of exp.textIncludes ?? []) {
    expect(textContent, `${where}: text must include "${want}"`).toContain(want);
  }
  const diffJoined = diffLines.join('\n');
  for (const want of exp.diffIncludes ?? []) {
    expect(diffJoined, `${where}: diff must include "${want}"`).toContain(want);
  }
  for (const ban of exp.diffExcludes ?? []) {
    expect(
      diffJoined.includes(ban),
      `${where}: diff must NOT include "${ban}"`,
    ).toBe(false);
  }
  if (exp.graphWritten) {
    const paths = events
      .filter((e) => e.type === 'graph_written')
      .map((e) => (e as { type: 'graph_written'; path: string }).path);
    expect(paths, `${where}: graph_written paths`).toEqual(exp.graphWritten);
  }

  // --- Memory expectations (M7b/M11-1 coverage) ---
  if (exp.sessionMemoryIncludes) {
    const mem = await memory.read('session');
    for (const want of exp.sessionMemoryIncludes) {
      expect(mem, `${where}: session memory must include "${want}"`).toContain(want);
    }
  }
  if (exp.longtermMemoryIncludes) {
    const mem = await memory.read('longterm');
    for (const want of exp.longtermMemoryIncludes) {
      expect(mem, `${where}: longterm memory must include "${want}"`).toContain(want);
    }
  }
}

// ---------------------------------------------------------------------------
// Undo step
// ---------------------------------------------------------------------------

async function runUndoStep(
  step: UndoStep,
  where: string,
  store: CheckpointStore,
  ctx: ToolContext,
): Promise<void> {
  const restored = await store.undoLastTurn(ctx.graphsRoot);
  expect(restored, `${where}: undo must have a turn to revert`).not.toBeNull();

  // Invariant: an eval scenario only ever writes inside graphsRoot, so undo
  // must never skip an out-of-root entry.
  const skipped = (restored ?? []).filter((p) => p.startsWith('!SKIPPED:'));
  expect(skipped, `${where}: undo skipped out-of-root paths`).toEqual([]);

  if (step.expect?.restored !== undefined) {
    expect(restored!.length, `${where}: restored file count`).toBe(step.expect.restored);
  }
}

// ---------------------------------------------------------------------------
// Invariants + file expectations
// ---------------------------------------------------------------------------

function assertHistoryInvariants(session: AgentLoopSession, where: string): void {
  const msgs = session.messages;
  for (let i = 1; i < msgs.length; i++) {
    expect(
      msgs[i].role,
      `${where}: roles must strictly alternate (message index ${i})`,
    ).not.toBe(msgs[i - 1].role);
  }
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'assistant') continue;
    const uses = m.content.filter((b: ContentBlock) => b.type === 'tool_use');
    if (uses.length === 0) continue;
    const next = msgs[i + 1];
    expect(next?.role, `${where}: tool_use message ${i} must be followed by tool_results`).toBe('user');
    const resultIds = new Set(
      next!.content
        .filter((b: ContentBlock) => b.type === 'tool_result')
        .map((b) => (b as { toolUseId: string }).toolUseId),
    );
    for (const u of uses) {
      const id = (u as { id: string }).id;
      expect(resultIds.has(id), `${where}: tool_use ${id} has no matching tool_result`).toBe(true);
    }
  }
}

async function listGraphFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.matgraph.json')) out.push(p);
    }
  }
  await walk(root);
  return out;
}

/** Every graph on disk must pass the full validation gate at every step. */
async function assertDiskInvariants(ctx: ToolContext, where: string): Promise<void> {
  for (const abs of await listGraphFiles(ctx.graphsRoot)) {
    const rel = relative(ctx.graphsRoot, abs);
    const raw = await readFile(abs, 'utf-8');
    let parsed: GraphFile;
    try {
      parsed = JSON.parse(raw) as GraphFile;
    } catch (e) {
      throw new Error(`${where}: ${rel} on disk is not valid JSON: ${String(e)}`);
    }

    // Hard rule: never x/y positions in matgraph — layout is dagre's job.
    for (const node of parsed.nodes ?? []) {
      expect(
        node != null && typeof node === 'object' && ('x' in node || 'y' in node),
        `${where}: node "${(node as { id?: string }).id}" in ${rel} carries x/y positions`,
      ).toBe(false);
    }

    const res = await dispatchTool('validate_graph', { path: rel }, ctx);
    expect(res.isError, `${where}: validate_graph(${rel}) failed: ${res.content}`).toBeFalsy();
    const report = JSON.parse(res.content) as { errors: string[] };
    expect(report.errors, `${where}: ${rel} on disk has validation errors`).toEqual([]);
  }
}

async function assertFileExpectations(
  files: FileExpectation[] | undefined,
  ctx: ToolContext,
  where: string,
): Promise<void> {
  for (const f of files ?? []) {
    const abs = join(ctx.graphsRoot, f.path);
    let raw: string | null = null;
    try {
      raw = await readFile(abs, 'utf-8');
    } catch {
      raw = null;
    }
    expect(raw !== null, `${where}: file ${f.path} exists`).toBe(f.exists);
    if (f.exists && f.check && raw !== null) {
      f.check(JSON.parse(raw) as GraphFile);
    }
  }
}

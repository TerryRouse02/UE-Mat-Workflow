// tests/eval/scenario.ts — declarative scenario types + builders for the
// material-agent eval corpus.
//
// A Scenario is a scripted multi-step conversation: each chat step provides
// the FakeProvider turns (StreamEvent[][]) and the behavioral expectations.
// The runner (runner.ts) executes steps against the REAL loop/tools/checkpoint
// stack (tmp graphsRoot, real agent-pack DB) and enforces global invariants
// after every step. Zero real API calls.

import type { StreamEvent } from '../../server/agent/provider/types.js';
import type { RunAgentOptions } from '../../server/agent/loop.js';

// ---------------------------------------------------------------------------
// Graph file shape (loose, for file checks)
// ---------------------------------------------------------------------------

export interface GraphFile {
  schemaVersion?: string;
  ueVersion?: string;
  type?: string;
  name?: string;
  description?: string;
  nodes: Array<{ id: string; type: string; params?: Record<string, unknown> }>;
  connections: Array<{ from: string; to: string }>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Expectations
// ---------------------------------------------------------------------------

export interface FileExpectation {
  /** Relative to graphsRoot. */
  path: string;
  exists: boolean;
  /** Runs against the parsed file when exists:true. Throw / failed expect = scenario failure. */
  check?: (graph: GraphFile) => void;
}

export interface ChatExpect {
  /** Ordered tool_start names. Omit to skip. */
  toolCalls?: string[];
  /** Ordered tool_end ok flags. Omit to skip. */
  toolEndOk?: boolean[];
  /** Substrings that must appear in the concatenated text events. */
  textIncludes?: string[];
  /** Substrings that must appear in the joined diff lines. */
  diffIncludes?: string[];
  /** Substrings that must NOT appear in the joined diff lines. */
  diffExcludes?: string[];
  /** Exact ordered paths of graph_written events. Omit to skip. */
  graphWritten?: string[];
  /** Expected limit event kind. Absent → the runner asserts NO limit event. */
  limit?: 'iters' | 'cost';
  /**
   * Expected provider.stream() call count. Defaults to turns.length — a
   * scripted scenario must consume exactly its script unless a limit stops it.
   */
  providerCalls?: number;
  files?: FileExpectation[];
}

export interface UndoExpect {
  /** Expected number of restored files (skipped entries are an invariant violation). */
  restored?: number;
  files?: FileExpectation[];
}

// ---------------------------------------------------------------------------
// Steps + Scenario
// ---------------------------------------------------------------------------

export interface ChatStep {
  kind: 'chat';
  /** User message (zh-TW, as a real user would type). */
  user: string;
  /** Scripted provider responses, one StreamEvent[] per provider.stream() call. */
  turns: StreamEvent[][];
  expect?: ChatExpect;
}

export interface UndoStep {
  kind: 'undo';
  expect?: UndoExpect;
}

export type Step = ChatStep | UndoStep;

export interface Scenario {
  name: string;
  /** What user behavior this scenario locks in. */
  description: string;
  /** graphsRoot-relative path → graph object, written before the first step. */
  seedFiles?: Record<string, unknown>;
  /** Loop overrides (tiny maxIters etc.). */
  options?: RunAgentOptions;
  steps: Step[];
}

// ---------------------------------------------------------------------------
// DSL builders
// ---------------------------------------------------------------------------

export function chat(user: string, turns: StreamEvent[][], expect?: ChatExpect): ChatStep {
  return { kind: 'chat', user, turns, expect };
}

export function undo(expect?: UndoExpect): UndoStep {
  return { kind: 'undo', expect };
}

export interface ToolCallScript {
  id: string;
  name: string;
  input: unknown;
}

/** One assistant response consisting of tool calls (possibly parallel). */
export function toolTurn(...calls: ToolCallScript[]): StreamEvent[] {
  return [
    ...calls.map((c): StreamEvent => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
    { type: 'done', stopReason: 'tool_use' },
  ];
}

/** One assistant response consisting of narrative text only. */
export function textTurn(text: string): StreamEvent[] {
  return [
    { type: 'text_delta', text },
    { type: 'done', stopReason: 'end' },
  ];
}

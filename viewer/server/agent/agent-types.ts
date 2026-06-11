// server/agent/agent-types.ts — node-free wire types for the agent layer.
// Mirrored in web/src/agent/protocol.ts — keep both in sync.
// Must NOT import node: modules (shared discipline with crawl-types.ts).

/**
 * Events streamed from POST /api/agent/chat as SSE.
 * Each event maps to a `data: <JSON>\n\n` SSE line.
 */
export type AgentSseEvent =
  | { type: 'text'; text: string }                                   // narrative text (streamed char-by-char)
  | { type: 'thinking'; text: string }                               // model reasoning stream (display only)
  | { type: 'tool_start'; name: string; summary: string }            // human-readable step line
  | { type: 'tool_end'; name: string; ok: boolean; summary?: string }
  | { type: 'diff'; lines: string[] }                                // plain-language diff (after successful write)
  | { type: 'graph_written'; path: string; changedNodeIds?: string[] } // UI auto-opens + highlights the changed nodes
  | { type: 'usage'; inputTokens: number; outputTokens: number; estimated: boolean }
  | { type: 'compacted'; message: string }                           // old turns summarized into session memory
  | { type: 'limit'; kind: 'iters' | 'cost'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

/** Reasoning-effort level selectable per user turn. */
export type AgentThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** Body for POST /api/agent/chat */
export interface AgentChatRequest {
  text: string;
  ueVersion?: string;
  graphPath?: string;
  thinking?: AgentThinkingLevel;
  /**
   * Persistent session to continue (M7). Absent → the server's current
   * session (created on demand). The web UI always sends an explicit id.
   */
  sessionId?: string;
}

/** Response from POST /api/agent/undo */
export type AgentUndoResponse =
  | { ok: true; restored: string[] }        // paths relative to graphsRoot
  | { ok: false; reason: 'nothing-to-undo' };
  // NOTE: the streaming-conflict case is returned as HTTP 409 { error: string }
  // (not as AgentUndoResponse), so 'streaming' is not a valid reason variant here.

/** Response from POST /api/agent/reset */
export interface AgentResetResponse {
  ok: true;
}

/**
 * Response from POST /api/agent/test — verifies the SAVED LLM config by
 * sending one minimal request. Never contains the apiKey.
 */
export type AgentTestResponse =
  | { ok: true; model: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// M7: persistent sessions — GET/POST /api/agent/sessions, GET/DELETE .../:id
// ---------------------------------------------------------------------------

/** One session row in GET /api/agent/sessions (sorted by updatedAt desc). */
export interface AgentSessionMeta {
  id: string;
  title: string;
  createdAt: string;   // ISO timestamp
  updatedAt: string;   // ISO timestamp
  ueVersion: string;
  totalTokens: number;
  /** Completed user turns. */
  turns: number;
}

/**
 * Replayable conversation log: the user's messages plus every SSE event the
 * turn emitted (consecutive text/thinking events are coalesced on persist).
 * The provider-neutral message history stays server-side and is never sent.
 */
export type AgentTranscriptEntry =
  | { kind: 'user'; text: string }
  | { kind: 'event'; event: AgentSseEvent };

/** Response from GET /api/agent/sessions/:id */
export interface AgentSessionDetail {
  id: string;
  title: string;
  ueVersion: string;
  totalTokens: number;
  transcript: AgentTranscriptEntry[];
}

/** Response from GET /api/agent/sessions */
export interface AgentSessionsListResponse {
  sessions: AgentSessionMeta[];
}

/** Response from POST /api/agent/sessions */
export interface AgentSessionCreateResponse {
  id: string;
}

// ---------------------------------------------------------------------------
// M5: POST /api/agent/explain — one-shot LLM node explanation
// ---------------------------------------------------------------------------

/** Body for POST /api/agent/explain */
export interface AgentExplainRequest {
  nodeType: string;
  ueVersion?: string;
  /** Path to a .matgraph.json file relative to graphs/ (optional, for connection context). */
  graphPath?: string;
  /** Node id within the graph (optional, used with graphPath). */
  nodeId?: string;
}

/** Response from POST /api/agent/explain */
export type AgentExplainResponse =
  | { ok: true; text: string }
  | { ok: false; error: string };

// web/src/agent/protocol.ts — browser-side mirror of server/agent/agent-types.ts.
// Keep these two files in sync exactly (same discipline as ws-protocol.ts ↔ protocol.ts).
// Must NOT import node: modules.
//
// Also mirrors ProviderStatus from server/agent/provider/types.ts — web code must
// import this type from here, never from the server module tree.

/**
 * Events streamed from POST /api/agent/chat as SSE.
 * Each event maps to a `data: <JSON>\n\n` SSE line.
 */
export type AgentSseEvent =
  | { type: 'text'; text: string }                                   // narrative text (streamed char-by-char)
  | { type: 'tool_start'; name: string; summary: string }            // human-readable step line
  | { type: 'tool_end'; name: string; ok: boolean; summary?: string }
  | { type: 'diff'; lines: string[] }                                // plain-language diff (after successful write)
  | { type: 'graph_written'; path: string }                          // UI can auto-open this file
  | { type: 'usage'; inputTokens: number; outputTokens: number; estimated: boolean }
  | { type: 'limit'; kind: 'iters' | 'cost'; message: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

/** Body for POST /api/agent/chat */
export interface AgentChatRequest {
  text: string;
  ueVersion?: string;
  graphPath?: string;
}

/**
 * Shape returned by GET /api/agent/status.
 * apiKey must NEVER appear here — mirrored from server/agent/provider/types.ts.
 * hasApiKey only reports whether a key is stored; baseUrl is user-entered, not secret.
 */
export interface ProviderStatus {
  configured: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
  hasApiKey?: boolean;
}

/** Response from POST /api/agent/undo — mirrored from server/agent/agent-types.ts */
export type AgentUndoResponse =
  | { ok: true; restored: string[] }        // paths relative to graphsRoot
  | { ok: false; reason: 'nothing-to-undo' };
  // NOTE: the streaming-conflict case is returned as HTTP 409 { error: string }
  // (not as AgentUndoResponse), so 'streaming' is not a valid reason variant here.

/** Response from POST /api/agent/reset — mirrored from server/agent/agent-types.ts */
export interface AgentResetResponse {
  ok: true;
}

/**
 * Response from POST /api/agent/test — mirrored from server/agent/agent-types.ts.
 * Verifies the SAVED LLM config by sending one minimal request. Never contains the apiKey.
 */
export type AgentTestResponse =
  | { ok: true; model: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// M5: POST /api/agent/explain — one-shot LLM node explanation
// ---------------------------------------------------------------------------

/** Body for POST /api/agent/explain — mirrored from server/agent/agent-types.ts */
export interface AgentExplainRequest {
  nodeType: string;
  ueVersion?: string;
  /** Path to a .matgraph.json file relative to graphs/ (optional, for connection context). */
  graphPath?: string;
  /** Node id within the graph (optional, used with graphPath). */
  nodeId?: string;
}

/** Response from POST /api/agent/explain — mirrored from server/agent/agent-types.ts */
export type AgentExplainResponse =
  | { ok: true; text: string }
  | { ok: false; error: string };

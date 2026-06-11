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
 */
export interface ProviderStatus {
  configured: boolean;
  provider?: string;
  model?: string;
}

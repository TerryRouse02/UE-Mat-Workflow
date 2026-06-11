// server/agent/agent-types.ts — node-free wire types for the agent layer.
// Mirrored in web/src/agent/protocol.ts — keep both in sync.
// Must NOT import node: modules (shared discipline with crawl-types.ts).

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

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
  | { type: 'thinking'; text: string }                               // model reasoning stream (display only)
  | { type: 'tool_start'; name: string; summary: string }            // human-readable step line
  | { type: 'tool_end'; name: string; ok: boolean; summary?: string }
  | { type: 'diff'; lines: string[] }                                // plain-language diff (after successful write)
  | { type: 'graph_written'; path: string; changedNodeIds?: string[] } // UI auto-opens + highlights the changed nodes
  | { type: 'export_request'; path: string }                         // UI copies this graph to the clipboard as UE T3D
  | { type: 'crawl_proposal'; kind: 'workmf' | 'projectmat'; contentRoot: string; pendingApproval?: boolean } // UI shows a confirm card; user approves via POST /api/crawl
  | { type: 'db_edit_proposal'; nodeName: string; ueVersion: string; create: boolean; patch: Record<string, unknown>; rationale: string; pendingApproval?: boolean } // UI shows a confirm card; user approves via POST /api/agent/db-edit
  | { type: 'usage'; inputTokens: number; outputTokens: number; estimated: boolean; cachedTokens?: number } // cachedTokens = prompt-cache hits within inputTokens (billed ~10%)
  | { type: 'approval_request'; id: string; mode: 'review' | 'auto'; tool: string; path?: string; summary: string; diff?: string[] } // the turn paused before a mutating op — review: OWNER approves (POST /api/agent/approve); auto: an LLM judge decides (no buttons)
  | { type: 'approval_resolved'; id: string; decision: 'approved' | 'rejected' | 'timeout'; reason?: string } // outcome of the matching approval_request (persisted so replay shows the resolved card)
  | { type: 'compacted'; message: string }                           // old turns summarized into session memory
  | { type: 'notice'; text: string }                                 // transient system note (e.g. retrying after a provider hiccup, wrap-up self-check)
  | { type: 'limit'; kind: 'iters' | 'cost' | 'failures'; message: string }
  | { type: 'session_closed'; message: string }                      // off-topic strike limit — server deletes the session after the stream
  | { type: 'error'; message: string }
  | { type: 'done' };

/** Reasoning-effort level selectable per user turn. */
export type AgentThinkingLevel = 'off' | 'low' | 'medium' | 'high';

/** Body for POST /api/agent/chat */
export interface AgentChatRequest {
  text: string;
  ueVersion?: string;
  graphPath?: string;
  /** Canvas node the user has selected — joined with graphPath into the
      ［視窗情境］ context block appended to the user message. */
  selectedNodeId?: string;
  thinking?: AgentThinkingLevel;
  /**
   * Pasted images (max 3): base64 WITHOUT the data: prefix, mediaType one of
   * image/png|jpeg|webp|gif, ≤5MB decoded each. Needs a vision-capable model.
   */
  images?: Array<{ mediaType: string; data: string }>;
  /**
   * Per-turn 🌐 switch. Absent/true = web tools available (the prompt tells
   * the model to self-check timeliness before answering); false = web_search/
   * web_fetch removed from the tool list and refused at dispatch.
   */
  webSearch?: boolean;
  /**
   * Persistent session to continue (M7). Absent → the server's current
   * session (created on demand). The web UI always sends an explicit id.
   */
  sessionId?: string;
  /**
   * UI language the agent should reply in. Absent → 'zh-Hant' (server default).
   * Mirrors the user's effective language (localStorage 'ui-language' or team default).
   */
  language?: 'zh-Hant' | 'en';
  /**
   * Write-approval mode for THIS turn (per-turn, like the 🌐 / thinking knobs).
   * - 'review' (default): every mutating tool call pauses for the session OWNER
   *   to approve via POST /api/agent/approve.
   * - 'skip': no gate — writes apply immediately.
   * - 'auto': an LLM judge decides (reflect-and-retry on reject, capped).
   * The web UI sends 'review' by default; a MISSING field is treated as skip
   * server-side (only explicit 'review'/'auto' arms the gate).
   */
  approvalMode?: 'skip' | 'review' | 'auto';
}

/** Body for POST /api/agent/approve — mirrored from server/agent/agent-types.ts */
export interface AgentApproveRequest {
  sessionId: string;
  requestId: string;
  decision: 'approve' | 'reject';
  reason?: string;
}

/** Response from POST /api/agent/approve — mirrored from server/agent/agent-types.ts */
export type AgentApproveResponse =
  | { ok: true }
  | { ok: false; error: string };

/** Response from POST /api/agent/web-test — mirrored from server/agent/agent-types.ts */
export type AgentWebTestResponse =
  | { ok: true; backend: string; results: number }
  | { ok: false; error: string };

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
  /** Agent-loop iteration ceiling per user turn. 0 = unlimited. Absent → default (8). */
  maxIters?: number;
  /** Model context window in tokens (drives compaction + token ceiling). Absent → defaults. */
  contextLimit?: number;
  // ── Web search settings (local.config.json `Web`) — keys are never echoed ──
  /** Stored backend choice ('auto' when unset). */
  webSearchBackend?: string;
  hasTavilyKey?: boolean;
  hasBraveKey?: boolean;
  /** User-entered, not secret (like baseUrl). */
  searxngBaseUrl?: string;
  /** User-entered local proxy, not secret. */
  webProxyUrl?: string;
}

/** Response from POST /api/agent/undo — mirrored from server/agent/agent-types.ts */
export type AgentUndoResponse =
  | { ok: true; restored: string[]; canUndo: boolean; canRedo: boolean }  // paths relative to graphsRoot
  | { ok: false; reason: 'nothing-to-undo' };
  // NOTE: the streaming-conflict case is returned as HTTP 409 { error: string }
  // (not as AgentUndoResponse), so 'streaming' is not a valid reason variant here.

/** Response from POST /api/agent/redo — mirrored from server/agent/agent-types.ts */
export type AgentRedoResponse =
  | { ok: true; redone: string[]; canUndo: boolean; canRedo: boolean }   // paths relative to graphsRoot
  | { ok: false; reason: 'nothing-to-redo' };

/** Response from POST /api/agent/reset — mirrored from server/agent/agent-types.ts */
export interface AgentResetResponse {
  ok: true;
}

/**
 * Response from POST /api/agent/regenerate — mirrored from server/agent/agent-types.ts.
 * Rewinds the last user turn (files + history + transcript) and returns the user
 * text so the client re-sends it through the normal chat flow.
 */
export type AgentRegenerateResponse =
  | { ok: true; text: string }
  | { ok: false; reason: 'nothing-to-regenerate' };

/**
 * Body for POST /api/agent/db-edit — mirrored from server/agent/agent-types.ts.
 * The user-approval side of an agent db_edit_proposal.
 */
export interface AgentDbEditRequest {
  ueVersion: string;
  nodeName: string;
  patch: Record<string, unknown>;
  /** true = add a NEW provisional node (verified:false enforced server-side). */
  create?: boolean;
}

/** Response from POST /api/agent/db-edit — mirrored from server/agent/agent-types.ts */
export type AgentDbEditResponse =
  | { ok: true; changedKeys: string[] }
  | { ok: false; error: string };

/**
 * Response from POST /api/agent/test — mirrored from server/agent/agent-types.ts.
 * Verifies the SAVED LLM config by sending one minimal request. Never contains the apiKey.
 */
export type AgentTestResponse =
  | { ok: true; model: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// M7: persistent sessions — mirrored from server/agent/agent-types.ts
// ---------------------------------------------------------------------------

/** One session row in GET /api/agent/sessions (sorted by updatedAt desc). */
export interface AgentSessionMeta {
  id: string;
  title: string;
  createdAt: string;   // ISO timestamp
  updatedAt: string;   // ISO timestamp
  ueVersion: string;
  /** Team mode: owning username (admins see everyone's sessions). */
  owner?: string;
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
  | { kind: 'user'; text: string; images?: number } // images = attached-image count (data not replayed)
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

/**
 * Response from GET /api/agent/public-session (readable by every team member).
 * id === null means no announcement session is designated.
 */
export interface AgentPublicSessionResponse {
  id: string | null;
  title?: string;
  ueVersion?: string;
  updatedAt?: string;
  /** True while the admin's chat on this session is still streaming. */
  streaming?: boolean;
  transcript?: AgentTranscriptEntry[];
}

/** Response from POST /api/agent/sessions */
export interface AgentSessionCreateResponse {
  id: string;
}

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
  /** UI language the explanation should be written in. Absent → 'zh-Hant'. */
  language?: 'zh-Hant' | 'en';
}

/** Response from POST /api/agent/explain — mirrored from server/agent/agent-types.ts */
export type AgentExplainResponse =
  | { ok: true; text: string }
  | { ok: false; error: string };

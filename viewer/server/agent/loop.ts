// server/agent/loop.ts — agent loop for the material agent.
//
// runAgent() drives one user turn through the tool-calling loop:
//   1. Append user message.
//   2. Stream from provider; collect assistant turn.
//   3. If the response contains tool_use blocks, dispatch them.
//   4. Append tool_results and loop up to MAX_ITERS.
//   5. Emit AgentSseEvent items via the emit callback throughout.
//
// Invariants:
//   - MAX_ITERS = 8 hard ceiling.
//   - The context ceiling (default TOKEN_CEILING = 300_000) compares
//     session.contextTokens — the LAST provider round's input+output, i.e. the
//     real context size. totalTokens (cumulative spend) is display-only.
//     When usage data is absent, fall back to chars/4 estimation.
//   - Loop emits a graceful 'limit' event rather than crashing on ceiling hit.
//   - Raw validation errors never reach the user directly; they go to
//     tool_result for the model to self-correct.
//   - Before every write, checkpoint.snapshotFile() is called via
//     ctx.beforeWrite (injected by the caller via ToolContext).

import type { Provider, Message, ToolUseBlock, ToolResultBlock, ContentBlock, StreamEvent, ThinkingLevel } from './provider/types.js';
import { toolDefs, dispatchTool, type ToolContext } from './tools.js';
import type { AgentSseEvent } from './agent-types.js';
import { buildSystemPrompt } from './prompt.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard ceiling on agent iterations per user turn. */
export const MAX_ITERS = 8;

/**
 * Default context-size ceiling (compared against session.contextTokens).
 * When usage is absent (some compat providers skip it), we estimate via chars/4.
 */
export const TOKEN_CEILING = 300_000;

/**
 * Compaction (M11-1): when the CURRENT context (session.contextTokens) crosses
 * this mark at the start of a user turn, old turns are summarized into session
 * memory and trimmed from the history so long conversations keep headroom
 * instead of dying at the ceiling.
 */
export const COMPACT_THRESHOLD = 150_000;
/** Most recent user turns kept verbatim by compaction. */
export const COMPACT_KEEP_TURNS = 4;

/**
 * Marker prefix of the viewport-context text blocks that older sessions carry
 * in their history. The per-message injection is GONE — it biased the model
 * into treating the open graph as the operation target (a「建立」request would
 * modify the open file); viewport state is now pulled on demand via the
 * get_viewport tool (ToolContext.viewport). The prefix is kept so regenerate
 * can still strip legacy blocks out of pre-existing session files.
 */
export const VIEW_CONTEXT_PREFIX = '［視窗情境］';

/** Consecutive failed write/patch attempts on the SAME file before the loop
    stops and asks the user instead of burning tokens (BUG-4 circuit breaker). */
export const WRITE_FAIL_BREAKER = 3;
/** Consecutive failed compact_context attempts before the loop stops. */
export const COMPACT_FAIL_BREAKER = 2;
/** Off-topic strikes (report_off_topic calls) before the session is closed
    and deleted: 1 = remind, 2 = refuse + warn, 3 = close. Per-session,
    cumulative (persisted), never reset by on-topic messages. */
export const OFF_TOPIC_LIMIT = 3;

/**
 * Transient provider failures (HTTP 429 / 5xx / 529 overloaded, network resets)
 * are retried up to this many times — but ONLY when the failed round streamed
 * NOTHING yet (no text/tool_use/usage), so a retry can never duplicate output
 * already shown to the user. A mid-stream error is surfaced, not retried.
 */
export const STREAM_MAX_RETRIES = 2;
/** Base backoff (ms) between stream retries; doubles each attempt (1s, 2s). */
export const STREAM_RETRY_BASE_MS = 1000;

/**
 * Consecutive iterations in which EVERY data tool call was a duplicate of one
 * already made since the last write (no fresh read, no write) before the loop
 * stops on a no-progress circuit breaker. Guards `maxIters:0` (unlimited) runs
 * against a model that spins on the same lookups; bounded runs are also capped
 * by MAX_ITERS. Duplicate detection is non-destructive (it only feeds this
 * counter — a repeated call still executes and returns real data).
 */
export const NOPROGRESS_BREAKER = 3;

/**
 * Tools that only read (no writes, no session mutation, no UI fan-out) — a
 * contiguous run of these in one assistant turn is dispatched CONCURRENTLY
 * (B: parallel read-only). Anything not listed here (writes, proposals,
 * compact_context, report_off_topic) stays sequential and acts as a barrier.
 */
const READONLY_TOOLS = new Set([
  'search_nodes', 'get_node_signature', 'get_mf_signature', 'read_graph',
  'validate_graph', 'get_graph_errors', 'list_graphs', 'get_viewport',
  'search_mf', 'list_examples', 'read_example', 'read_memory', 'read_crawl_log',
  'web_search', 'web_fetch',
]);

/** Tools that write a graph file — feed the same-file failure circuit breaker. */
const WRITE_TOOL_NAMES = new Set(['write_graph', 'patch_graph']);

/**
 * Every graph-mutating tool — gated behind the write-approval hook (review
 * mode) when `RunAgentOptions.requestApproval` is supplied. Superset of
 * WRITE_TOOL_NAMES (which only feeds the validation circuit breaker).
 */
const MUTATING_TOOLS = new Set(['write_graph', 'patch_graph', 'rename_graph', 'delete_graph']);

/**
 * Whether a provider error message is worth retrying. HTTP 408/409/425/429 and
 * any 5xx (incl. Anthropic's 529 overloaded) are transient; 4xx like 400/401/403/
 * 404 are caller/config errors and retrying only wastes time. Thrown fetch/network
 * errors (no HTTP prefix) are matched by phrase.
 */
export function isRetryableStreamError(message: string): boolean {
  const httpMatch = /^HTTP (\d{3})/i.exec(message);
  if (httpMatch) {
    const code = Number(httpMatch[1]);
    return code === 408 || code === 409 || code === 425 || code === 429 || (code >= 500 && code <= 599);
  }
  return /(overloaded|rate.?limit|timed?.?out|econnreset|etimedout|eai_again|socket hang up|fetch failed|network error)/i.test(message);
}

/** Abortable delay — resolves immediately if the signal is (or becomes) aborted. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((res) => {
    const onAbort = (): void => finish();
    const t = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      res();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Session type (server-side only)
// ---------------------------------------------------------------------------

export interface AgentLoopSession {
  id: string;
  ueVersion: string;
  graphPath?: string;
  /** Accumulated conversation turns. */
  messages: Message[];
  /**
   * Cumulative spend across the session (input + output of EVERY provider
   * round, estimated when necessary). Display/accounting only — each round's
   * input re-counts the full history, so this grows far faster than the
   * actual context and must never gate compaction or the window ceiling.
   */
  totalTokens: number;
  /**
   * Current context size: the LAST provider round's input + output (the input
   * already covers system prompt + full history). This is what compaction and
   * the contextLimit ceiling compare against.
   */
  contextTokens: number;
  /**
   * Monotonic user-turn counter. Checkpoint turn ids are derived from it and
   * must never repeat across runAgent calls — a reused id makes the checkpoint
   * store skip pre-images it has already seen, so undo would restore a state
   * older than the previous turn.
   */
  turnSeq: number;
  /**
   * Cumulative off-topic strikes (report_off_topic calls) this session.
   * Persisted; at OFF_TOPIC_LIMIT the loop emits session_closed and the
   * http layer deletes the session.
   */
  offTopicStrikes: number;
}

export function createSession(id: string, ueVersion: string, graphPath?: string): AgentLoopSession {
  return {
    id,
    ueVersion,
    graphPath,
    messages: [],
    totalTokens: 0,
    contextTokens: 0,
    turnSeq: 0,
    offTopicStrikes: 0,
  };
}

/**
 * Record one off-topic strike and return the tool_result instruction for the
 * model. Strikes 1/2 tell the model what to say; strike 3's content is mostly
 * ceremonial — the loop terminates right after the results are appended and
 * the http layer deletes the session.
 */
function offTopicStrike(session: AgentLoopSession, lang: 'zh-Hant' | 'en'): { content: string; isError?: boolean } {
  session.offTopicStrikes += 1;
  const n = session.offTopicStrikes;
  if (lang === 'en') {
    if (n === 1) {
      return {
        content:
          'Off-topic strike 1. Gently remind the user that you only help with UE ' +
          'materials/shaders/game development, and ask them to return to the topic. ' +
          'Do not answer the off-topic content itself.',
      };
    }
    if (n === 2) {
      return {
        content:
          'Off-topic strike 2. Refuse to answer this question (one sentence), and ' +
          'clearly warn the user: one more off-topic message and this session will be ' +
          'closed and deleted.',
      };
    }
    return { content: `Off-topic strike ${n}. The session is about to be closed and deleted; do not produce any further response.` };
  }
  if (n === 1) {
    return {
      content:
        '第 1 次離題。請友善提醒使用者：你只協助 UE 材質／shader／遊戲開發相關話題，' +
        '請對方回到主題。不要回答離題內容本身。',
    };
  }
  if (n === 2) {
    return {
      content:
        '第 2 次離題。請直接拒絕回答這個問題（一句話即可），並明確警告使用者：' +
        '再有一次離題訊息，本會話將被關閉並刪除。',
    };
  }
  return { content: `第 ${n} 次離題。會話即將被關閉並刪除，不要再產生任何回應。` };
}

// ---------------------------------------------------------------------------
// Emit helper type
// ---------------------------------------------------------------------------

export type EmitFn = (event: AgentSseEvent) => void;

/** What the owner is asked to approve before a mutating tool runs (review mode). */
export interface ApprovalRequestInfo {
  /** Correlates the approval_request event with the awaiting hook + POST /api/agent/approve. */
  id: string;
  tool: string;
  path?: string;
  /** One-line zh-TW/en summary of the pending change. */
  summary: string;
  /** Plain-language diff lines (patch_graph) or a node summary (write_graph). */
  diff?: string[];
}

/** The owner's decision delivered back to the loop (via POST /api/agent/approve). */
export interface ApprovalDecision {
  approved: boolean;
  /** 'timeout' / 'aborted' are synthetic; any other value is the user's note. */
  reason?: string;
}

/**
 * Write-approval hook (review mode). Supplied by the caller; the loop calls it
 * before each graph-mutating tool (write/patch/rename/delete) and only writes
 * on approval. Absent → no gate (the pre-approval「skip」behavior, which is what
 * every existing caller and the eval corpus get).
 */
export type RequestApprovalFn = (info: ApprovalRequestInfo) => Promise<ApprovalDecision>;

/**
 * Map a successful tool result to its UI fan-out events: plain-language diff
 * lines, graph_written (writes/rename), and the viewer-action signals for
 * clipboard export and crawl / DB-edit proposals. dryRun results write nothing,
 * so their diff/graph_written fan-out is suppressed. Pure (no session state) so
 * it can be shared by the sequential and concurrent dispatch paths.
 */
function fanOutToolResult(
  call: ToolUseBlock,
  content: string,
  emit: EmitFn,
  fallbackUeVersion: string,
): void {
  const inp = call.input as Record<string, unknown>;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    // Non-JSON result — nothing to fan out.
    return;
  }

  if (parsed.ok && !parsed.dryRun && Array.isArray(parsed.diff) && parsed.diff.length > 0) {
    emit({ type: 'diff', lines: parsed.diff as string[] });
  }

  if (WRITE_TOOL_NAMES.has(call.name) && !parsed.dryRun && typeof inp.path === 'string') {
    const changedNodeIds =
      Array.isArray(parsed.changedNodeIds) && parsed.changedNodeIds.length > 0
        ? (parsed.changedNodeIds as unknown[]).map(String)
        : undefined;
    // Prefer the tool-reported path: write_graph may reroute a member's
    // new graph into their personal workspace (users/<name>/...).
    const writtenPath = typeof parsed.path === 'string' && parsed.path ? parsed.path : inp.path;
    emit({ type: 'graph_written', path: writtenPath, changedNodeIds });
  }
  if (call.name === 'rename_graph' && parsed.ok && typeof parsed.to === 'string') {
    emit({ type: 'graph_written', path: parsed.to });
  }
  if (call.name === 'export_to_clipboard' && parsed.ok && typeof parsed.path === 'string') {
    emit({ type: 'export_request', path: parsed.path });
  }
  if (call.name === 'request_crawl' && parsed.ok && (parsed.kind === 'workmf' || parsed.kind === 'projectmat')) {
    emit({
      type: 'crawl_proposal',
      kind: parsed.kind,
      contentRoot: typeof parsed.contentRoot === 'string' ? parsed.contentRoot : '/Game',
    });
  }
  if (call.name === 'propose_db_edit' && parsed.ok && typeof parsed.nodeName === 'string') {
    emit({
      type: 'db_edit_proposal',
      nodeName: parsed.nodeName,
      ueVersion: typeof parsed.ueVersion === 'string' ? parsed.ueVersion : fallbackUeVersion,
      create: parsed.create === true,
      patch: (parsed.patch && typeof parsed.patch === 'object' ? parsed.patch : {}) as Record<string, unknown>,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
    });
  }
}

/** Pull the plain-language `diff` array out of a tool result, if present. */
function parseDiffLines(content: string): string[] | undefined {
  try {
    const j = JSON.parse(content) as { diff?: unknown };
    if (Array.isArray(j.diff) && j.diff.length > 0) return j.diff.map(String);
  } catch { /* non-JSON */ }
  return undefined;
}

/**
 * Preview lines for a write_graph approval card: the changed nodes (from the
 * dry-run's changedNodeIds, falling back to all nodes) as `id（type）`, capped.
 * Language-neutral node identifiers — the localized headline rides in `summary`.
 */
function writeGraphNodeLines(graphInput: unknown, dryContent: string): string[] | undefined {
  let changed: Set<string> | null = null;
  try {
    const j = JSON.parse(dryContent) as { changedNodeIds?: unknown };
    if (Array.isArray(j.changedNodeIds)) changed = new Set(j.changedNodeIds.map(String));
  } catch { /* non-JSON */ }
  const g = graphInput as { nodes?: Array<{ id?: unknown; type?: unknown }> } | null;
  if (!g || !Array.isArray(g.nodes)) return undefined;
  const nodes = changed ? g.nodes.filter(n => changed!.has(String(n.id))) : g.nodes;
  const CAP = 14;
  const lines = nodes.slice(0, CAP).map(n => `${String(n.id)}（${String(n.type)}）`);
  if (nodes.length > CAP) lines.push(`…+${nodes.length - CAP}`);
  return lines.length > 0 ? lines : undefined;
}

/**
 * The tool_result a model sees when the owner rejects (or lets time out) a
 * mutating op in review mode. Steers it to STOP and ask, never to retry the
 * write — the soft-stop the user asked for (an explicit reason is woven in).
 */
function approvalRejectionMessage(reason: string | undefined, lang: 'zh-Hant' | 'en'): string {
  if (reason === 'timeout') {
    return lang === 'en'
      ? 'The user did not respond to the approval request in time, so this change was auto-cancelled. Briefly tell the user and ask how they want to proceed — do not retry automatically.'
      : '使用者未在時限內回應批准請求，本次變更已自動取消。請簡短告知使用者並詢問下一步，不要自動重試。';
  }
  if (reason === 'aborted') {
    return lang === 'en' ? 'The user cancelled the operation.' : '使用者取消了操作。';
  }
  const note = reason && reason.trim()
    ? (lang === 'en' ? ` Reason: ${reason.trim()}` : `（理由：${reason.trim()}）`)
    : '';
  return lang === 'en'
    ? `The user REJECTED this change.${note} Do NOT retry this write. Briefly explain to the user and ask what they would like to adjust.`
    : `使用者拒絕了這次修改${note}。請勿重試這次寫入，改為向使用者簡短說明並詢問他們想怎麼調整。`;
}

/**
 * Wrap-up self-check (#1, mechanizes prompt rule 19). Re-reads each graph
 * written this turn and collects OBJECTIVE completeness issues: validation
 * errors (impossible past the write gate, kept for robustness), unresolved
 * Material Function pins, and a Material whose MaterialOutput has nothing wired
 * into it (outputs nothing). Returns a corrective nudge string, or null when
 * everything is clean. Subjective "does it match the request" stays with the
 * model (rule 19); this only catches what is mechanically verifiable.
 */
async function runWrapUpSelfCheck(
  paths: Set<string>,
  turnCtx: ToolContext,
  lang: 'zh-Hant' | 'en',
): Promise<string | null> {
  const fileIssues: string[] = [];
  for (const path of paths) {
    let parsed: { graph?: unknown; errors?: unknown; unresolvedMfPins?: unknown };
    try {
      const r = await dispatchTool('read_graph', { path }, turnCtx);
      if (r.isError) continue; // unreadable (e.g. renamed/deleted after) — skip
      parsed = JSON.parse(r.content) as typeof parsed;
    } catch {
      continue;
    }
    const issues: string[] = [];
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      issues.push(...parsed.errors.map(String));
    }
    if (Array.isArray(parsed.unresolvedMfPins) && parsed.unresolvedMfPins.length > 0) {
      issues.push((lang === 'en' ? 'unresolved Material Function pins: ' : '未解析的 MF 針腳：') +
        parsed.unresolvedMfPins.map(String).join('; '));
    }
    const g = parsed.graph as { type?: unknown; nodes?: unknown; connections?: unknown } | undefined;
    if (g && g.type === 'Material' && Array.isArray(g.nodes) && Array.isArray(g.connections)) {
      const moIds = (g.nodes as Array<{ id?: unknown; type?: unknown }>)
        .filter(n => n.type === 'MaterialOutput')
        .map(n => String(n.id));
      if (moIds.length > 0) {
        const wired = (g.connections as Array<{ to?: unknown }>)
          .some(c => moIds.some(id => String(c.to).startsWith(id + ':')));
        if (!wired) {
          issues.push(lang === 'en'
            ? 'nothing is connected to MaterialOutput (the material outputs nothing)'
            : '沒有任何連線接到 MaterialOutput（材質沒有輸出）');
        }
      }
    }
    if (issues.length > 0) fileIssues.push(`「${path}」：${issues.join('；')}`);
  }

  if (fileIssues.length === 0) return null;
  const head = lang === 'en'
    ? '(System wrap-up check) You said you were done, but the final graph still has issues to fix or explain to the user:'
    : '（系統收尾檢查）你剛表示完成，但最終的圖還有以下問題要先處理或向使用者說明：';
  const tail = lang === 'en'
    ? 'Fix them, or clearly tell the user why they are intentional.'
    : '請修正後再結束；若是刻意如此，請明確向使用者說明原因。';
  return `${head}\n${fileIssues.map(s => `- ${s}`).join('\n')}\n${tail}`;
}

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

/** Optional overrides for limits — useful so tests can use tiny ceilings. */
export interface RunAgentOptions {
  /**
   * Override MAX_ITERS for this call (default: MAX_ITERS = 8).
   * 0 means "unlimited" — the loop converts it to MAX_SAFE_INTEGER itself
   * (callers must NOT pre-convert); the token ceiling and the consecutive-
   * failure breakers still bound an unlimited run.
   */
  maxIters?: number;
  /** Override TOKEN_CEILING for this call (default: TOKEN_CEILING = 300_000). */
  tokenCeiling?: number;
  /**
   * maxTokens to send in each ChatRequest.
   * Flows from LLMConfig.maxTokens via the http-server chat handler.
   * Defaults to 8192 when absent.
   */
  maxTokens?: number;
  /**
   * Reasoning-effort level for this user turn (AgentChatRequest.thinking).
   * Passed through to every ChatRequest of the turn; adapters map it to
   * their dialect. 'off'/undefined sends no thinking parameter.
   */
  thinking?: ThinkingLevel;
  /** Override COMPACT_THRESHOLD (tests use tiny values). */
  compactThreshold?: number;
  /** Override COMPACT_KEEP_TURNS. */
  compactKeepTurns?: number;
  /** Override STREAM_RETRY_BASE_MS (tests pass 0 to avoid real backoff waits). */
  retryBaseMs?: number;
  /**
   * Wrap-up self-check (mechanizes prompt rule 19). When true, the moment the
   * model tries to FINISH (a turn that wrote graphs but the assistant produced
   * no further tool calls), the final state of each written graph is
   * re-validated; objective issues (errors — impossible past the write gate —
   * unresolved MF pins, or a Material whose MaterialOutput has nothing wired
   * into it) inject ONE corrective nudge so the model fixes it before ending.
   * Bounded to a single corrective round per turn. Off by default (so existing
   * callers/tests are unchanged); the http-server turns it on in production.
   */
  selfCheckOnFinish?: boolean;
  /**
   * Per-turn 🌐 switch (AgentChatRequest.webSearch; absent = true). false
   * removes web_search/web_fetch from the tool list the provider sees AND
   * refuses any stray call at dispatch — the model cannot reach the public
   * web this turn.
   */
  webToolsEnabled?: boolean;
  /**
   * Tools to withhold this turn (removed from the provider's tool list AND
   * refused at dispatch). Team members get ['request_crawl',
   * 'propose_db_edit'] — they cannot approve those cards anyway.
   */
  disabledTools?: string[];
  /**
   * User-attached images for THIS turn (AgentChatRequest.images — pasted
   * into the chat box). Prepended to the user message as neutral image
   * blocks; the http layer has already validated type/size/count.
   */
  images?: Array<{ mediaType: string; data: string }>;
  /**
   * Reply language for this user turn. Selects the system-prompt reply-language
   * directive AND localizes the user-facing SSE/system strings that appear in
   * the chat transcript (limit/abort/web-disabled/off-topic/circuit-breaker).
   * Default 'zh-Hant'; 'en' is opt-in. Tool-call names/fields stay English.
   */
  language?: 'zh-Hant' | 'en';
  /**
   * Write-approval gate (review mode). When supplied, every graph-mutating tool
   * (write_graph / patch_graph / rename_graph / delete_graph) pauses for this
   * hook before it runs: approved → the tool runs; rejected → the model gets a
   * "user rejected" tool_result and stops to ask, never writing. Absent → no
   * gate (skip mode — the pre-approval behavior). An invalid change (a patch/
   * write that fails the dry-run) is NEVER sent for approval — its validation
   * error goes straight back to the model so it self-corrects.
   */
  requestApproval?: RequestApprovalFn;
}

const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch']);

export async function runAgent(
  userText: string,
  session: AgentLoopSession,
  provider: Provider,
  /** Model identifier string passed through to ChatRequest.model. */
  model: string,
  ctx: ToolContext,
  emit: EmitFn,
  signal?: AbortSignal,
  options?: RunAgentOptions,
): Promise<void> {
  // 0 = unlimited lives HERE (single source of truth) — `??` alone would turn
  // an explicit 0 into a zero-iteration loop that ends silently.
  const maxIters = options?.maxIters === 0
    ? Number.MAX_SAFE_INTEGER
    : (options?.maxIters ?? MAX_ITERS);
  const tokenCeiling = options?.tokenCeiling ?? TOKEN_CEILING;
  const maxTokens = options?.maxTokens ?? 8192;
  const webEnabled = options?.webToolsEnabled !== false;
  // Reply language for this turn — gates the system-prompt directive AND every
  // user-facing transcript string emitted below. Default zh-Hant; en is opt-in.
  const replyLang: 'zh-Hant' | 'en' = options?.language === 'en' ? 'en' : 'zh-Hant';
  const disabledTools = new Set(options?.disabledTools ?? []);
  if (!webEnabled) for (const n of WEB_TOOL_NAMES) disabledTools.add(n);
  const compactThreshold = options?.compactThreshold ?? COMPACT_THRESHOLD;
  const compactKeepTurns = options?.compactKeepTurns ?? COMPACT_KEEP_TURNS;
  const retryBaseMs = options?.retryBaseMs ?? STREAM_RETRY_BASE_MS;
  const selfCheckOnFinish = options?.selfCheckOnFinish === true;
  const requestApproval = options?.requestApproval;

  // User-facing transcript strings — localized by replyLang.
  const ceilingMessage = (used: number): string =>
    replyLang === 'en'
      ? `Context token count (${Math.round(used)}) reached the limit of ${tokenCeiling}; stopping.`
      : `上下文 token 數（${Math.round(used)}）已達上限 ${tokenCeiling}，停止繼續。`;
  const turnToolDefs = toolDefs.filter(t => !disabledTools.has(t.name));

  // Compaction runs BEFORE the memory read so the freshly-written summary is
  // part of this turn's system prompt.
  await maybeCompact(
    session, provider, model, ctx, emit, signal,
    compactThreshold, compactKeepTurns, replyLang,
  );

  // Build system prompt (reads SPEC.md from disk at call time). Memory is
  // re-read every user turn so notes written mid-conversation take effect
  // on the next turn.
  const memory = ctx.memory
    ? { longterm: await ctx.memory.read('longterm'), session: await ctx.memory.read('session') }
    : undefined;
  // `let`: an in-loop auto-compaction (D) rebuilds it so the rest of the turn
  // can see the freshly-written summary.
  let system = await buildSystemPrompt(ctx.repoRoot, session.ueVersion, memory, { webTools: webEnabled, language: options?.language });

  // Append the new user message. If the previous turn ended with tool_results
  // (iter/cost ceiling or abort), the last message is already user-role —
  // append the text into it: Anthropic requires roles to strictly alternate,
  // so a second consecutive user message would fail the next request.
  // Images first, text last — matches both adapters' multimodal ordering.
  const userBlocks: ContentBlock[] = [
    ...(options?.images ?? []).map((im): ContentBlock => ({ type: 'image', mediaType: im.mediaType, data: im.data })),
    { type: 'text', text: userText },
  ];
  const lastMsg = session.messages.at(-1);
  if (lastMsg?.role === 'user') {
    lastMsg.content.push(...userBlocks);
  } else {
    session.messages.push({ role: 'user', content: userBlocks });
  }
  // Failed-turn rollback bookkeeping. If this turn produces NO assistant reply
  // — a non-vision model rejecting an attached image surfaces as a 4xx *error
  // event*, not a throw (see both provider adapters) — the user message just
  // appended, and its image blocks, must be peeled back off. Otherwise every
  // later turn re-sends the rejected content (session.messages is replayed
  // verbatim) and the model rejects it again forever: the session is wedged.
  // `assistantCommitted` flips the instant any assistant turn lands, which is
  // also the ONLY way tool_results get appended — so a false value at exit
  // guarantees nothing was added after our blocks and the peel-back is exact.
  const rollbackTarget = lastMsg?.role === 'user' ? lastMsg : null;
  const rollbackBlockCount = userBlocks.length;
  let assistantCommitted = false;
  // One checkpoint turn per user turn: every write made while serving this
  // user message shares the id, so a single undo reverts the whole exchange
  // (M4 「回上一步」 semantics).
  const turnId = `${session.id}-turn${session.turnSeq}`;
  session.turnSeq += 1;
  const turnCtx: ToolContext = ctx.beforeWrite
    ? {
        ...ctx,
        // Tools pass a placeholder turnId; substitute the real one here.
        beforeWrite: async (absPath: string, _placeholder: string) => {
          await ctx.beforeWrite!(absPath, turnId);
        },
      }
    : ctx;

  // Track whether a limit event has already been emitted so the post-loop check
  // does not fire a second (contradictory) limit when a cost-ceiling break exits
  // the loop while tool results are already appended.
  let limitEmitted = false;

  // Circuit breakers (BUG-4): an "unlimited" run must still stop when it is
  // demonstrably stuck — N consecutive failed writes to the SAME file, or
  // repeated failed compactions — instead of burning tokens until the ceiling.
  const writeFailCounts = new Map<string, number>();
  let compactFailCount = 0;
  let breakerMessage: string | null = null;
  // Set when an off-topic strike reaches OFF_TOPIC_LIMIT — terminate after the
  // tool results land (the http layer deletes the session on session_closed).
  let offTopicClosed = false;
  // No-progress breaker: signatures of data tool calls seen since the last
  // write (a write changes the world, so it clears the set and prior reads are
  // no longer "stale repeats"); consecutive all-duplicate iterations accumulate.
  const seenSignatures = new Set<string>();
  let allDuplicateStreak = 0;
  // Off-topic strikes count at most once per user turn (a model emitting
  // report_off_topic twice in one turn must not double-strike).
  let offTopicReportedThisTurn = false;
  // Wrap-up self-check (#1): relative paths written this turn + a once-per-turn
  // guard so the corrective nudge can fire at most once.
  const turnWrittenPaths = new Set<string>();
  let selfCheckDone = false;

  // Once an in-loop auto-compaction reports it cannot help, stop retrying it
  // every iteration (avoids busy no-op summarizer calls); the ceiling still guards.
  let autoCompactBlocked = false;

  // Stream one provider round into an assistant turn. Returns the collected
  // content plus an error (yielded OR thrown) and whether anything streamed —
  // the retry driver only retries when NOTHING streamed yet, so a retry can
  // never duplicate text/tool_use already shown to the user.
  const streamRound = async (): Promise<{
    assistantContent: ContentBlock[];
    toolUses: ToolUseBlock[];
    errorMsg: string | null;
    sawAnyEvent: boolean;
    usageEmitted: boolean;
    outputCharEstimate: number;
  }> => {
    const assistantContent: ContentBlock[] = [];
    const toolUses: ToolUseBlock[] = [];
    let outputCharEstimate = 0;
    let usageEmitted = false;
    let errorMsg: string | null = null;
    let sawAnyEvent = false;
    try {
      const streamIter = provider.stream({
        model, messages: session.messages, system, tools: turnToolDefs,
        maxTokens, thinking: options?.thinking, signal,
      });
      for await (const event of streamIter) {
        if (signal?.aborted) break;
        if (event.type === 'error') { errorMsg = event.message; continue; }
        // Set AFTER the error check: an HTTP-level failure (e.g. 529 overloaded)
        // yields ONLY an error, so sawAnyEvent must stay false to be retryable.
        sawAnyEvent = true;
        await handleStreamEvent(
          event, assistantContent, toolUses, emit, session,
          (est) => { outputCharEstimate += est; },
          () => { usageEmitted = true; },
        );
      }
    } catch (e) {
      // A thrown provider/network error (fetch reject) — same retry rules.
      if (!signal?.aborted) errorMsg = e instanceof Error ? e.message : String(e);
    }
    return { assistantContent, toolUses, errorMsg, sawAnyEvent, usageEmitted, outputCharEstimate };
  };

  // Apply the per-turn 🌐 / permission gates, then dispatch. compact_context and
  // report_off_topic never reach here — the loop handles them inline (they need
  // the live session/provider).
  const dispatchGuarded = async (call: ToolUseBlock): Promise<{ content: string; isError?: boolean }> => {
    if (!webEnabled && WEB_TOOL_NAMES.has(call.name)) {
      return {
        content: replyLang === 'en'
          ? 'Web access has been turned off by the user (the 🌐 toggle next to the input box). Answer from the local node DB and existing knowledge, and clearly flag anything uncertain.'
          : '聯網功能已由使用者關閉（輸入框旁的 🌐 開關）。請基於本地節點 DB 與既有知識回答，不確定的部分明確說明。',
        isError: true,
      };
    }
    if (disabledTools.has(call.name)) {
      return { content: '此工具在目前的使用者權限下不可用，請改用其他方式完成任務或直接說明限制。', isError: true };
    }
    return dispatchTool(call.name, call.input, turnCtx);
  };

  // Write-approval gate (review mode). Preview the mutating change, ask the
  // session OWNER, and run the real tool only on approval. An invalid change
  // (dry-run fails) is returned to the model unchanged — never sent for
  // approval. Only called when requestApproval is supplied.
  const dispatchMutatingApproved = async (call: ToolUseBlock): Promise<{ content: string; isError?: boolean }> => {
    const inp = (call.input ?? {}) as Record<string, unknown>;
    const path = typeof inp.path === 'string' ? inp.path : undefined;
    let summary: string;
    let diff: string[] | undefined;

    if (call.name === 'patch_graph') {
      const dry = await dispatchTool('patch_graph', { ...inp, dryRun: true }, turnCtx);
      if (dry.isError) return dry; // invalid patch → model self-corrects, no prompt
      diff = parseDiffLines(dry.content);
      summary = replyLang === 'en' ? `Modify graph: ${path ?? ''}` : `修改圖形：${path ?? ''}`;
    } else if (call.name === 'write_graph') {
      const dry = await dispatchTool('write_graph', { ...inp, dryRun: true }, turnCtx);
      if (dry.isError) return dry;
      const n = Array.isArray((inp.graph as { nodes?: unknown[] } | null)?.nodes)
        ? (inp.graph as { nodes: unknown[] }).nodes.length : 0;
      summary = replyLang === 'en' ? `Write graph: ${path ?? ''} (${n} nodes)` : `寫入圖形：${path ?? ''}（${n} 個節點）`;
      diff = writeGraphNodeLines(inp.graph, dry.content);
    } else if (call.name === 'rename_graph') {
      summary = replyLang === 'en'
        ? `Rename: ${String(inp.from ?? '')} → ${String(inp.to ?? '')}`
        : `改名：${String(inp.from ?? '')} → ${String(inp.to ?? '')}`;
    } else { // delete_graph
      summary = replyLang === 'en' ? `Delete graph: ${path ?? ''}` : `刪除圖形：${path ?? ''}`;
    }

    // The loop owns the SSE contract: emit the request, ask the hook (which
    // awaits the owner's POST /api/agent/approve), then emit the outcome.
    const id = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    emit({ type: 'approval_request', id, tool: call.name, path, summary, diff });
    const decision = await requestApproval!({ id, tool: call.name, path, summary, diff });
    emit({
      type: 'approval_resolved',
      id,
      decision: decision.approved ? 'approved' : (decision.reason === 'timeout' ? 'timeout' : 'rejected'),
      // Only surface a real user note; synthetic timeout/aborted stay internal.
      reason: decision.reason && decision.reason !== 'timeout' && decision.reason !== 'aborted' ? decision.reason : undefined,
    });
    if (decision.approved) return dispatchGuarded(call);
    return { content: approvalRejectionMessage(decision.reason, replyLang), isError: true };
  };

  // Identity of a tool call for the no-progress (duplicate-spin) breaker.
  const callSignature = (call: ToolUseBlock): string => {
    let inp: string;
    try { inp = JSON.stringify(call.input ?? {}); } catch { inp = String(call.input); }
    return `${call.name}:${inp}`;
  };

  for (let iter = 0; iter < maxIters; iter++) {
    if (signal?.aborted) break;

    // Proactive context gate (F) + in-loop auto-compaction (D). Size the request
    // we are ABOUT to send (the history already carries this turn's appended
    // tool_results), not the previous round; take the larger of the real
    // last-round usage and a fresh chars/4 estimate so we never under-count.
    const projectedContext = (): number =>
      Math.max(session.contextTokens, estimateMessagesTokens(session.messages) + Math.ceil(system.length / 4));
    let effective = projectedContext();

    // A long agentic turn can outgrow the window mid-flight; the pre-loop
    // maybeCompact only covers the turn's START (iter 0), so re-check here on
    // later iterations and summarize+trim before the ceiling. After it reports
    // it cannot help, stop attempting (autoCompactBlocked) to avoid busy no-ops.
    if (iter > 0 && !autoCompactBlocked && ctx.memory && effective >= compactThreshold) {
      const r = await compactNow(session, provider, model, ctx, emit, signal, compactKeepTurns, replyLang);
      if (r.ok) {
        // The fresh summary now lives in session memory — rebuild the system
        // prompt so the rest of THIS turn can see it, and re-size.
        const mem = ctx.memory
          ? { longterm: await ctx.memory.read('longterm'), session: await ctx.memory.read('session') }
          : undefined;
        system = await buildSystemPrompt(ctx.repoRoot, session.ueVersion, mem, { webTools: webEnabled, language: options?.language });
        effective = projectedContext();
      } else {
        autoCompactBlocked = true;
      }
    }

    if (effective >= tokenCeiling) {
      emit({ type: 'limit', kind: 'cost', message: ceilingMessage(effective) });
      limitEmitted = true;
      break;
    }

    // --- Stream from provider, retrying transient pre-content failures (C) ---
    let round = await streamRound();
    for (let attempt = 1;
         round.errorMsg !== null && !round.sawAnyEvent && !signal?.aborted
           && isRetryableStreamError(round.errorMsg) && attempt <= STREAM_MAX_RETRIES;
         attempt++) {
      emit({
        type: 'notice',
        text: replyLang === 'en'
          ? `Connection issue — retrying ${attempt}/${STREAM_MAX_RETRIES}…`
          : `連線中斷，重試中 ${attempt}/${STREAM_MAX_RETRIES}…`,
      });
      await delay(retryBaseMs * 2 ** (attempt - 1), signal);
      if (signal?.aborted) break;
      round = await streamRound();
    }

    const { assistantContent, toolUses } = round;

    // If usage was never reported, estimate combined in+out from chars/4.
    // Include the system prompt and accumulated history (input) plus the
    // collected output text so the ceiling fires at approximately the right time.
    if (!round.usageEmitted) {
      let inputChars = system.length;
      for (const msg of session.messages) {
        for (const blk of msg.content) {
          if ('text' in blk && typeof blk.text === 'string') {
            inputChars += blk.text.length;
          } else if ('content' in blk && typeof blk.content === 'string') {
            inputChars += blk.content.length;
          }
        }
      }
      const totalEstimate = (inputChars + round.outputCharEstimate) / 4;
      if (totalEstimate > 0) {
        session.totalTokens += totalEstimate;
        // The estimated input already covers system + full history → it IS
        // the context size, same as a real usage report's inputTokens.
        session.contextTokens = totalEstimate;
        emit({
          type: 'usage',
          inputTokens: Math.round(inputChars / 4),
          outputTokens: Math.round(round.outputCharEstimate / 4),
          estimated: true,
        });
      }
    }

    // Non-retryable / retries-exhausted error: surface it and stop. Discard any
    // partial assistant content from the failed round so the history never keeps
    // a dangling tool_use (which the next request would reject).
    if (round.errorMsg !== null && !signal?.aborted) {
      emit({ type: 'error', message: round.errorMsg });
      break;
    }

    // Append assistant turn.
    if (assistantContent.length > 0) {
      session.messages.push({ role: 'assistant', content: assistantContent });
      assistantCommitted = true;
    }

    // No tool calls → final text response.
    if (toolUses.length === 0) {
      // Wrap-up self-check (#1): the model is trying to FINISH. If it wrote
      // graphs this turn and we have not yet self-checked, re-validate the
      // final state; objective issues inject ONE corrective nudge so the model
      // fixes them before ending (bounded to a single extra round per turn).
      if (selfCheckOnFinish && !selfCheckDone && turnWrittenPaths.size > 0 && !signal?.aborted) {
        selfCheckDone = true;
        const nudge = await runWrapUpSelfCheck(turnWrittenPaths, turnCtx, replyLang);
        if (nudge !== null) {
          emit({
            type: 'notice',
            text: replyLang === 'en'
              ? 'Wrap-up self-check: the final graph still has issues — fixing before finishing…'
              : '收尾自我複查：最終的圖還有問題，正在修正後再結束…',
          });
          session.messages.push({ role: 'user', content: [{ type: 'text', text: nudge }] });
          continue; // give the model one round to fix or justify
        }
      }
      // Still check the ceiling so a single massive text response that crosses
      // it gets a graceful limit event rather than silently stopping.
      if (session.contextTokens >= tokenCeiling) {
        emit({
          type: 'limit',
          kind: 'cost',
          message: ceilingMessage(session.contextTokens),
        });
        limitEmitted = true;
      }
      break;
    }

    // --- Dispatch tools (B: consecutive read-only calls run concurrently; ------
    // writes / session-mutating tools stay sequential and act as barriers) ------
    // A read must never observe a half-applied write, so a write first drains the
    // in-flight read batch; tool_start / tool_end / tool_result keep model order.
    const toolResults: ToolResultBlock[] = [];

    // tool_end + circuit breakers + UI fan-out + push the result (original order).
    const finishCall = (call: ToolUseBlock, result: { content: string; isError?: boolean }): void => {
      emit({
        type: 'tool_end',
        name: call.name,
        ok: !result.isError,
        summary: result.isError ? undefined : toolEndSummary(call.name, result.content),
      });
      if (WRITE_TOOL_NAMES.has(call.name)) {
        const path = String((call.input as Record<string, unknown> | null)?.path ?? '');
        if (result.isError) {
          const n = (writeFailCounts.get(path) ?? 0) + 1;
          writeFailCounts.set(path, n);
          if (n >= WRITE_FAIL_BREAKER) {
            breakerMessage = replyLang === 'en'
              ? `I have tried ${n} times to modify "${path}" without passing validation, so I'm stopping to avoid spinning. ` +
                'Tell me more specifically what you need, or consider creating a new graph or a different approach.'
              : `我連續 ${n} 次修改「${path}」都沒有通過驗證，先停下來以免空轉。` +
                '可以告訴我更具體的需求，或考慮新建一張圖、換個做法再試。';
          }
        } else {
          writeFailCounts.delete(path);
        }
      }
      if (!result.isError) fanOutToolResult(call, result.content, emit, session.ueVersion);
      // A successful state-changing tool invalidates the duplicate-spin window
      // (prior reads may now be stale) and, for graph writes, records the path
      // for the wrap-up self-check.
      if (!READONLY_TOOLS.has(call.name) && !result.isError) {
        seenSignatures.clear();
        if (WRITE_TOOL_NAMES.has(call.name)) {
          let p: string | undefined;
          try {
            const j = JSON.parse(result.content) as { path?: unknown };
            if (typeof j.path === 'string') p = j.path;
          } catch { /* non-JSON */ }
          if (!p && typeof (call.input as Record<string, unknown> | null)?.path === 'string') {
            p = String((call.input as Record<string, unknown>).path);
          }
          if (p) turnWrittenPaths.add(p);
        }
      }
      toolResults.push({ type: 'tool_result', toolUseId: call.id, content: result.content, isError: result.isError });
    };

    // In-flight concurrent read-only batch: {call, promise}.
    const pending: Array<{ call: ToolUseBlock; promise: Promise<{ content: string; isError?: boolean }> }> = [];
    const flushPending = async (): Promise<void> => {
      for (const p of pending) finishCall(p.call, await p.promise);
      pending.length = 0;
    };

    // No-progress tracking for THIS iteration (a "data" call = anything but the
    // loop-special compact_context / report_off_topic).
    let sawDataCall = false;
    let sawFreshRead = false;
    let sawNonReadAction = false;

    for (const call of toolUses) {
      if (signal?.aborted) break;

      if (READONLY_TOOLS.has(call.name)) {
        // Duplicate-spin bookkeeping (non-destructive — the call still runs):
        // a read whose signature was already seen since the last write is a
        // repeat; a never-seen one counts as progress.
        sawDataCall = true;
        const sig = callSignature(call);
        if (seenSignatures.has(sig)) { /* duplicate — no fresh-read credit */ }
        else { seenSignatures.add(sig); sawFreshRead = true; }
        // Kick the work off now; settle it (in order) on the next flush.
        emit({ type: 'tool_start', name: call.name, summary: toolSummary(call) });
        pending.push({ call, promise: dispatchGuarded(call) });
        continue;
      }

      // Barrier: complete in-flight reads before a write / session-mutating tool.
      await flushPending();
      if (signal?.aborted) break;

      if (call.name !== 'compact_context' && call.name !== 'report_off_topic') {
        sawDataCall = true;
        sawNonReadAction = true; // a write / proposal / export is always progress
      }

      emit({ type: 'tool_start', name: call.name, summary: toolSummary(call) });
      // compact_context / report_off_topic are handled here, not in tools.ts —
      // they need the session (and provider) that only the loop holds.
      let result: { content: string; isError?: boolean };
      if (call.name === 'compact_context') {
        const r = await compactNow(session, provider, model, ctx, emit, signal, compactKeepTurns, replyLang);
        result = r.ok
          ? { content: `已將先前 ${r.droppedTurns} 輪對話摘要進會話記憶並壓縮歷史。`, isError: false }
          : { content: r.reason ?? '壓縮失敗。', isError: true };
        compactFailCount = result.isError ? compactFailCount + 1 : 0;
        if (compactFailCount >= COMPACT_FAIL_BREAKER) {
          breakerMessage = replyLang === 'en'
            ? `Compacting the context failed ${compactFailCount} times in a row, so I'm stopping. Please start a new conversation or try again later.`
            : `連續 ${compactFailCount} 次壓縮上下文都失敗，先停下來。請改用「新對話」或稍後再試。`;
        }
      } else if (call.name === 'report_off_topic') {
        // At most ONE strike per user turn — a model that reports off-topic
        // twice in the same turn must not double-count toward the close limit.
        if (offTopicReportedThisTurn) {
          result = { content: '（本輪已記錄一次離題，請依先前指示回應，不要重複呼叫。）', isError: false };
        } else {
          offTopicReportedThisTurn = true;
          result = offTopicStrike(session, replyLang);
          if (session.offTopicStrikes >= OFF_TOPIC_LIMIT) offTopicClosed = true;
        }
      } else if (requestApproval && MUTATING_TOOLS.has(call.name)) {
        // Review mode: pause for the owner before any graph mutation.
        result = await dispatchMutatingApproved(call);
      } else {
        result = await dispatchGuarded(call);
      }
      finishCall(call, result);
    }

    // Settle any trailing read-only batch. Skipped on abort — the gap-fill below
    // answers the unsettled calls with synthetic aborted results instead.
    if (!signal?.aborted) await flushPending();

    // Abort guard: if abort fired mid-dispatch we have fewer tool_results than
    // tool_use blocks. The assistant tool_use message is already in the
    // history, and the next request fails unless every tool_use is answered
    // immediately — fill the gap with synthetic aborted results, keep the
    // history valid, and stop.
    if (toolResults.length !== toolUses.length) {
      const abortContent = replyLang === 'en'
        ? '(Interrupted: the user cancelled this operation.)'
        : '（已中斷：使用者取消了這次操作）';
      for (const call of toolUses.slice(toolResults.length)) {
        toolResults.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: abortContent,
          isError: true,
        });
      }
      session.messages.push({ role: 'user', content: toolResults });
      break;
    }

    // Append tool results as a user message.
    session.messages.push({
      role: 'user',
      content: toolResults,
    });

    // No-progress breaker: an iteration that made ONLY duplicate data calls
    // (every call a repeat since the last write, no fresh read, no write) is
    // spinning. Count consecutive such iterations; trip the breaker at the
    // threshold. Any progress (a fresh read, a write, or no data call at all)
    // resets the streak.
    if (sawDataCall && !sawNonReadAction && !sawFreshRead) {
      allDuplicateStreak += 1;
      if (allDuplicateStreak >= NOPROGRESS_BREAKER && !breakerMessage) {
        breakerMessage = replyLang === 'en'
          ? `The last ${allDuplicateStreak} rounds only repeated tool calls I had already made, with no progress, so I'm stopping. ` +
            'Please give me a more specific instruction, or tell me what is still missing.'
          : `最近 ${allDuplicateStreak} 輪都在重複先前一樣的工具呼叫、沒有任何進展，先停下來以免空轉。` +
            '請給更具體的指示，或告訴我還缺什麼。';
      }
    } else {
      allDuplicateStreak = 0;
    }

    // Third off-topic strike: stop NOW — no further model round, no farewell
    // text. The http layer reacts to session_closed by deleting the session
    // (file + checkpoints + memory); the tool_results above keep the history
    // legal in the unlikely event the deletion fails.
    if (offTopicClosed) {
      emit({
        type: 'session_closed',
        message: replyLang === 'en'
          ? `Accumulated ${session.offTopicStrikes} off-topic messages; this session has been closed and deleted.`
          : `已累積 ${session.offTopicStrikes} 次離題訊息，本會話已關閉並刪除。`,
      });
      limitEmitted = true;
      break;
    }

    // Circuit breaker tripped — every tool_use above is already answered, so
    // the history stays legal; stop with an honest plain-language explanation
    // instead of letting the model spin (誠實 > 自信的錯).
    if (breakerMessage) {
      emit({ type: 'limit', kind: 'failures', message: breakerMessage });
      limitEmitted = true;
      break;
    }

    // Check ceiling again after tools round.
    if (session.contextTokens >= tokenCeiling) {
      emit({
        type: 'limit',
        kind: 'cost',
        message: ceilingMessage(session.contextTokens),
      });
      limitEmitted = true;
      break;
    }
  }

  // If we hit MAX_ITERS before a final text response, emit the iters limit.
  // Guard against firing after a cost-ceiling break that already left tool_results
  // as the last message (which would satisfy the condition below but the real
  // reason for stopping was cost, not iterations), and after an abort (the
  // synthetic tool_results leave the same message shape but the user cancelled —
  // an 「已達最大迭代次數」 message would be wrong).
  if (!limitEmitted && !signal?.aborted) {
    const lastMsg = session.messages.at(-1);
    const lastIsUser = lastMsg?.role === 'user';
    // If last message is still from user (tool results), we hit the iter ceiling.
    if (lastIsUser && session.messages.length > 1) {
      const prevMsg = session.messages[session.messages.length - 2];
      if (
        prevMsg?.role === 'assistant' &&
        prevMsg.content.some((b) => b.type === 'tool_use')
      ) {
        emit({
          type: 'limit',
          kind: 'iters',
          message: replyLang === 'en'
            ? `Reached the maximum number of iterations (${maxIters}); stopping. Please try a more specific instruction.`
            : `已達最大迭代次數（${maxIters}），停止繼續。請嘗試更具體的指令。`,
        });
      }
    }
  }

  // Peel back a turn that never produced an assistant reply (see the bookkeeping
  // beside the user-message append). Nothing was committed after our blocks, so
  // either we extended a prior tool_results message — splice off exactly the
  // blocks we pushed, restoring the resume-from-tool_results state — or we
  // pushed a fresh user message that is still the last entry, so drop it whole.
  if (!assistantCommitted) {
    if (rollbackTarget) {
      rollbackTarget.content.splice(rollbackTarget.content.length - rollbackBlockCount, rollbackBlockCount);
    } else if (session.messages.at(-1)?.role === 'user') {
      session.messages.pop();
    }
  }

  emit({ type: 'done' });
}

// ---------------------------------------------------------------------------
// Compaction (M11-1)
// ---------------------------------------------------------------------------

/** chars/4 estimate over the text-bearing blocks of a message list.
    Exported so a session resumed from disk can initialize contextTokens. */
export function estimateMessagesTokens(msgs: Message[]): number {
  let chars = 0;
  for (const m of msgs) {
    for (const b of m.content) {
      // Images are tokenized as vision tokens (~1.6K each), NOT as their
      // base64 text — counting data.length would blow the estimate up by
      // orders of magnitude and trip the ceiling on restored sessions.
      if (b.type === 'image') chars += 6400;
      else if ('text' in b && typeof b.text === 'string') chars += b.text.length;
      else if ('content' in b && typeof b.content === 'string') chars += b.content.length;
    }
  }
  return Math.round(chars / 4);
}

/** Flatten dropped turns into a compact text the summarizer can digest. */
function serializeForSummary(msgs: Message[]): string {
  const parts: string[] = [];
  for (const m of msgs) {
    for (const b of m.content) {
      if (b.type === 'text') parts.push(`${m.role === 'user' ? '使用者' : '助手'}：${b.text}`);
      else if (b.type === 'image') parts.push('[使用者附了一張圖片]');
      else if (b.type === 'tool_use') parts.push(`[工具呼叫 ${b.name}] ${JSON.stringify(b.input).slice(0, 200)}`);
      else if (b.type === 'tool_result') parts.push(`[工具結果${b.isError ? '（錯誤）' : ''}] ${b.content.slice(0, 200)}`);
    }
  }
  let out = parts.join('\n');
  if (out.length > 20_000) out = out.slice(0, 20_000) + '\n…（截斷）';
  return out;
}

/** One-shot tool-less summary of the dropped turns. null = failed → skip compaction. */
async function summarizeForCompaction(
  provider: Provider,
  model: string,
  dropped: Message[],
  session: AgentLoopSession,
  language: 'zh-Hant' | 'en',
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    let text = '';
    for await (const ev of provider.stream({
      model,
      system: language === 'en'
        ? 'You are a conversation summarizer. Condense the following UE material work conversation ' +
          'into concise English notes (under 500 words): preserve the user\'s goals/preferences, ' +
          'created/modified graph file paths and key parameter decisions, and outstanding tasks. ' +
          'Output the notes directly with no preamble.'
        : '你是對話摘要器。把以下 UE 材質工作對話濃縮成繁體中文重點筆記（500 字內）：' +
          '保留使用者目標與偏好、已建立/修改的圖檔路徑與關鍵參數決定、尚未完成的事項。' +
          '直接輸出筆記內容，不要任何前言。',
      messages: [{ role: 'user', content: [{ type: 'text', text: serializeForSummary(dropped) }] }],
      maxTokens: 1024,
      signal,
    })) {
      if (ev.type === 'text_delta') text += ev.text;
      else if (ev.type === 'usage') session.totalTokens += ev.inputTokens + ev.outputTokens;
      else if (ev.type === 'error') return null;
      else if (ev.type === 'done') break;
    }
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** Outcome of an explicit/threshold compaction attempt. */
export interface CompactResult {
  ok: boolean;
  droppedTurns?: number;
  /** zh-TW explanation when ok=false — safe to hand to the model as a tool result. */
  reason?: string;
}

/**
 * When the session crosses the threshold, summarize everything but the last
 * keepTurns user turns into session memory and trim the message history.
 * Every failure path is a safe no-op: the history stays intact.
 */
async function maybeCompact(
  session: AgentLoopSession,
  provider: Provider,
  model: string,
  ctx: ToolContext,
  emit: EmitFn,
  signal: AbortSignal | undefined,
  threshold: number,
  keepTurns: number,
  language: 'zh-Hant' | 'en' = 'zh-Hant',
): Promise<void> {
  // Trigger on the CURRENT context size, never the cumulative spend — the
  // spend re-counts the full history every provider round, so comparing it
  // here made compaction fire long before the window was actually half full.
  if (session.contextTokens < threshold) return;
  await compactNow(session, provider, model, ctx, emit, signal, keepTurns, language);
}

/**
 * Unconditional compaction — shared by the threshold path and the model-callable
 * compact_context tool. Cut points and memory writes are identical; only the
 * trigger differs. Safe mid-turn: cut points are text-only user messages, so the
 * in-flight turn (its user message and the assistant tool_use tail) always
 * survives the trim.
 */
export async function compactNow(
  session: AgentLoopSession,
  provider: Provider,
  model: string,
  ctx: ToolContext,
  emit: EmitFn,
  signal: AbortSignal | undefined,
  keepTurns: number,
  language: 'zh-Hant' | 'en' = 'zh-Hant',
): Promise<CompactResult> {
  if (!ctx.memory) return { ok: false, reason: '此會話沒有記憶儲存空間，無法壓縮。' }; // the summary needs a home
  if (signal?.aborted) return { ok: false, reason: '已中斷。' };

  const msgs = session.messages;

  // Safe cut points: user messages carrying ONLY text. Cutting at a merged
  // tool_result+text message would orphan tool_results from their tool_use —
  // an illegal history for the Anthropic dialect.
  const safeStarts: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'user') continue;
    const hasText = m.content.some(b => b.type === 'text');
    const hasToolResult = m.content.some(b => b.type === 'tool_result');
    if (hasText && !hasToolResult) safeStarts.push(i);
  }
  if (safeStarts.length <= keepTurns) {
    return { ok: false, reason: `對話輪數還不足以壓縮（需超過 ${keepTurns} 輪完整對話），目前無須壓縮。` };
  }

  const cut = safeStarts[safeStarts.length - keepTurns];
  if (cut <= 0) return { ok: false, reason: '沒有可壓縮的較早歷史。' };
  const dropped = msgs.slice(0, cut);
  const droppedTurns = safeStarts.filter(i => i < cut).length;

  const summary = await summarizeForCompaction(provider, model, dropped, session, language, signal);
  if (summary === null) return { ok: false, reason: '摘要產生失敗，本次未壓縮（歷史保持原樣）。' };

  const block = `## 先前對話摘要（自動壓縮）\n${summary}`;
  try {
    await ctx.memory.append('session', block);
  } catch {
    // Session-memory cap hit — last resort: the consolidated summary replaces
    // the old notes (it subsumes them by construction).
    try {
      await ctx.memory.replace('session', block);
    } catch {
      // even replace failed — keep the history untouched
      return { ok: false, reason: '寫入會話記憶失敗，本次未壓縮（歷史保持原樣）。' };
    }
  }

  session.messages = msgs.slice(cut);
  // contextTokens gates compaction + the window ceiling; re-estimate from the
  // remaining messages so the session regains headroom. totalTokens stays
  // untouched — it is the cumulative spend record, not a gate.
  session.contextTokens = estimateMessagesTokens(session.messages);

  emit({
    type: 'compacted',
    message: `對話較長，已將先前 ${droppedTurns} 輪摘要寫入會話記憶並壓縮歷史。`,
  });
  return { ok: true, droppedTurns };
}

// ---------------------------------------------------------------------------
// Stream event handler
// ---------------------------------------------------------------------------

async function handleStreamEvent(
  event: StreamEvent,
  assistantContent: ContentBlock[],
  toolUses: ToolUseBlock[],
  emit: EmitFn,
  session: AgentLoopSession,
  accTokenEstimate: (est: number) => void,
  setUsageEmitted: () => void,
): Promise<void> {
  switch (event.type) {
    case 'text_delta': {
      // Accumulate into running text block or create a new one.
      const last = assistantContent.at(-1);
      if (last?.type === 'text') {
        (last as { type: 'text'; text: string }).text += event.text;
      } else {
        assistantContent.push({ type: 'text', text: event.text });
      }
      // Emit char-by-char to frontend.
      emit({ type: 'text', text: event.text });
      // Estimate output chars; combined in+out estimation happens after the stream.
      accTokenEstimate(event.text.length);
      break;
    }

    case 'thinking_delta': {
      // Display-only reasoning stream — forward to the frontend; the history
      // copy arrives separately as a complete thinking_block.
      emit({ type: 'thinking', text: event.text });
      accTokenEstimate(event.text.length);
      break;
    }

    case 'thinking_block': {
      // Complete block for history round-trip (Anthropic requires the
      // unmodified thinking blocks back when tool use follows). Stream order
      // guarantees this precedes the turn's text/tool_use blocks.
      assistantContent.push(event.block);
      break;
    }

    case 'tool_use': {
      const block: ToolUseBlock = { type: 'tool_use', id: event.id, name: event.name, input: event.input };
      assistantContent.push(block);
      toolUses.push(block);
      break;
    }

    case 'usage': {
      session.totalTokens += event.inputTokens + event.outputTokens;
      // inputTokens covers the full re-sent context (the Anthropic adapter
      // already folds cached portions back in) → this round's in+out is the
      // current context size (NOT additive across rounds).
      session.contextTokens = event.inputTokens + event.outputTokens;
      setUsageEmitted();
      emit({
        type: 'usage',
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        estimated: false,
        // Prompt-cache hits: the share of inputTokens billed at ~10%.
        ...(event.cacheReadTokens ? { cachedTokens: event.cacheReadTokens } : {}),
      });
      break;
    }

    case 'error': {
      emit({ type: 'error', message: event.message });
      break;
    }

    case 'done':
      // Stream completed — no additional action needed; handled by the for-await exit.
      break;

    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Human-readable tool summaries (zh-TW)
// ---------------------------------------------------------------------------

function toolSummary(call: ToolUseBlock): string {
  const inp = call.input as Record<string, unknown>;
  switch (call.name) {
    case 'search_nodes':      return `搜尋節點：${String(inp.query ?? '')}`;
    case 'get_node_signature':return `查詢節點簽名：${String(inp.name ?? '')}`;
    case 'get_mf_signature':  return `查詢 MF 簽名：${String(inp.assetPath ?? '')}`;
    case 'read_graph':        return `讀取圖形：${String(inp.path ?? '')}`;
    case 'write_graph':       return `寫入圖形：${String(inp.path ?? '')}`;
    case 'patch_graph':
      return `${inp.dryRun === true ? '預覽修改' : '修改圖形'}：${String(inp.path ?? '')}`;
    case 'validate_graph':    return `驗證圖形：${typeof inp.path === 'string' ? inp.path : '(inline)'}`;
    case 'get_graph_errors':  return `取得圖形錯誤：${String(inp.path ?? '')}`;
    case 'list_graphs':       return '列出現有圖形檔案';
    case 'get_viewport':      return '查看視窗情境（開啟的圖／選取節點）';
    case 'search_mf':         return `搜尋 MF：${String(inp.query ?? '')}`;
    case 'list_examples':     return '列出參考範例';
    case 'read_example':      return `讀取範例：${String(inp.name ?? '')}`;
    case 'read_memory':       return `讀取記憶：${inp.scope === 'longterm' ? '長期' : '本對話'}`;
    case 'update_memory':     return `更新記憶：${inp.scope === 'longterm' ? '長期' : '本對話'}`;
    case 'compact_context':   return '壓縮對話上下文';
    case 'report_off_topic':  return `記錄離題訊息：${String(inp.reason ?? '')}`;
    case 'rename_graph':      return `改名圖形：${String(inp.from ?? '')} → ${String(inp.to ?? '')}`;
    case 'delete_graph':      return `刪除圖形：${String(inp.path ?? '')}`;
    case 'export_to_clipboard': return `複製到剪貼簿：${String(inp.path ?? '')}`;
    case 'request_crawl':     return `提議爬取：${String(inp.kind ?? '')}`;
    case 'propose_db_edit':   return `提議修改節點 DB：${String(inp.nodeName ?? '')}`;
    case 'read_crawl_log':    return '讀取爬取 log';
    case 'web_search':        return `搜尋網路：${String(inp.query ?? '')}`;
    case 'web_fetch':         return `讀取網頁：${String(inp.url ?? '')}`;
    default:                  return call.name;
  }
}

function toolEndSummary(toolName: string, content: string): string | undefined {
  switch (toolName) {
    case 'write_graph':     return '圖形已寫入';
    case 'patch_graph': {
      try {
        if ((JSON.parse(content) as { dryRun?: unknown }).dryRun === true) {
          return '預覽完成（未寫入）';
        }
      } catch { /* non-JSON content — fall through to the written summary */ }
      return '圖形已更新';
    }
    case 'update_memory':   return '記憶已更新';
    case 'compact_context': return '上下文已壓縮';
    default:                return undefined;
  }
}

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
function offTopicStrike(session: AgentLoopSession): { content: string; isError?: boolean } {
  session.offTopicStrikes += 1;
  const n = session.offTopicStrikes;
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
  const disabledTools = new Set(options?.disabledTools ?? []);
  if (!webEnabled) for (const n of WEB_TOOL_NAMES) disabledTools.add(n);
  const turnToolDefs = toolDefs.filter(t => !disabledTools.has(t.name));

  // Compaction runs BEFORE the memory read so the freshly-written summary is
  // part of this turn's system prompt.
  await maybeCompact(
    session, provider, model, ctx, emit, signal,
    options?.compactThreshold ?? COMPACT_THRESHOLD,
    options?.compactKeepTurns ?? COMPACT_KEEP_TURNS,
  );

  // Build system prompt (reads SPEC.md from disk at call time). Memory is
  // re-read every user turn so notes written mid-conversation take effect
  // on the next turn.
  const memory = ctx.memory
    ? { longterm: await ctx.memory.read('longterm'), session: await ctx.memory.read('session') }
    : undefined;
  const system = await buildSystemPrompt(ctx.repoRoot, session.ueVersion, memory, { webTools: webEnabled });

  // Append the new user message. If the previous turn ended with tool_results
  // (iter/cost ceiling or abort), the last message is already user-role —
  // append the text into it: Anthropic requires roles to strictly alternate,
  // so a second consecutive user message would fail the next request.
  const lastMsg = session.messages.at(-1);
  if (lastMsg?.role === 'user') {
    lastMsg.content.push({ type: 'text', text: userText });
  } else {
    session.messages.push({
      role: 'user',
      content: [{ type: 'text', text: userText }],
    });
  }
  // One checkpoint turn per user turn: every write made while serving this
  // user message shares the id, so a single undo reverts the whole exchange
  // (M4 「回上一步」 semantics).
  const turnId = `${session.id}-turn${session.turnSeq}`;
  session.turnSeq += 1;
  const writeTools = new Set(['write_graph', 'patch_graph']);
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

  for (let iter = 0; iter < maxIters; iter++) {
    if (signal?.aborted) break;

    // Check the context ceiling before sending (in case the previous round
    // pushed us over). Compared against the CURRENT context size, not the
    // cumulative spend — each round's input re-counts the whole history, so
    // summing rounds would trip the limit long before the window is full.
    if (session.contextTokens >= tokenCeiling) {
      emit({
        type: 'limit',
        kind: 'cost',
        message: `上下文 token 數（${Math.round(session.contextTokens)}）已達上限 ${tokenCeiling}，停止繼續。`,
      });
      limitEmitted = true;
      break;
    }

    // --- Stream from provider ---
    const streamIter = provider.stream({
      model,
      messages: session.messages,
      system,
      tools: turnToolDefs,
      maxTokens,
      thinking: options?.thinking,
      signal,
    });

    // Collect assistant turn while emitting text deltas.
    const assistantContent: ContentBlock[] = [];
    const toolUses: ToolUseBlock[] = [];
    let outputCharEstimate = 0;
    let usageEmitted = false;

    for await (const event of streamIter) {
      if (signal?.aborted) break;
      await handleStreamEvent(
        event,
        assistantContent,
        toolUses,
        emit,
        session,
        (est) => { outputCharEstimate += est; },
        () => { usageEmitted = true; },
      );
    }

    // If usage was never reported, estimate combined in+out from chars/4.
    // Include the system prompt and accumulated history (input) plus the
    // collected output text so the ceiling fires at approximately the right time.
    if (!usageEmitted) {
      // Estimate input: system prompt + all messages sent this turn.
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
      const totalEstimate = (inputChars + outputCharEstimate) / 4;
      if (totalEstimate > 0) {
        session.totalTokens += totalEstimate;
        // The estimated input already covers system + full history → it IS
        // the context size, same as a real usage report's inputTokens.
        session.contextTokens = totalEstimate;
        // Emit estimated usage event (output portion only for display).
        emit({
          type: 'usage',
          inputTokens: Math.round(inputChars / 4),
          outputTokens: Math.round(outputCharEstimate / 4),
          estimated: true,
        });
      }
    }

    // Append assistant turn.
    if (assistantContent.length > 0) {
      session.messages.push({ role: 'assistant', content: assistantContent });
    }

    // No tool calls → final text response.
    // Still check the ceiling so a single massive text response that crosses it
    // gets a graceful limit event rather than silently stopping.
    if (toolUses.length === 0) {
      if (session.contextTokens >= tokenCeiling) {
        emit({
          type: 'limit',
          kind: 'cost',
          message: `上下文 token 數（${Math.round(session.contextTokens)}）已達上限 ${tokenCeiling}，停止繼續。`,
        });
        limitEmitted = true;
      }
      break;
    }

    // --- Dispatch tools ---
    const toolResults: ToolResultBlock[] = [];

    for (const call of toolUses) {
      if (signal?.aborted) break;

      // Emit tool_start with a human-readable summary.
      emit({ type: 'tool_start', name: call.name, summary: toolSummary(call) });

      // compact_context / report_off_topic are dispatched here, not in
      // tools.ts — they need the session (and provider) that only the loop holds.
      const result = call.name === 'compact_context'
        ? await (async () => {
            const r = await compactNow(
              session, provider, model, ctx, emit, signal,
              options?.compactKeepTurns ?? COMPACT_KEEP_TURNS,
            );
            return r.ok
              ? { content: `已將先前 ${r.droppedTurns} 輪對話摘要進會話記憶並壓縮歷史。`, isError: false }
              : { content: r.reason ?? '壓縮失敗。', isError: true };
          })()
        : call.name === 'report_off_topic'
          ? offTopicStrike(session)
          : (!webEnabled && WEB_TOOL_NAMES.has(call.name))
            // The tool was not offered this turn — a stray call (hallucinated
            // or replayed from history) must not reach the network.
            ? { content: '聯網功能已由使用者關閉（輸入框旁的 🌐 開關）。請基於本地節點 DB 與既有知識回答，不確定的部分明確說明。', isError: true }
          : disabledTools.has(call.name)
            // Withheld this turn (e.g. member sessions lose the proposal
            // tools) — a stray call must not slip through either.
            ? { content: '此工具在目前的使用者權限下不可用，請改用其他方式完成任務或直接說明限制。', isError: true }
            : await dispatchTool(call.name, call.input, turnCtx);

      if (call.name === 'report_off_topic' && session.offTopicStrikes >= OFF_TOPIC_LIMIT) {
        offTopicClosed = true;
      }

      // Emit tool_end.
      emit({
        type: 'tool_end',
        name: call.name,
        ok: !result.isError,
        summary: result.isError ? undefined : toolEndSummary(call.name, result.content),
      });

      // Feed the circuit breakers.
      if (writeTools.has(call.name)) {
        const path = String((call.input as Record<string, unknown> | null)?.path ?? '');
        if (result.isError) {
          const n = (writeFailCounts.get(path) ?? 0) + 1;
          writeFailCounts.set(path, n);
          if (n >= WRITE_FAIL_BREAKER) {
            breakerMessage =
              `我連續 ${n} 次修改「${path}」都沒有通過驗證，先停下來以免空轉。` +
              '可以告訴我更具體的需求，或考慮新建一張圖、換個做法再試。';
          }
        } else {
          writeFailCounts.delete(path);
        }
      }
      if (call.name === 'compact_context') {
        compactFailCount = result.isError ? compactFailCount + 1 : 0;
        if (compactFailCount >= COMPACT_FAIL_BREAKER) {
          breakerMessage = `連續 ${compactFailCount} 次壓縮上下文都失敗，先停下來。請改用「新對話」或稍後再試。`;
        }
      }

      // Successful tool results fan out to UI events: plain-language diff lines
      // (any tool that returns them), graph_written for writes/renames, and the
      // viewer-action signals for clipboard export and crawl proposals.
      if (!result.isError) {
        const inp = call.input as Record<string, unknown>;
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(result.content) as Record<string, unknown>;
        } catch {
          // Non-JSON result — nothing to fan out.
        }

        if (parsed.ok && Array.isArray(parsed.diff) && parsed.diff.length > 0) {
          emit({ type: 'diff', lines: parsed.diff as string[] });
        }

        if (writeTools.has(call.name) && typeof inp.path === 'string') {
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
            ueVersion: typeof parsed.ueVersion === 'string' ? parsed.ueVersion : session.ueVersion,
            create: parsed.create === true,
            patch: (parsed.patch && typeof parsed.patch === 'object' ? parsed.patch : {}) as Record<string, unknown>,
            rationale: typeof parsed.rationale === 'string' ? parsed.rationale : '',
          });
        }
      }

      toolResults.push({
        type: 'tool_result',
        toolUseId: call.id,
        content: result.content,
        isError: result.isError,
      });
    }

    // Abort guard: if abort fired mid-dispatch we have fewer tool_results than
    // tool_use blocks. The assistant tool_use message is already in the
    // history, and the next request fails unless every tool_use is answered
    // immediately — fill the gap with synthetic aborted results, keep the
    // history valid, and stop.
    if (toolResults.length !== toolUses.length) {
      for (const call of toolUses.slice(toolResults.length)) {
        toolResults.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: '（已中斷：使用者取消了這次操作）',
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

    // Third off-topic strike: stop NOW — no further model round, no farewell
    // text. The http layer reacts to session_closed by deleting the session
    // (file + checkpoints + memory); the tool_results above keep the history
    // legal in the unlikely event the deletion fails.
    if (offTopicClosed) {
      emit({
        type: 'session_closed',
        message: `已累積 ${session.offTopicStrikes} 次離題訊息，本會話已關閉並刪除。`,
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
        message: `上下文 token 數（${Math.round(session.contextTokens)}）已達上限 ${tokenCeiling}，停止繼續。`,
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
          message: `已達最大迭代次數（${maxIters}），停止繼續。請嘗試更具體的指令。`,
        });
      }
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
      if ('text' in b && typeof b.text === 'string') chars += b.text.length;
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
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    let text = '';
    for await (const ev of provider.stream({
      model,
      system:
        '你是對話摘要器。把以下 UE 材質工作對話濃縮成繁體中文重點筆記（500 字內）：' +
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
): Promise<void> {
  // Trigger on the CURRENT context size, never the cumulative spend — the
  // spend re-counts the full history every provider round, so comparing it
  // here made compaction fire long before the window was actually half full.
  if (session.contextTokens < threshold) return;
  await compactNow(session, provider, model, ctx, emit, signal, keepTurns);
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

  const summary = await summarizeForCompaction(provider, model, dropped, session, signal);
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
      // inputTokens covers the full re-sent context → this round's in+out is
      // the current context size (NOT additive across rounds).
      session.contextTokens = event.inputTokens + event.outputTokens;
      setUsageEmitted();
      emit({
        type: 'usage',
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        estimated: false,
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
    case 'patch_graph':       return `修改圖形：${String(inp.path ?? '')}`;
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

function toolEndSummary(toolName: string, _content: string): string | undefined {
  switch (toolName) {
    case 'write_graph':     return '圖形已寫入';
    case 'patch_graph':     return '圖形已更新';
    case 'update_memory':   return '記憶已更新';
    case 'compact_context': return '上下文已壓縮';
    default:                return undefined;
  }
}

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
//   - TOKEN_CEILING = 300_000 cumulative input+output tokens.
//     When usage data is absent, fall back to chars/4 estimation.
//   - Loop emits a graceful 'limit' event rather than crashing on ceiling hit.
//   - Raw validation errors never reach the user directly; they go to
//     tool_result for the model to self-correct.
//   - Before every write, checkpoint.snapshotFile() is called via
//     ctx.beforeWrite (injected by the caller via ToolContext).

import type { Provider, Message, ToolUseBlock, ToolResultBlock, ContentBlock, StreamEvent } from './provider/types.js';
import { toolDefs, dispatchTool, type ToolContext } from './tools.js';
import type { AgentSseEvent } from './agent-types.js';
import { buildSystemPrompt } from './prompt.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard ceiling on agent iterations per user turn. */
export const MAX_ITERS = 8;

/**
 * Cumulative token ceiling across a session.
 * When usage is absent (some compat providers skip it), we estimate via chars/4.
 */
export const TOKEN_CEILING = 300_000;

// ---------------------------------------------------------------------------
// Session type (server-side only)
// ---------------------------------------------------------------------------

export interface AgentLoopSession {
  id: string;
  ueVersion: string;
  graphPath?: string;
  /** Accumulated conversation turns. */
  messages: Message[];
  /** Running total tokens (input + output, estimated when necessary). */
  totalTokens: number;
  /**
   * Monotonic user-turn counter. Checkpoint turn ids are derived from it and
   * must never repeat across runAgent calls — a reused id makes the checkpoint
   * store skip pre-images it has already seen, so undo would restore a state
   * older than the previous turn.
   */
  turnSeq: number;
}

export function createSession(id: string, ueVersion: string, graphPath?: string): AgentLoopSession {
  return {
    id,
    ueVersion,
    graphPath,
    messages: [],
    totalTokens: 0,
    turnSeq: 0,
  };
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
  /** Override MAX_ITERS for this call (default: MAX_ITERS = 8). */
  maxIters?: number;
  /** Override TOKEN_CEILING for this call (default: TOKEN_CEILING = 300_000). */
  tokenCeiling?: number;
  /**
   * maxTokens to send in each ChatRequest.
   * Flows from LLMConfig.maxTokens via the http-server chat handler.
   * Defaults to 8192 when absent.
   */
  maxTokens?: number;
}

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
  const maxIters = options?.maxIters ?? MAX_ITERS;
  const tokenCeiling = options?.tokenCeiling ?? TOKEN_CEILING;
  const maxTokens = options?.maxTokens ?? 8192;

  // Build system prompt (reads SPEC.md from disk at call time).
  const system = await buildSystemPrompt(ctx.repoRoot, session.ueVersion);

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

  for (let iter = 0; iter < maxIters; iter++) {
    if (signal?.aborted) break;

    // Check token ceiling before sending (in case the previous round pushed us over).
    if (session.totalTokens >= tokenCeiling) {
      emit({
        type: 'limit',
        kind: 'cost',
        message: `累計 token 數（${session.totalTokens}）已達上限 ${tokenCeiling}，停止繼續。`,
      });
      limitEmitted = true;
      break;
    }

    // --- Stream from provider ---
    const streamIter = provider.stream({
      model,
      messages: session.messages,
      system,
      tools: toolDefs,
      maxTokens,
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
      if (session.totalTokens >= tokenCeiling) {
        emit({
          type: 'limit',
          kind: 'cost',
          message: `累計 token 數（${session.totalTokens}）已達上限 ${tokenCeiling}，停止繼續。`,
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

      const result = await dispatchTool(call.name, call.input, turnCtx);

      // Emit tool_end.
      emit({
        type: 'tool_end',
        name: call.name,
        ok: !result.isError,
        summary: result.isError ? undefined : toolEndSummary(call.name, result.content),
      });

      // For write tools on success, emit diff and graph_written events.
      if (!result.isError && writeTools.has(call.name)) {
        const inp = call.input as Record<string, unknown>;
        const path = typeof inp.path === 'string' ? inp.path : undefined;

        try {
          const parsed = JSON.parse(result.content) as Record<string, unknown>;
          if (parsed.ok && Array.isArray(parsed.diff) && parsed.diff.length > 0) {
            emit({ type: 'diff', lines: parsed.diff as string[] });
          }
        } catch {
          // Non-JSON result — ignore diff extraction.
        }

        if (path) {
          emit({ type: 'graph_written', path });
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

    // Check ceiling again after tools round.
    if (session.totalTokens >= tokenCeiling) {
      emit({
        type: 'limit',
        kind: 'cost',
        message: `累計 token 數（${session.totalTokens}）已達上限 ${tokenCeiling}，停止繼續。`,
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

    case 'tool_use': {
      const block: ToolUseBlock = { type: 'tool_use', id: event.id, name: event.name, input: event.input };
      assistantContent.push(block);
      toolUses.push(block);
      break;
    }

    case 'usage': {
      session.totalTokens += event.inputTokens + event.outputTokens;
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
    default:                  return call.name;
  }
}

function toolEndSummary(toolName: string, _content: string): string | undefined {
  switch (toolName) {
    case 'write_graph':  return '圖形已寫入';
    case 'patch_graph':  return '圖形已更新';
    default:             return undefined;
  }
}

// Anthropic Messages API streaming adapter.
// Translates the neutral ChatRequest/StreamEvent layer to/from the
// Anthropic SSE dialect (content_block_start/delta/stop, message_delta, etc.).
// fetchFn injection keeps this unit-testable with zero real network calls.

import { parseSse, abortSafe } from './sse.js';
import type {
  ChatRequest,
  LLMConfig,
  Provider,
  StreamEvent,
  ToolResultBlock,
} from './types.js';

const DEFAULT_BASE = 'https://api.anthropic.com';
// Anthropic requires max_tokens; choose a safe default when the caller omits it.
const DEFAULT_MAX_TOKENS = 4096;

// Extended-thinking budgets per level. max_tokens must exceed the budget, so
// the request raises it to budget + headroom when the configured value is lower.
const THINKING_BUDGETS: Record<'low' | 'medium' | 'high', number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
};
const THINKING_HEADROOM = 4096;

type FetchFn = typeof globalThis.fetch;

// Accumulated state for a single content block while streaming.
interface ToolBlockAcc {
  id: string;
  name: string;
  partialJson: string;
}

// Accumulated state for a streaming thinking block (signature arrives via
// signature_delta and must be round-tripped verbatim).
interface ThinkingAcc {
  thinking: string;
  signature: string;
}

function mapStopReason(r: string | null | undefined): 'end' | 'tool_use' | 'max_tokens' {
  if (r === 'tool_use') return 'tool_use';
  if (r === 'max_tokens') return 'max_tokens';
  return 'end';
}

// Attempt JSON.parse; on failure return a __parse_error__ tool_use event per contract.
function parseTool(acc: ToolBlockAcc): StreamEvent {
  // Empty / absent argument string (no-arg tool call) → treat as {}.
  const raw = acc.partialJson.trim();
  if (raw === '') {
    return { type: 'tool_use', id: acc.id, name: acc.name, input: {} };
  }
  try {
    return { type: 'tool_use', id: acc.id, name: acc.name, input: JSON.parse(raw) };
  } catch (err) {
    return {
      type: 'tool_use',
      id: `${acc.id}_parse_error`,
      name: '__parse_error__',
      input: { original_tool: acc.name, raw, error: String(err) },
    };
  }
}

export class AnthropicAdapter implements Provider {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: FetchFn;

  constructor(config: LLMConfig, fetchFn: FetchFn = globalThis.fetch) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE;
    this.apiKey = config.apiKey;
    this.fetchFn = fetchFn;
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const thinkingOn = req.thinking !== undefined && req.thinking !== 'off';

    // Build request body per Anthropic Messages API spec.
    // With thinking disabled, historic thinking/redacted_thinking blocks are
    // stripped (the API rejects them); with thinking enabled they round-trip
    // verbatim — required when tool use follows an extended-thinking turn.
    // Every block is SHALLOW-COPIED: the cache_control breakpoint below must
    // never leak into the caller's neutral message history.
    const messages = req.messages.map((m) => ({
      role: m.role,
      content: m.content
        .filter((block) =>
          thinkingOn || (block.type !== 'thinking' && block.type !== 'redacted_thinking'))
        .map((block): Record<string, unknown> => {
          if (block.type === 'tool_result') {
            // Neutral toolUseId → Anthropic tool_use_id.
            const tb = block as ToolResultBlock;
            const out: Record<string, unknown> = {
              type: 'tool_result',
              tool_use_id: tb.toolUseId,
              content: tb.content,
            };
            if (tb.isError !== undefined) out.is_error = tb.isError;
            return out;
          }
          return { ...block };
        }),
    }));

    // Prompt caching — three ephemeral breakpoints (4 allowed max): the last
    // tool def, the system prompt, and the last content block of the final
    // message. The agent loop's history is append-only within a turn, so each
    // round re-reads the previous round's prefix at ~10% price instead of
    // full price; the moving message breakpoint advances every round.
    const lastContent = messages.at(-1)?.content;
    const lastBlock = lastContent?.[lastContent.length - 1];
    if (lastBlock && (lastBlock.type === 'text' || lastBlock.type === 'tool_result')) {
      lastBlock.cache_control = { type: 'ephemeral' };
    }

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
    };

    if (thinkingOn) {
      const budget = THINKING_BUDGETS[req.thinking as 'low' | 'medium' | 'high'];
      body.thinking = { type: 'enabled', budget_tokens: budget };
      // max_tokens must be strictly greater than the thinking budget.
      body.max_tokens = Math.max(req.maxTokens ?? DEFAULT_MAX_TOKENS, budget + THINKING_HEADROOM);
    }

    // system is top-level, only when present — sent as a content-block array
    // so it can carry its cache breakpoint.
    if (req.system !== undefined) {
      body.system = [
        { type: 'text', text: req.system, cache_control: { type: 'ephemeral' } },
      ];
    }

    // Translate ToolDef.inputSchema → Anthropic's input_schema. The cache
    // breakpoint sits on the LAST def and covers the whole tool array.
    if (req.tools && req.tools.length > 0) {
      const lastIdx = req.tools.length - 1;
      body.tools = req.tools.map((t, i) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        ...(i === lastIdx ? { cache_control: { type: 'ephemeral' } } : {}),
      }));
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;

    const response = await this.fetchFn(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!response.ok || !response.body) {
      // Best-effort body read for diagnostic context.
      let errText = '';
      try { errText = await response.text(); } catch { /* ignore */ }
      yield { type: 'error', message: `HTTP ${response.status}: ${errText}` };
      return;
    }

    // Usage accumulated across message_start + message_delta.
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheCreationTokens = 0;
    let stopReason: 'end' | 'tool_use' | 'max_tokens' = 'end';

    // Currently streaming tool_use content block, if any.
    let currentTool: ToolBlockAcc | null = null;
    // Currently streaming thinking block (text via thinking_delta, signature
    // via signature_delta); emitted as one thinking_block on stop.
    let currentThinking: ThinkingAcc | null = null;
    // A redacted_thinking block arrives complete in content_block_start.
    let currentRedacted: string | null = null;

    // abortSafe: a user-initiated abort makes reader.read() inside parseSse
    // throw an AbortError — a normal cancellation, not a provider failure.
    // The stream then ends silently (no error/done event) instead of the
    // error surfacing as a fake 「對話發生錯誤」 to the user.
    for await (const line of abortSafe(parseSse(response.body), req.signal)) {
      // parseSse strips Anthropic's `event:` lines; the data JSON always carries
      // its own `type` field, so dispatch on that instead of the SSE event name.
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Malformed JSON line — skip.
        continue;
      }

      const evtType = evt.type as string | undefined;

      switch (evtType) {
        case 'message_start': {
          const usage = (evt.message as Record<string, unknown> | undefined)?.usage as Record<string, number> | undefined;
          if (usage) {
            // With prompt caching, input_tokens EXCLUDES the cached prefix —
            // the loop's context gating needs the full context size, so sum
            // all three. Cache numbers are kept separately for telemetry.
            cacheReadTokens = usage.cache_read_input_tokens ?? 0;
            cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
            inputTokens = (usage.input_tokens ?? 0) + cacheReadTokens + cacheCreationTokens;
          }
          break;
        }

        case 'content_block_start': {
          const block = evt.content_block as Record<string, unknown> | undefined;
          if (block?.type === 'tool_use') {
            currentTool = {
              id: String(block.id ?? ''),
              name: String(block.name ?? ''),
              partialJson: '',
            };
          } else if (block?.type === 'thinking') {
            currentThinking = { thinking: '', signature: '' };
          } else if (block?.type === 'redacted_thinking') {
            currentRedacted = String(block.data ?? '');
          }
          // text blocks: nothing to do on start.
          break;
        }

        case 'content_block_delta': {
          const delta = evt.delta as Record<string, unknown> | undefined;
          if (!delta) break;
          if (delta.type === 'text_delta') {
            yield { type: 'text_delta', text: String(delta.text ?? '') };
          } else if (delta.type === 'input_json_delta' && currentTool) {
            currentTool.partialJson += String(delta.partial_json ?? '');
          } else if (delta.type === 'thinking_delta' && currentThinking) {
            const text = String(delta.thinking ?? '');
            currentThinking.thinking += text;
            yield { type: 'thinking_delta', text };
          } else if (delta.type === 'signature_delta' && currentThinking) {
            currentThinking.signature += String(delta.signature ?? '');
          }
          break;
        }

        case 'content_block_stop': {
          if (currentTool) {
            yield parseTool(currentTool);
            currentTool = null;
          } else if (currentThinking) {
            yield {
              type: 'thinking_block',
              block: { type: 'thinking', thinking: currentThinking.thinking, signature: currentThinking.signature },
            };
            currentThinking = null;
          } else if (currentRedacted !== null) {
            yield {
              type: 'thinking_block',
              block: { type: 'redacted_thinking', data: currentRedacted },
            };
            currentRedacted = null;
          }
          break;
        }

        case 'message_delta': {
          // message_delta usage carries CUMULATIVE totals, not deltas — last
          // value wins (same rule as the OpenAI adapter), never accumulate.
          const usage = evt.usage as Record<string, number> | undefined;
          if (usage && typeof usage.output_tokens === 'number') outputTokens = usage.output_tokens;
          const delta = evt.delta as Record<string, unknown> | undefined;
          if (delta?.stop_reason) {
            stopReason = mapStopReason(delta.stop_reason as string);
          }
          break;
        }

        case 'message_stop': {
          if (inputTokens > 0 || outputTokens > 0) {
            yield {
              type: 'usage',
              inputTokens,
              outputTokens,
              // Omitted when zero so cache-less responses keep the old shape.
              ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
              ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
            };
          }
          yield { type: 'done', stopReason };
          return;
        }

        case 'error': {
          const errObj = evt.error as Record<string, unknown> | undefined;
          const msg = errObj?.message ?? evt.message ?? 'unknown error';
          yield { type: 'error', message: String(msg) };
          return;
        }

        case 'ping':
          // Keepalive — ignore.
          break;

        default:
          // Unknown event types are silently ignored per contract.
          break;
      }
    }

    // An aborted stream ends silently — no synthetic done either (the loop's
    // own signal check handles the turn teardown).
    if (req.signal?.aborted) return;

    // Stream ended without message_stop (truncated response or network drop).
    yield { type: 'done', stopReason };
  }
}

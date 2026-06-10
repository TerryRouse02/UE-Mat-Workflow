// Anthropic Messages API streaming adapter.
// Translates the neutral ChatRequest/StreamEvent layer to/from the
// Anthropic SSE dialect (content_block_start/delta/stop, message_delta, etc.).
// fetchFn injection keeps this unit-testable with zero real network calls.

import { parseSse } from './sse.js';
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

type FetchFn = typeof globalThis.fetch;

// Accumulated state for a single content block while streaming.
interface ToolBlockAcc {
  id: string;
  name: string;
  partialJson: string;
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
    // Build request body per Anthropic Messages API spec.
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => ({
        role: m.role,
        content: m.content.map((block) => {
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
          return block;
        }),
      })),
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
    };

    // system is top-level, only when present.
    if (req.system !== undefined) body.system = req.system;

    // Translate ToolDef.inputSchema → Anthropic's input_schema.
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
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
    let stopReason: 'end' | 'tool_use' | 'max_tokens' = 'end';

    // Currently streaming tool_use content block, if any.
    let currentTool: ToolBlockAcc | null = null;

    for await (const line of parseSse(response.body)) {
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
          if (usage) inputTokens = usage.input_tokens ?? 0;
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
          }
          break;
        }

        case 'content_block_stop': {
          if (currentTool) {
            yield parseTool(currentTool);
            currentTool = null;
          }
          break;
        }

        case 'message_delta': {
          const usage = evt.usage as Record<string, number> | undefined;
          if (usage) outputTokens += usage.output_tokens ?? 0;
          const delta = evt.delta as Record<string, unknown> | undefined;
          if (delta?.stop_reason) {
            stopReason = mapStopReason(delta.stop_reason as string);
          }
          break;
        }

        case 'message_stop': {
          if (inputTokens > 0 || outputTokens > 0) {
            yield { type: 'usage', inputTokens, outputTokens };
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

    // Stream ended without message_stop (truncated response or network drop).
    yield { type: 'done', stopReason };
  }
}

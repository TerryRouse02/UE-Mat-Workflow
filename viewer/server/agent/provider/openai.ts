// OpenAI-compatible Chat Completions streaming adapter.
// Handles OpenAI, DeepSeek, Qwen, Groq, Mistral, xAI, Ollama/LM Studio,
// and any server that speaks the OpenAI chat-completions dialect.
// fetchFn injection keeps this unit-testable with zero real network calls.

import { parseSse, abortSafe } from './sse.js';
import type {
  ChatRequest,
  LLMConfig,
  Message,
  Provider,
  StreamEvent,
  ToolResultBlock,
} from './types.js';

const DEFAULT_BASE = 'https://api.openai.com/v1';

type FetchFn = typeof globalThis.fetch;

// Per-index accumulator for streaming tool calls.
interface ToolCallAcc {
  id: string;
  name: string;
  argsRaw: string;
}

function mapFinishReason(r: string | null | undefined): 'end' | 'tool_use' | 'max_tokens' {
  if (r === 'tool_calls') return 'tool_use';
  if (r === 'length') return 'max_tokens';
  return 'end';
}

function parseTool(acc: ToolCallAcc): StreamEvent {
  // Empty args string (no-arg tool call) → treat as {}.
  const raw = acc.argsRaw.trim();
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

// Translate a neutral Message array to the OpenAI messages array.
// ORDER MATTERS: tool result messages must appear directly after the assistant
// tool_calls message; user text from the same neutral user message follows after.
function translateMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      // Separate tool_result blocks from text blocks within a user message.
      // OpenAI requires each tool result to be its own {role:'tool'} message
      // (placed first), with any remaining user text following as {role:'user'}.
      const toolResults = msg.content.filter((b): b is ToolResultBlock => b.type === 'tool_result');
      const textBlocks = msg.content.filter((b) => b.type === 'text');

      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: tr.toolUseId,
          content: tr.content,
        });
      }

      const imageBlocks = msg.content.filter((b) => b.type === 'image');
      if (imageBlocks.length > 0) {
        // Multimodal user message: content becomes an array of parts —
        // images as data-URI image_url entries, the joined text last.
        const parts: unknown[] = imageBlocks.map((b) => {
          const ib = b as { mediaType: string; data: string };
          return { type: 'image_url', image_url: { url: `data:${ib.mediaType};base64,${ib.data}` } };
        });
        const text = textBlocks.map((b) => (b as { text: string }).text).join('');
        if (text) parts.push({ type: 'text', text });
        out.push({ role: 'user', content: parts });
      } else if (textBlocks.length > 0) {
        const text = textBlocks.map((b) => (b as { text: string }).text).join('');
        out.push({ role: 'user', content: text });
      }
    } else if (msg.role === 'assistant') {
      // thinking / redacted_thinking blocks are Anthropic-only history; the
      // OpenAI dialect has no slot for them — drop silently.
      const textBlocks = msg.content.filter((b) => b.type === 'text');
      const toolUseBlocks = msg.content.filter((b) => b.type === 'tool_use');

      const apiMsg: Record<string, unknown> = { role: 'assistant' };

      // Joined text content or null when absent.
      if (textBlocks.length > 0) {
        apiMsg.content = textBlocks.map((b) => (b as { text: string }).text).join('');
      } else {
        apiMsg.content = null;
      }

      if (toolUseBlocks.length > 0) {
        apiMsg.tool_calls = toolUseBlocks.map((b) => {
          const tb = b as { id: string; name: string; input: unknown };
          return {
            id: tb.id,
            type: 'function',
            function: {
              name: tb.name,
              arguments: JSON.stringify(tb.input),
            },
          };
        });
      }

      out.push(apiMsg);
    }
  }

  return out;
}

// Build system message as leading {role:'system'} if present.
function buildMessages(req: ChatRequest): unknown[] {
  const out: unknown[] = [];
  if (req.system !== undefined) {
    out.push({ role: 'system', content: req.system });
  }
  out.push(...translateMessages(req.messages));
  return out;
}

export class OpenAIAdapter implements Provider {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchFn: FetchFn;

  constructor(config: LLMConfig, fetchFn: FetchFn = globalThis.fetch) {
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE;
    this.apiKey = config.apiKey;
    this.fetchFn = fetchFn;
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: buildMessages(req),
      stream: true,
      // stream_options required to receive the final usage chunk from OpenAI.
      stream_options: { include_usage: true },
    };

    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;

    // Reasoning-effort passthrough (o-series, DeepSeek-R1 endpoints, etc.).
    // Servers that don't support it return a 4xx the caller surfaces as-is.
    if (req.thinking !== undefined && req.thinking !== 'off') {
      body.reasoning_effort = req.thinking;
    }

    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // Authorization header only when apiKey is present (local Ollama may omit it).
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;

    const response = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!response.ok || !response.body) {
      let errText = '';
      try { errText = await response.text(); } catch { /* ignore */ }
      yield { type: 'error', message: `HTTP ${response.status}: ${errText}` };
      return;
    }

    // tool_calls accumulated by tc.index across all chunks.
    const toolAccByIndex = new Map<number, ToolCallAcc>();
    let stopReason: 'end' | 'tool_use' | 'max_tokens' = 'end';
    let capturedFinishReason: string | null = null;
    // OpenAI sends a final usage-only chunk, but some compat servers attach
    // usage to the last choices chunk instead — capture from anywhere, emit
    // at most once before done (last value wins; totals, not deltas).
    let lastUsage: { inputTokens: number; outputTokens: number } | null = null;

    // abortSafe: a user abort mid-stream is a normal cancellation — end the
    // stream silently instead of surfacing a fake error (see sse.ts).
    for await (const line of abortSafe(parseSse(response.body), req.signal)) {
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const usage = chunk.usage as Record<string, number> | undefined;
      if (usage) {
        lastUsage = {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
        };
      }

      const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
      if (!choices || choices.length === 0) continue;

      const choice = choices[0];
      const delta = choice.delta as Record<string, unknown> | undefined;
      const finishReason = choice.finish_reason as string | null | undefined;

      if (delta) {
        // Text delta.
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          yield { type: 'text_delta', text: delta.content };
        }

        // Reasoning stream (DeepSeek reasoning_content et al.) — display only;
        // the OpenAI dialect never round-trips reasoning into history.
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          yield { type: 'thinking_delta', text: delta.reasoning_content };
        }

        // Tool call fragments — accumulate by index.
        const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;
        if (toolCalls) {
          for (const tc of toolCalls) {
            // Some compat servers (Mistral, certain Ollama builds) omit
            // `index`. Without a fallback every fragment would collapse into
            // the same Map key and parallel calls would concatenate into one
            // broken arguments string. Fallback rule: a fragment carrying an
            // id starts a new entry; an id-less continuation extends the last.
            const fn = tc.function as Record<string, unknown> | undefined;
            const idx = typeof tc.index === 'number'
              ? tc.index
              : (tc.id ? toolAccByIndex.size : Math.max(0, toolAccByIndex.size - 1));

            if (!toolAccByIndex.has(idx)) {
              // First fragment carries id and name.
              toolAccByIndex.set(idx, {
                id: String(tc.id ?? ''),
                name: String(fn?.name ?? ''),
                argsRaw: '',
              });
            }

            const acc = toolAccByIndex.get(idx)!;
            // id/name may repeat on later fragments (harmless) — only update if non-empty.
            if (tc.id) acc.id = String(tc.id);
            if (fn?.name) acc.name = String(fn.name);
            if (fn?.arguments) acc.argsRaw += String(fn.arguments);
          }
        }
      }

      if (finishReason) {
        capturedFinishReason = finishReason;
        stopReason = mapFinishReason(finishReason);

        // Flush all accumulated tool calls on finish.
        if (finishReason === 'tool_calls') {
          const sortedIndices = [...toolAccByIndex.keys()].sort((a, b) => a - b);
          for (const idx of sortedIndices) {
            yield parseTool(toolAccByIndex.get(idx)!);
          }
          toolAccByIndex.clear();
        }
      }
    }

    // An aborted stream ends silently — no partial-tool flush, no done (the
    // loop's own signal check handles the turn teardown).
    if (req.signal?.aborted) return;

    // If we never saw a finish_reason (e.g. stream ended abruptly), still flush
    // any accumulated tool calls if we saw tool_calls type.
    if (capturedFinishReason === null && toolAccByIndex.size > 0) {
      const sortedIndices = [...toolAccByIndex.keys()].sort((a, b) => a - b);
      for (const idx of sortedIndices) {
        yield parseTool(toolAccByIndex.get(idx)!);
      }
    }

    if (lastUsage) yield { type: 'usage', ...lastUsage };
    yield { type: 'done', stopReason };
  }
}

// Re-export for consumers that need to inspect the translated body without
// running a full stream. Used by request-body translation tests.
export { buildMessages, translateMessages };

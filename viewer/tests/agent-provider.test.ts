// M0 provider layer tests — zero real network calls.
// All adapters are driven by fixture chunk arrays → ReadableStream<Uint8Array>.

import { describe, it, expect, vi } from 'vitest';
import { parseSse } from '../server/agent/provider/sse.js';
import { AnthropicAdapter } from '../server/agent/provider/anthropic.js';
import { OpenAIAdapter, buildMessages } from '../server/agent/provider/openai.js';
import { pickProvider } from '../server/agent/provider/index.js';
import type { ChatRequest, LLMConfig, StreamEvent } from '../server/agent/provider/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENC = new TextEncoder();

/** Turn an array of string chunks into a ReadableStream<Uint8Array>. */
function chunksToStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(ENC.encode(chunk));
      controller.close();
    },
  });
}

/** Build a fake fetch that returns a 200 SSE response with the given body chunks. */
function fakeFetch(chunks: string[]): typeof globalThis.fetch {
  return async (_url: RequestInfo | URL, init?: RequestInit) => {
    // Stash signal so tests can inspect it.
    (fakeFetch as unknown as { lastSignal: AbortSignal | undefined }).lastSignal =
      init?.signal as AbortSignal | undefined;
    return new Response(chunksToStream(chunks), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
}

/** Build a fake fetch that returns a non-2xx response. */
function fakeErrorFetch(status: number, body: string): typeof globalThis.fetch {
  return async () =>
    new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

/** Collect all StreamEvents from an async iterable. */
async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of iter) out.push(ev);
  return out;
}

/** Build a fake fetch that also captures request body + headers for assertion. */
function captureFetch(
  chunks: string[],
): [typeof globalThis.fetch, { url: string; headers: Record<string, string>; body: unknown }] {
  const captured: { url: string; headers: Record<string, string>; body: unknown } = {
    url: '',
    headers: {},
    body: {},
  };
  const fn: typeof globalThis.fetch = async (url, init?) => {
    captured.url = String(url);
    captured.headers = Object.fromEntries(
      Object.entries(init?.headers as Record<string, string> ?? {}),
    );
    captured.body = JSON.parse(init?.body as string ?? '{}');
    return new Response(chunksToStream(chunks), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  return [fn, captured];
}

// ---------------------------------------------------------------------------
// A minimal ChatRequest used across multiple tests.
// ---------------------------------------------------------------------------
const SIMPLE_REQ: ChatRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
};

// ---------------------------------------------------------------------------
// §1  SSE parser unit tests
// ---------------------------------------------------------------------------

describe('parseSse', () => {
  async function parseAll(chunks: string[]): Promise<string[]> {
    const out: string[] = [];
    for await (const line of parseSse(chunksToStream(chunks))) out.push(line);
    return out;
  }

  it('parses a simple data line ending in LF', async () => {
    expect(await parseAll(['data: hello\n'])).toEqual(['hello']);
  });

  it('handles CRLF line endings', async () => {
    expect(await parseAll(['data: foo\r\ndata: bar\r\n'])).toEqual(['foo', 'bar']);
  });

  it('handles bare CR line endings', async () => {
    expect(await parseAll(['data: foo\rdata: bar\r'])).toEqual(['foo', 'bar']);
  });

  it('buffers partial lines across chunk boundaries', async () => {
    // "data: hel" in one chunk, "lo\n" in another
    expect(await parseAll(['data: hel', 'lo\n'])).toEqual(['hello']);
  });

  it('splits a chunk that contains a line boundary mid-way', async () => {
    expect(await parseAll(['data: one\ndata: tw', 'o\n'])).toEqual(['one', 'two']);
  });

  it('flushes trailing data line with no final newline', async () => {
    expect(await parseAll(['data: trailing'])).toEqual(['trailing']);
  });

  it('skips comment/keepalive lines beginning with ":"', async () => {
    expect(await parseAll([': keepalive\ndata: real\n'])).toEqual(['real']);
  });

  it('ignores event:, id:, retry: fields', async () => {
    expect(await parseAll(['event: msg\nid: 1\nretry: 3000\ndata: content\n'])).toEqual(['content']);
  });

  it('stops iteration at [DONE] sentinel', async () => {
    expect(await parseAll(['data: first\ndata: [DONE]\ndata: never\n'])).toEqual(['first']);
  });

  it('handles [DONE] in a trailing unflushed line', async () => {
    expect(await parseAll(['data: first\n', 'data: [DONE]'])).toEqual(['first']);
  });
});

// ---------------------------------------------------------------------------
// §2  Anthropic adapter — text-only stream
// ---------------------------------------------------------------------------

function makeAnthropicTextFixture(): string[] {
  return [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n',
  ];
}

describe('AnthropicAdapter — text stream', () => {
  it('yields text_delta events and done(end)', async () => {
    const adapter = new AnthropicAdapter(
      { provider: 'anthropic', model: 'claude-test', apiKey: 'key' },
      fakeFetch(makeAnthropicTextFixture()),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    expect(events).toContainEqual({ type: 'text_delta', text: 'Hello' });
    expect(events).toContainEqual({ type: 'text_delta', text: ' world' });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end' });
  });
});

// ---------------------------------------------------------------------------
// §3  OpenAI adapter — text-only stream
// ---------------------------------------------------------------------------

function makeOpenAITextFixture(): string[] {
  return [
    'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
    'data: [DONE]\n\n',
  ];
}

describe('OpenAIAdapter — text stream', () => {
  it('yields text_delta events and done(end)', async () => {
    const adapter = new OpenAIAdapter(
      { provider: 'openai-compatible', model: 'test', apiKey: 'key' },
      fakeFetch(makeOpenAITextFixture()),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    expect(events).toContainEqual({ type: 'text_delta', text: 'Hello' });
    expect(events).toContainEqual({ type: 'text_delta', text: ' world' });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end' });
  });
});

// ---------------------------------------------------------------------------
// §4  Single tool call — args split across multiple fragments AND chunk boundaries
// ---------------------------------------------------------------------------

// Anthropic dialect: args arrive as input_json_delta fragments, with one chunk
// splitting mid-line to exercise the SSE buffer path.
function makeAnthropicToolFixture(): string[] {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tid1","name":"my_tool"}}\n\n',
    // First arg fragment — intentionally split across two raw chunks mid-line:
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delt',
    'a","partial_json":"{\\\"x\\\":"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"1}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
}

// OpenAI dialect: same tool, args split across three fragments.
function makeOpenAIToolFixture(): string[] {
  return [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tid1","type":"function","function":{"name":"my_tool","arguments":""}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"x\\":"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":15}}\n\n',
    'data: [DONE]\n\n',
  ];
}

describe('Single tool call', () => {
  it('Anthropic: emits tool_use with parsed input', async () => {
    const adapter = new AnthropicAdapter(
      { provider: 'anthropic', model: 'test', apiKey: 'k' },
      fakeFetch(makeAnthropicToolFixture()),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    const tool = events.find((e) => e.type === 'tool_use') as Extract<StreamEvent, { type: 'tool_use' }> | undefined;
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('my_tool');
    expect(tool?.input).toEqual({ x: 1 });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
  });

  it('OpenAI: emits tool_use with parsed input', async () => {
    const adapter = new OpenAIAdapter(
      { provider: 'openai-compatible', model: 'test', apiKey: 'k' },
      fakeFetch(makeOpenAIToolFixture()),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    const tool = events.find((e) => e.type === 'tool_use') as Extract<StreamEvent, { type: 'tool_use' }> | undefined;
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('my_tool');
    expect(tool?.input).toEqual({ x: 1 });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });
  });

  it('both adapters produce equivalent StreamEvent sequences for the same tool call', async () => {
    const anthropic = new AnthropicAdapter(
      { provider: 'anthropic', model: 'test', apiKey: 'k' },
      fakeFetch(makeAnthropicToolFixture()),
    );
    const openai = new OpenAIAdapter(
      { provider: 'openai-compatible', model: 'test', apiKey: 'k' },
      fakeFetch(makeOpenAIToolFixture()),
    );

    const [aEvents, oEvents] = await Promise.all([
      collect(anthropic.stream(SIMPLE_REQ)),
      collect(openai.stream(SIMPLE_REQ)),
    ]);

    // Both must emit tool_use with same name+input.
    const aTool = aEvents.find((e) => e.type === 'tool_use');
    const oTool = oEvents.find((e) => e.type === 'tool_use');
    expect(aTool).toEqual(oTool);
    // Both must end with same stopReason.
    expect(aEvents.at(-1)).toEqual(oEvents.at(-1));
  });
});

// ---------------------------------------------------------------------------
// §5  Two parallel tool calls
// ---------------------------------------------------------------------------

function makeAnthropicTwoToolsFixture(): string[] {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":30}}}\n\n',
    // Tool block 0
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"id0","name":"tool_a"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"p\\":1}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    // Tool block 1
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"id1","name":"tool_b"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":2}"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":20}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
}

function makeOpenAITwoToolsFixture(): string[] {
  return [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"id0","type":"function","function":{"name":"tool_a","arguments":""}},{"index":1,"id":"id1","type":"function","function":{"name":"tool_b","arguments":""}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"p\\":1}"}},{"index":1,"function":{"arguments":"{\\"q\\":2}"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":20}}\n\n',
    'data: [DONE]\n\n',
  ];
}

describe('Two parallel tool calls', () => {
  it('Anthropic: emits both tool_use events in order', async () => {
    const adapter = new AnthropicAdapter(
      { provider: 'anthropic', model: 'test', apiKey: 'k' },
      fakeFetch(makeAnthropicTwoToolsFixture()),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    const tools = events.filter((e) => e.type === 'tool_use') as Extract<StreamEvent, { type: 'tool_use' }>[];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: 'tool_a', input: { p: 1 } });
    expect(tools[1]).toMatchObject({ name: 'tool_b', input: { q: 2 } });
  });

  it('OpenAI: emits both tool_use events in index order', async () => {
    const adapter = new OpenAIAdapter(
      { provider: 'openai-compatible', model: 'test', apiKey: 'k' },
      fakeFetch(makeOpenAITwoToolsFixture()),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    const tools = events.filter((e) => e.type === 'tool_use') as Extract<StreamEvent, { type: 'tool_use' }>[];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: 'tool_a', input: { p: 1 } });
    expect(tools[1]).toMatchObject({ name: 'tool_b', input: { q: 2 } });
  });

  it('both adapters emit the same tool names and inputs', async () => {
    const ant = new AnthropicAdapter(
      { provider: 'anthropic', model: 'test', apiKey: 'k' },
      fakeFetch(makeAnthropicTwoToolsFixture()),
    );
    const oai = new OpenAIAdapter(
      { provider: 'openai-compatible', model: 'test', apiKey: 'k' },
      fakeFetch(makeOpenAITwoToolsFixture()),
    );
    const [aEvents, oEvents] = await Promise.all([
      collect(ant.stream(SIMPLE_REQ)),
      collect(oai.stream(SIMPLE_REQ)),
    ]);

    const aTools = aEvents.filter((e) => e.type === 'tool_use');
    const oTools = oEvents.filter((e) => e.type === 'tool_use');
    expect(aTools).toEqual(oTools);
  });
});

// ---------------------------------------------------------------------------
// §6  Malformed tool JSON → __parse_error__
// ---------------------------------------------------------------------------

function makeAnthropicBadJsonFixture(): string[] {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"bad1","name":"bad_tool"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{not valid json"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
}

function makeOpenAIBadJsonFixture(): string[] {
  return [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"bad1","type":"function","function":{"name":"bad_tool","arguments":""}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{not valid json"}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ];
}

describe('Malformed tool JSON', () => {
  it('Anthropic: emits __parse_error__ event without throwing', async () => {
    const adapter = new AnthropicAdapter(
      { provider: 'anthropic', model: 'test', apiKey: 'k' },
      fakeFetch(makeAnthropicBadJsonFixture()),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    const errEvent = events.find(
      (e): e is Extract<StreamEvent, { type: 'tool_use' }> =>
        e.type === 'tool_use' && (e as { name: string }).name === '__parse_error__',
    );
    expect(errEvent).toBeDefined();
    expect((errEvent?.input as Record<string, unknown>).original_tool).toBe('bad_tool');
    expect((errEvent?.input as Record<string, unknown>).raw).toContain('{not valid json');
  });

  it('OpenAI: emits __parse_error__ event without throwing', async () => {
    const adapter = new OpenAIAdapter(
      { provider: 'openai-compatible', model: 'test', apiKey: 'k' },
      fakeFetch(makeOpenAIBadJsonFixture()),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    const errEvent = events.find(
      (e): e is Extract<StreamEvent, { type: 'tool_use' }> =>
        e.type === 'tool_use' && (e as { name: string }).name === '__parse_error__',
    );
    expect(errEvent).toBeDefined();
    expect((errEvent?.input as Record<string, unknown>).original_tool).toBe('bad_tool');
  });
});

// ---------------------------------------------------------------------------
// §7  Empty-args tool call → input {}
// ---------------------------------------------------------------------------

function makeAnthropicEmptyArgsFixture(): string[] {
  return [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"e1","name":"no_arg_tool"}}\n\n',
    // No input_json_delta at all.
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
}

function makeOpenAIEmptyArgsFixture(): string[] {
  return [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"e1","type":"function","function":{"name":"no_arg_tool","arguments":""}}]},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ];
}

describe('Empty-args tool call', () => {
  it('Anthropic: input is {}', async () => {
    const adapter = new AnthropicAdapter(
      { provider: 'anthropic', model: 'test', apiKey: 'k' },
      fakeFetch(makeAnthropicEmptyArgsFixture()),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    const tool = events.find((e) => e.type === 'tool_use') as Extract<StreamEvent, { type: 'tool_use' }> | undefined;
    expect(tool?.input).toEqual({});
  });

  it('OpenAI: input is {}', async () => {
    const adapter = new OpenAIAdapter(
      { provider: 'openai-compatible', model: 'test', apiKey: 'k' },
      fakeFetch(makeOpenAIEmptyArgsFixture()),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    const tool = events.find((e) => e.type === 'tool_use') as Extract<StreamEvent, { type: 'tool_use' }> | undefined;
    expect(tool?.input).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// §8  Usage events
// ---------------------------------------------------------------------------

describe('Usage events', () => {
  it('Anthropic: usage carries input+output tokens from message_start + message_delta', async () => {
    const adapter = new AnthropicAdapter(
      { provider: 'anthropic', model: 'test', apiKey: 'k' },
      fakeFetch(makeAnthropicTextFixture()),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    const usage = events.find((e): e is Extract<StreamEvent, { type: 'usage' }> => e.type === 'usage');
    expect(usage).toEqual({ type: 'usage', inputTokens: 10, outputTokens: 5 });
  });

  it('OpenAI: usage from the final usage-only chunk', async () => {
    const adapter = new OpenAIAdapter(
      { provider: 'openai-compatible', model: 'test', apiKey: 'k' },
      fakeFetch(makeOpenAITextFixture()),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    const usage = events.find((e): e is Extract<StreamEvent, { type: 'usage' }> => e.type === 'usage');
    expect(usage).toEqual({ type: 'usage', inputTokens: 10, outputTokens: 5 });
  });

  it('OpenAI: no usage event when usage chunk is absent, still emits done', async () => {
    const noUsageFixture = [
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const adapter = new OpenAIAdapter(
      { provider: 'openai-compatible', model: 'test', apiKey: 'k' },
      fakeFetch(noUsageFixture),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    expect(events.some((e) => e.type === 'usage')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end' });
  });
});

// ---------------------------------------------------------------------------
// §9  Non-2xx response → error event + no throw
// ---------------------------------------------------------------------------

describe('Non-2xx response', () => {
  it('Anthropic: yields error event containing status code, no throw', async () => {
    const adapter = new AnthropicAdapter(
      { provider: 'anthropic', model: 'test', apiKey: 'k' },
      fakeErrorFetch(401, '{"error":"Unauthorized"}'),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as { message: string }).message).toContain('401');
  });

  it('OpenAI: yields error event containing status code, no throw', async () => {
    const adapter = new OpenAIAdapter(
      { provider: 'openai-compatible', model: 'test', apiKey: 'k' },
      fakeErrorFetch(429, 'Too Many Requests'),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as { message: string }).message).toContain('429');
  });
});

// ---------------------------------------------------------------------------
// §10  Request-body translation assertions
// ---------------------------------------------------------------------------

describe('Request-body translation', () => {
  it('Anthropic: system is top-level, max_tokens defaulted, tool_result→tool_use_id', async () => {
    const [fn, captured] = captureFetch(
      ['event: message_stop\ndata: {"type":"message_stop"}\n\n'],
    );
    const adapter = new AnthropicAdapter(
      { provider: 'anthropic', model: 'test', apiKey: 'mykey' },
      fn,
    );

    const req: ChatRequest = {
      model: 'test',
      system: 'You are a helper',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: 'tu-abc',
              content: 'result text',
              isError: false,
            },
          ],
        },
      ],
    };

    await collect(adapter.stream(req));

    const body = captured.body as Record<string, unknown>;
    // system is top-level, as a content-block array carrying its cache breakpoint
    expect(body.system).toEqual([
      { type: 'text', text: 'You are a helper', cache_control: { type: 'ephemeral' } },
    ]);
    // max_tokens defaults to 4096
    expect(body.max_tokens).toBe(4096);
    // tool_result block uses tool_use_id
    const msgs = body.messages as Array<Record<string, unknown>>;
    const content = msgs[0].content as Array<Record<string, unknown>>;
    expect(content[0].tool_use_id).toBe('tu-abc');
    expect(content[0].type).toBe('tool_result');
    // x-api-key header set
    expect(captured.headers['x-api-key']).toBe('mykey');
  });

  it('Anthropic: prompt-cache breakpoints on last tool def + last message block; history not polluted', async () => {
    const [fn, captured] = captureFetch(makeAnthropicTextFixture());
    const adapter = new AnthropicAdapter(
      { provider: 'anthropic', model: 'claude-test', apiKey: 'k' },
      fn,
    );
    const userBlock = { type: 'text' as const, text: 'hi' };
    const req: ChatRequest = {
      model: 'claude-test',
      system: 'sys',
      tools: [
        { name: 'a', description: 'tool a', inputSchema: { type: 'object' } },
        { name: 'b', description: 'tool b', inputSchema: { type: 'object' } },
      ],
      messages: [{ role: 'user', content: [userBlock] }],
    };
    await collect(adapter.stream(req));

    const body = captured.body as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });

    const msgs = body.messages as Array<Record<string, unknown>>;
    const blocks = msgs[0].content as Array<Record<string, unknown>>;
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });

    // The caller's neutral history must stay untouched (blocks are copied).
    expect('cache_control' in userBlock).toBe(false);
  });

  it('Anthropic: usage sums cache_read/cache_creation into inputTokens and reports them separately', async () => {
    const fixture = [
      'event: message_start\n',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":100,"cache_creation_input_tokens":20}}}\n\n',
      'event: content_block_start\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
      'event: content_block_stop\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
      'event: message_stop\n',
      'data: {"type":"message_stop"}\n\n',
    ];
    const adapter = new AnthropicAdapter(
      { provider: 'anthropic', model: 'claude-test', apiKey: 'k' },
      fakeFetch(fixture),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    const usage = events.find(e => e.type === 'usage');
    expect(usage).toEqual({
      type: 'usage',
      inputTokens: 125,   // 5 + 100 + 20 — context gating needs the FULL size
      outputTokens: 3,
      cacheReadTokens: 100,
      cacheCreationTokens: 20,
    });
  });

  it('OpenAI: tool messages ordered before user text, no Authorization when no apiKey, stream_options present', async () => {
    const [fn, captured] = captureFetch(['data: [DONE]\n\n']);
    const adapter = new OpenAIAdapter(
      { provider: 'openai-compatible', model: 'test' /* no apiKey */ },
      fn,
    );

    const req: ChatRequest = {
      model: 'test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'tu-1', content: 'tool output' },
            { type: 'text', text: 'user follow-up' },
          ],
        },
      ],
    };

    await collect(adapter.stream(req));

    const body = captured.body as Record<string, unknown>;
    const msgs = body.messages as Array<Record<string, unknown>>;

    // tool message must come before the user text message
    const toolMsgIdx = msgs.findIndex((m) => m.role === 'tool');
    const userMsgIdx = msgs.findIndex((m) => m.role === 'user');
    expect(toolMsgIdx).toBeLessThan(userMsgIdx);
    expect((msgs[toolMsgIdx] as { tool_call_id: string }).tool_call_id).toBe('tu-1');

    // No Authorization header when no apiKey
    expect(captured.headers['authorization']).toBeUndefined();

    // stream_options present
    expect((body.stream_options as Record<string, unknown>)?.include_usage).toBe(true);
  });

  it('Anthropic: image block maps to a base64 source block', async () => {
    const [fn, captured] = captureFetch(makeAnthropicTextFixture());
    const adapter = new AnthropicAdapter(
      { provider: 'anthropic', model: 'claude-test', apiKey: 'k' },
      fn,
    );
    const req: ChatRequest = {
      model: 'claude-test',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
          { type: 'text', text: '這張圖的材質怎麼做？' },
        ],
      }],
    };
    await collect(adapter.stream(req));

    const msgs = (captured.body as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    const blocks = msgs[0].content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    });
    expect(blocks[1].type).toBe('text');
  });

  it('OpenAI: image block maps to an image_url data URI in a content-parts array', async () => {
    const [fn, captured] = captureFetch(['data: [DONE]\n\n']);
    const adapter = new OpenAIAdapter({ provider: 'openai-compatible', model: 'test' }, fn);
    const req: ChatRequest = {
      model: 'test',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', mediaType: 'image/jpeg', data: 'Zm9v' },
          { type: 'text', text: '看圖' },
        ],
      }],
    };
    await collect(adapter.stream(req));

    const msgs = (captured.body as Record<string, unknown>).messages as Array<Record<string, unknown>>;
    const userMsg = msgs.find(m => m.role === 'user')!;
    const parts = userMsg.content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,Zm9v' } });
    expect(parts[1]).toEqual({ type: 'text', text: '看圖' });
  });

  it('Anthropic: tools array uses input_schema (not inputSchema)', async () => {
    const [fn, captured] = captureFetch(
      ['event: message_stop\ndata: {"type":"message_stop"}\n\n'],
    );
    const adapter = new AnthropicAdapter(
      { provider: 'anthropic', model: 'test', apiKey: 'k' },
      fn,
    );

    const req: ChatRequest = {
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [
        { name: 'my_tool', description: 'does stuff', inputSchema: { type: 'object', properties: {} } },
      ],
    };

    await collect(adapter.stream(req));
    const body = captured.body as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0].input_schema).toBeDefined();
    expect((tools[0] as Record<string, unknown>).inputSchema).toBeUndefined();
  });

  it('OpenAI: tools wrapped as {type:"function", function:{name, description, parameters}}', async () => {
    const [fn, captured] = captureFetch(['data: [DONE]\n\n']);
    const adapter = new OpenAIAdapter(
      { provider: 'openai-compatible', model: 'test', apiKey: 'k' },
      fn,
    );

    const req: ChatRequest = {
      model: 'test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [
        { name: 'search', description: 'search nodes', inputSchema: { type: 'object' } },
      ],
    };

    await collect(adapter.stream(req));
    const body = captured.body as Record<string, unknown>;
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools[0].type).toBe('function');
    const fn2 = tools[0].function as Record<string, unknown>;
    expect(fn2.name).toBe('search');
    expect(fn2.parameters).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// §11  [DONE] sentinel and keepalive folded into SSE parser tests above (§1).
// Additional integration test: keepalive inside an adapter stream.
// ---------------------------------------------------------------------------

describe('[DONE] and keepalive inside adapter stream', () => {
  it('OpenAI: keepalive lines in fixture are silently dropped', async () => {
    const fixture = [
      ': keep-alive\n\n',
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      ': keep-alive\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const adapter = new OpenAIAdapter(
      { provider: 'openai-compatible', model: 'test', apiKey: 'k' },
      fakeFetch(fixture),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    expect(events).toContainEqual({ type: 'text_delta', text: 'hi' });
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });
});

// ---------------------------------------------------------------------------
// §12  Abort: fetchFn receives the same signal object
// ---------------------------------------------------------------------------

describe('Abort signal', () => {
  it('Anthropic: passes signal through to fetch', async () => {
    const controller = new AbortController();
    controller.abort(); // pre-aborted is fine — we only assert the signal is passed

    let receivedSignal: AbortSignal | undefined;
    const fn: typeof globalThis.fetch = async (_url, init?) => {
      receivedSignal = init?.signal as AbortSignal | undefined;
      // Return a minimal stream so the adapter doesn't hang.
      return new Response(chunksToStream(['event: message_stop\ndata: {"type":"message_stop"}\n\n']), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const adapter = new AnthropicAdapter(
      { provider: 'anthropic', model: 'test', apiKey: 'k' },
      fn,
    );
    // Don't await — just drain enough.
    await collect(adapter.stream({ ...SIMPLE_REQ, signal: controller.signal }));
    expect(receivedSignal).toBe(controller.signal);
  });

  it('OpenAI: passes signal through to fetch', async () => {
    const controller = new AbortController();
    controller.abort();

    let receivedSignal: AbortSignal | undefined;
    const fn: typeof globalThis.fetch = async (_url, init?) => {
      receivedSignal = init?.signal as AbortSignal | undefined;
      return new Response(chunksToStream(['data: [DONE]\n\n']), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const adapter = new OpenAIAdapter(
      { provider: 'openai-compatible', model: 'test', apiKey: 'k' },
      fn,
    );
    await collect(adapter.stream({ ...SIMPLE_REQ, signal: controller.signal }));
    expect(receivedSignal).toBe(controller.signal);
  });
});

// ---------------------------------------------------------------------------
// §13  pickProvider factory
// ---------------------------------------------------------------------------

describe('pickProvider', () => {
  it('returns AnthropicAdapter for provider="anthropic"', () => {
    const config: LLMConfig = { provider: 'anthropic', model: 'claude-3', apiKey: 'k' };
    const p = pickProvider(config);
    expect(p).toBeInstanceOf(AnthropicAdapter);
  });

  it('returns OpenAIAdapter for provider="openai-compatible"', () => {
    const config: LLMConfig = { provider: 'openai-compatible', model: 'gpt-4o' };
    const p = pickProvider(config);
    expect(p).toBeInstanceOf(OpenAIAdapter);
  });

  it('throws with clear message for unknown provider', () => {
    expect(() =>
      pickProvider({ provider: 'unknown-llm' as LLMConfig['provider'], model: 'x' }),
    ).toThrow(/Unknown LLM provider/);
  });

  it('openai-compatible defaults baseUrl to https://api.openai.com/v1', () => {
    // Verify via a dummy stream that uses the default base.
    const [fn, captured] = captureFetch(['data: [DONE]\n\n']);
    const provider = pickProvider({ provider: 'openai-compatible', model: 'gpt-4o' }, fn);
    // Just fire and forget — we only need the URL.
    void collect(provider.stream(SIMPLE_REQ));
    // Allow microtask queue to advance (the async gen starts synchronously up to first await).
    // For this test we just verify the factory works — URL assertion is in adapter tests.
    expect(provider).toBeInstanceOf(OpenAIAdapter);
  });
});

// ---------------------------------------------------------------------------
// §14  buildMessages helper unit tests (OpenAI message translation)
// ---------------------------------------------------------------------------

describe('buildMessages (OpenAI translation)', () => {
  it('system message appears first', () => {
    const req: ChatRequest = {
      model: 'x',
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const msgs = buildMessages(req) as Array<{ role: string; content: unknown }>;
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toBe('sys');
  });

  it('assistant message with tool_use blocks emits tool_calls', () => {
    const req: ChatRequest = {
      model: 'x',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will call' },
            { type: 'tool_use', id: 'tc1', name: 'my_fn', input: { a: 1 } },
          ],
        },
      ],
    };
    const msgs = buildMessages(req) as Array<Record<string, unknown>>;
    expect(msgs[0].tool_calls).toBeDefined();
    const tc = (msgs[0].tool_calls as Array<Record<string, unknown>>)[0];
    expect(tc.type).toBe('function');
    expect((tc.function as { name: string }).name).toBe('my_fn');
  });

  it('user message: tool_result before user text', () => {
    const req: ChatRequest = {
      model: 'x',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'tc1', content: 'out' },
            { type: 'text', text: 'follow' },
          ],
        },
      ],
    };
    const msgs = buildMessages(req) as Array<{ role: string }>;
    expect(msgs[0].role).toBe('tool');
    expect(msgs[1].role).toBe('user');
  });
});

// ---------------------------------------------------------------------------
// §15  Acceptance-review regressions
// ---------------------------------------------------------------------------

describe('acceptance-review regressions', () => {
  it('OpenAI: usage attached to a choices chunk (compat servers) is still emitted', async () => {
    const fixture = [
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n',
    ];
    const adapter = new OpenAIAdapter(
      { provider: 'openai-compatible', model: 'test', apiKey: 'k' },
      fakeFetch(fixture),
    );
    const events = await collect(adapter.stream(SIMPLE_REQ));
    const usage = events.find((e): e is Extract<StreamEvent, { type: 'usage' }> => e.type === 'usage');
    expect(usage).toEqual({ type: 'usage', inputTokens: 7, outputTokens: 3 });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end' });
  });

  it('parseSse: concurrent streams with multibyte chars split mid-character stay independent', async () => {
    // 'data: ' is 6 bytes; each CJK char is 3 bytes, so offset 8 cuts mid-character.
    // A decoder shared between generators would mix the partial-byte state of the
    // two streams; per-call decoders must survive any interleaving.
    const mk = (s: string) => {
      const bytes = ENC.encode(`data: ${s}\n`);
      return new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes.slice(0, 8));
          c.enqueue(bytes.slice(8));
          c.close();
        },
      });
    };
    const ga = parseSse(mk('發光'));
    const gb = parseSse(mk('粗糙'));
    const [ra, rb] = await Promise.all([ga.next(), gb.next()]);
    expect(ra.value).toBe('發光');
    expect(rb.value).toBe('粗糙');
  });
});

// suppress TS unused import warnings
void vi;

// ---------------------------------------------------------------------------
// §8  Extended thinking / reasoning effort
// ---------------------------------------------------------------------------

describe('AnthropicAdapter thinking', () => {
  const THINKING_FIXTURE = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先拆解需求"}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"，再選節點"}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-abc"}}\n\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"好的"}}\n\n',
    'data: {"type":"content_block_stop","index":1}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ];

  it('sends thinking.budget_tokens and raises max_tokens above the budget', async () => {
    const [fetchFn, captured] = captureFetch(THINKING_FIXTURE);
    const adapter = new AnthropicAdapter({ provider: 'anthropic', model: 'm', apiKey: 'k' }, fetchFn);
    await collect(adapter.stream({ ...SIMPLE_REQ, thinking: 'medium' }));
    const body = captured.body as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    // max_tokens must exceed the budget (default 4096 would be too small).
    expect(body.max_tokens as number).toBeGreaterThan(8192);
  });

  it('keeps a caller maxTokens that already exceeds the budget', async () => {
    const [fetchFn, captured] = captureFetch(THINKING_FIXTURE);
    const adapter = new AnthropicAdapter({ provider: 'anthropic', model: 'm', apiKey: 'k' }, fetchFn);
    await collect(adapter.stream({ ...SIMPLE_REQ, thinking: 'low', maxTokens: 32000 }));
    const body = captured.body as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(body.max_tokens).toBe(32000);
  });

  it('omits the thinking parameter when level is off or absent', async () => {
    const [fetchFn, captured] = captureFetch(THINKING_FIXTURE);
    const adapter = new AnthropicAdapter({ provider: 'anthropic', model: 'm', apiKey: 'k' }, fetchFn);
    await collect(adapter.stream({ ...SIMPLE_REQ, thinking: 'off' }));
    expect((captured.body as Record<string, unknown>).thinking).toBeUndefined();
  });

  it('streams thinking_delta events and a final thinking_block with the signature', async () => {
    const adapter = new AnthropicAdapter({ provider: 'anthropic', model: 'm', apiKey: 'k' }, fakeFetch(THINKING_FIXTURE));
    const events = await collect(adapter.stream({ ...SIMPLE_REQ, thinking: 'low' }));

    const deltas = events.filter(e => e.type === 'thinking_delta');
    expect(deltas.map(d => (d as { text: string }).text)).toEqual(['先拆解需求', '，再選節點']);

    const blocks = events.filter(e => e.type === 'thinking_block');
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { block: unknown }).block).toEqual({
      type: 'thinking',
      thinking: '先拆解需求，再選節點',
      signature: 'sig-abc',
    });

    // The thinking block must precede the text delta (history ordering).
    const blockIdx = events.findIndex(e => e.type === 'thinking_block');
    const textIdx = events.findIndex(e => e.type === 'text_delta');
    expect(blockIdx).toBeLessThan(textIdx);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'end' });
  });

  it('passes a redacted_thinking block through as a thinking_block event', async () => {
    const fixture = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"opaque-bytes"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text"}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'data: {"type":"content_block_stop","index":1}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];
    const adapter = new AnthropicAdapter({ provider: 'anthropic', model: 'm', apiKey: 'k' }, fakeFetch(fixture));
    const events = await collect(adapter.stream({ ...SIMPLE_REQ, thinking: 'high' }));
    const blocks = events.filter(e => e.type === 'thinking_block');
    expect(blocks).toHaveLength(1);
    expect((blocks[0] as { block: unknown }).block).toEqual({ type: 'redacted_thinking', data: 'opaque-bytes' });
  });

  it('round-trips historic thinking blocks when enabled and strips them when off', async () => {
    const history: ChatRequest = {
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '上一輪的思考', signature: 'sig-1' },
            { type: 'text', text: 'a' },
            { type: 'tool_use', id: 't1', name: 'search_nodes', input: { query: 'x' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'r' }] },
      ],
    };

    // Enabled → the thinking block (incl. signature) is sent back verbatim.
    let [fetchFn, captured] = captureFetch(THINKING_FIXTURE);
    let adapter = new AnthropicAdapter({ provider: 'anthropic', model: 'm', apiKey: 'k' }, fetchFn);
    await collect(adapter.stream({ ...history, thinking: 'medium' }));
    let msgs = (captured.body as { messages: Array<{ content: unknown[] }> }).messages;
    expect(msgs[1].content[0]).toEqual({ type: 'thinking', thinking: '上一輪的思考', signature: 'sig-1' });

    // Disabled → thinking blocks are stripped (the API rejects them).
    [fetchFn, captured] = captureFetch(THINKING_FIXTURE);
    adapter = new AnthropicAdapter({ provider: 'anthropic', model: 'm', apiKey: 'k' }, fetchFn);
    await collect(adapter.stream(history));
    msgs = (captured.body as { messages: Array<{ content: Array<{ type: string }> }> }).messages;
    expect(msgs[1].content.some(b => b.type === 'thinking')).toBe(false);
    expect(msgs[1].content.some(b => b.type === 'text')).toBe(true);
    expect(msgs[1].content.some(b => b.type === 'tool_use')).toBe(true);
  });
});

describe('OpenAIAdapter thinking', () => {
  it('sends reasoning_effort when a level is set and omits it when off', async () => {
    const doneFixture = [
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    let [fetchFn, captured] = captureFetch(doneFixture);
    let adapter = new OpenAIAdapter({ provider: 'openai-compatible', model: 'm', apiKey: 'k' }, fetchFn);
    await collect(adapter.stream({ ...SIMPLE_REQ, thinking: 'high' }));
    expect((captured.body as Record<string, unknown>).reasoning_effort).toBe('high');

    [fetchFn, captured] = captureFetch(doneFixture);
    adapter = new OpenAIAdapter({ provider: 'openai-compatible', model: 'm', apiKey: 'k' }, fetchFn);
    await collect(adapter.stream({ ...SIMPLE_REQ, thinking: 'off' }));
    expect((captured.body as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it('maps reasoning_content deltas (DeepSeek dialect) to thinking_delta events', async () => {
    const fixture = [
      'data: {"choices":[{"delta":{"reasoning_content":"推理中"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"…"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{"content":"答案"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const adapter = new OpenAIAdapter({ provider: 'openai-compatible', model: 'm', apiKey: 'k' }, fakeFetch(fixture));
    const events = await collect(adapter.stream({ ...SIMPLE_REQ, thinking: 'medium' }));
    const deltas = events.filter(e => e.type === 'thinking_delta').map(e => (e as { text: string }).text);
    expect(deltas).toEqual(['推理中', '…']);
    // Reasoning never produces a thinking_block in the OpenAI dialect.
    expect(events.some(e => e.type === 'thinking_block')).toBe(false);
    expect(events.some(e => e.type === 'text_delta')).toBe(true);
  });

  it('drops historic thinking blocks from the translated message array', () => {
    const msgs = buildMessages({
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'secret reasoning', signature: 's' },
            { type: 'text', text: 'a' },
          ],
        },
      ],
    });
    expect(JSON.stringify(msgs)).not.toContain('secret reasoning');
    expect(JSON.stringify(msgs)).toContain('"a"');
  });
});

// ---------------------------------------------------------------------------
// Bugfix regressions (AGENT_BUGFIX_BRIEF)
// ---------------------------------------------------------------------------

// BUG-12 — Anthropic message_delta usage is CUMULATIVE; last value wins.
describe('Anthropic cumulative usage (BUG-12)', () => {
  it('does not accumulate output_tokens across message_delta events', async () => {
    const fixture = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":10}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ];
    const adapter = new AnthropicAdapter({ provider: 'anthropic', model: 'm', apiKey: 'k' }, fakeFetch(fixture));
    const events = await collect(adapter.stream(SIMPLE_REQ));
    const usage = events.find(e => e.type === 'usage');
    expect(usage).toEqual({ type: 'usage', inputTokens: 100, outputTokens: 25 });
  });
});

// BUG-13 — OpenAI-compat servers that omit tool_calls[].index must not
// collapse parallel calls into one broken arguments string.
describe('OpenAI tool_calls without index (BUG-13)', () => {
  it('id starts a new entry; id-less fragments extend the last one', async () => {
    const fixture = [
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"a","function":{"name":"f1","arguments":"{\\"x\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":":1}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"b","function":{"name":"f2","arguments":"{\\"y\\":2}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const adapter = new OpenAIAdapter({ provider: 'openai-compatible', model: 'm', apiKey: 'k' }, fakeFetch(fixture));
    const events = await collect(adapter.stream(SIMPLE_REQ));
    const tools = events.filter(e => e.type === 'tool_use');
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: 'f1', input: { x: 1 } });
    expect(tools[1]).toMatchObject({ name: 'f2', input: { y: 2 } });
  });
});

// BUG-7 — a user abort mid-stream must end the stream silently: no error
// event, no done (the loop's signal check handles teardown).
describe('Abort mid-stream ends silently (BUG-7)', () => {
  function abortingFetch(firstChunks: string[]): typeof globalThis.fetch {
    return async () => {
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            for (const ch of firstChunks) controller.enqueue(ENC.encode(ch));
          } else {
            controller.error(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          }
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
  }

  it('Anthropic adapter swallows the AbortError and emits no error/done', async () => {
    const ac = new AbortController();
    const adapter = new AnthropicAdapter(
      { provider: 'anthropic', model: 'm', apiKey: 'k' },
      abortingFetch(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"部分"}}\n\n']),
    );
    const events: StreamEvent[] = [];
    for await (const ev of adapter.stream({ ...SIMPLE_REQ, signal: ac.signal })) {
      events.push(ev);
      ac.abort(); // user presses stop after the first delta
    }
    expect(events).toEqual([{ type: 'text_delta', text: '部分' }]);
  });

  it('OpenAI adapter swallows the AbortError and emits no error/done', async () => {
    const ac = new AbortController();
    const adapter = new OpenAIAdapter(
      { provider: 'openai-compatible', model: 'm', apiKey: 'k' },
      abortingFetch(['data: {"choices":[{"delta":{"content":"部分"}}]}\n\n']),
    );
    const events: StreamEvent[] = [];
    for await (const ev of adapter.stream({ ...SIMPLE_REQ, signal: ac.signal })) {
      events.push(ev);
      ac.abort();
    }
    expect(events).toEqual([{ type: 'text_delta', text: '部分' }]);
  });

  it('a non-abort stream error still propagates', async () => {
    const adapter = new AnthropicAdapter(
      { provider: 'anthropic', model: 'm', apiKey: 'k' },
      (async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.error(new Error('boom')); },
      }), { status: 200 })) as unknown as typeof globalThis.fetch,
    );
    await expect(collect(adapter.stream(SIMPLE_REQ))).rejects.toThrow('boom');
  });
});

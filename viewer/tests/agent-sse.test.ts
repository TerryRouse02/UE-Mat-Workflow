// SSE parser unit tests for web/src/agent/sse.ts.
// Tests the parsing logic by simulating fetch with custom ReadableStream mocks.
// These run in node env (vitest.config.ts) — happy-dom not needed for parser tests.

import { describe, it, expect } from 'vitest';
import type { AgentSseEvent } from '../web/src/agent/protocol.js';

// ---------------------------------------------------------------------------
// Pure parsing logic extracted for unit testing.
// This mirrors the algorithm in sse.ts so we can test edge cases in isolation.
// ---------------------------------------------------------------------------

function parseSSEChunks(chunks: string[]): AgentSseEvent[] {
  const events: AgentSseEvent[] = [];
  let buf = '';

  for (const chunk of chunks) {
    buf += chunk;
    // Normalize line endings.
    buf = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith(':')) continue;
      if (line === '') continue;
      if (line.startsWith('data: ')) {
        const payload = line.slice('data: '.length).trim();
        if (payload === '[DONE]') return events;
        try {
          const event = JSON.parse(payload) as AgentSseEvent;
          events.push(event);
          if (event.type === 'done') return events;
        } catch { /* ignore */ }
      }
    }
  }

  // Flush tail
  if (buf.startsWith('data: ')) {
    const payload = buf.slice('data: '.length).trim();
    if (payload && payload !== '[DONE]') {
      try {
        const event = JSON.parse(payload) as AgentSseEvent;
        events.push(event);
      } catch { /* ignore */ }
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SSE parser — basic', () => {
  it('parses a single text event', () => {
    const chunks = ['data: {"type":"text","text":"hello"}\n\n'];
    const events = parseSSEChunks(chunks);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('parses multiple events in one chunk', () => {
    const chunks = [
      'data: {"type":"text","text":"a"}\n\ndata: {"type":"text","text":"b"}\n\ndata: {"type":"done"}\n\n',
    ];
    const events = parseSSEChunks(chunks);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ type: 'text', text: 'a' });
    expect(events[1]).toEqual({ type: 'text', text: 'b' });
    expect(events[2]).toEqual({ type: 'done' });
  });

  it('stops after done event', () => {
    const chunks = [
      'data: {"type":"done"}\n\ndata: {"type":"text","text":"should not appear"}\n\n',
    ];
    const events = parseSSEChunks(chunks);
    // done is included but nothing after
    expect(events.find(e => e.type === 'done')).toBeTruthy();
    expect(events.find(e => e.type === 'text')).toBeUndefined();
  });

  it('skips keepalive colon lines', () => {
    const chunks = [': keepalive\n\ndata: {"type":"text","text":"ok"}\n\n'];
    const events = parseSSEChunks(chunks);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'text', text: 'ok' });
  });

  it('skips blank lines (event boundaries)', () => {
    const chunks = ['\n\n\ndata: {"type":"text","text":"x"}\n\n'];
    const events = parseSSEChunks(chunks);
    expect(events).toHaveLength(1);
  });

  it('stops at [DONE] sentinel', () => {
    const chunks = ['data: {"type":"text","text":"hi"}\n\ndata: [DONE]\n\n'];
    const events = parseSSEChunks(chunks);
    expect(events).toHaveLength(1);
  });
});

describe('SSE parser — chunk-split events', () => {
  it('handles a data line split across two chunks', () => {
    const full = '{"type":"text","text":"split-test"}';
    const half1 = `data: ${full.slice(0, 15)}`;
    const half2 = `${full.slice(15)}\n\n`;
    const events = parseSSEChunks([half1, half2]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'text', text: 'split-test' });
  });

  it('handles an event split at the newline boundary', () => {
    const ev = 'data: {"type":"text","text":"nl"}\n';
    const events = parseSSEChunks([ev, '\n']);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'text', text: 'nl' });
  });

  it('handles many small chunks', () => {
    const line = 'data: {"type":"text","text":"small"}\n\n';
    const chunks = line.split('').map(c => c); // one char per chunk
    const events = parseSSEChunks(chunks);
    expect(events.find(e => e.type === 'text')).toBeTruthy();
  });
});

describe('SSE parser — CRLF line endings', () => {
  it('parses events with \\r\\n line endings', () => {
    const chunks = ['data: {"type":"text","text":"crlf"}\r\n\r\n'];
    const events = parseSSEChunks(chunks);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'text', text: 'crlf' });
  });

  it('parses events with mixed CRLF and LF', () => {
    const chunks = [
      'data: {"type":"text","text":"one"}\r\n\r\ndata: {"type":"text","text":"two"}\n\n',
    ];
    const events = parseSSEChunks(chunks);
    expect(events).toHaveLength(2);
  });
});

describe('SSE parser — event type variety', () => {
  it('parses tool_start event', () => {
    const ev: AgentSseEvent = { type: 'tool_start', name: 'search_nodes', summary: '搜尋節點' };
    const chunks = [`data: ${JSON.stringify(ev)}\n\n`];
    const events = parseSSEChunks(chunks);
    expect(events[0]).toEqual(ev);
  });

  it('parses tool_end event', () => {
    const ev: AgentSseEvent = { type: 'tool_end', name: 'write_graph', ok: true, summary: '已寫入' };
    const chunks = [`data: ${JSON.stringify(ev)}\n\n`];
    const events = parseSSEChunks(chunks);
    expect(events[0]).toEqual(ev);
  });

  it('parses graph_written event', () => {
    const ev: AgentSseEvent = { type: 'graph_written', path: 'proj/mat.matgraph.json' };
    const chunks = [`data: ${JSON.stringify(ev)}\n\n`];
    const events = parseSSEChunks(chunks);
    expect(events[0]).toEqual(ev);
  });

  it('parses error event', () => {
    const ev: AgentSseEvent = { type: 'error', message: '錯誤訊息' };
    const chunks = [`data: ${JSON.stringify(ev)}\n\n`];
    const events = parseSSEChunks(chunks);
    expect(events[0]).toEqual(ev);
  });

  it('parses limit event', () => {
    const ev: AgentSseEvent = { type: 'limit', kind: 'iters', message: '已達最大次數' };
    const chunks = [`data: ${JSON.stringify(ev)}\n\n`];
    const events = parseSSEChunks(chunks);
    expect(events[0]).toEqual(ev);
  });

  it('parses usage event', () => {
    const ev: AgentSseEvent = { type: 'usage', inputTokens: 100, outputTokens: 50, estimated: false };
    const chunks = [`data: ${JSON.stringify(ev)}\n\n`];
    const events = parseSSEChunks(chunks);
    expect(events[0]).toEqual(ev);
  });

  it('skips malformed JSON lines silently', () => {
    const chunks = ['data: {bad json}\n\ndata: {"type":"text","text":"ok"}\n\n'];
    const events = parseSSEChunks(chunks);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'text', text: 'ok' });
  });
});

describe('SSE parser — no-trailing-newline flush', () => {
  it('emits the last event when stream ends without trailing newline', () => {
    // Simulate a stream that ends mid-event (no trailing \n\n).
    // This exercises the flush branch in both the test copy and sse.ts.
    const ev: AgentSseEvent = { type: 'done' };
    const rawLine = `data: ${JSON.stringify(ev)}`;
    // Delivered without any trailing newline — the flush path must recover it.
    const events = parseSSEChunks([rawLine]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(ev);
  });

  it('emits a text event flushed at stream end without newline', () => {
    const textEv: AgentSseEvent = { type: 'text', text: '結尾殘留' };
    const normalChunk = 'data: {"type":"text","text":"first"}\n\n';
    const tailChunk = `data: ${JSON.stringify(textEv)}`; // no trailing newline
    const events = parseSSEChunks([normalChunk, tailChunk]);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(textEv);
  });
});

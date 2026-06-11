// web/src/agent/sse.ts — browser-side SSE client for POST /api/agent/chat.
//
// Uses fetch + ReadableStream + TextDecoder. Zero external deps.
// Yields parsed AgentSseEvent objects as an async iterable.
// The caller passes an AbortSignal to stop the stream (stop button).
//
// SSE parsing is resilient to:
//  - chunk-split events (partial data: lines across chunks)
//  - CRLF line endings
//  - ':' keepalive lines (ignored)
//  - [DONE] sentinel (terminates iteration)
//  - no trailing newline on the last event

import type { AgentSseEvent, AgentChatRequest } from './protocol';

export async function* streamChat(
  req: AgentChatRequest,
  signal: AbortSignal,
): AsyncGenerator<AgentSseEvent> {
  const response = await fetch('/api/agent/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });

  if (!response.ok) {
    // Non-SSE error response (e.g. 409 Conflict, 403 Forbidden)
    let errMsg: string;
    try {
      const body = (await response.json()) as { error?: string };
      errMsg = body.error ?? `HTTP ${response.status}`;
    } catch {
      errMsg = `HTTP ${response.status}`;
    }
    yield { type: 'error', message: errMsg };
    return;
  }

  if (!response.body) {
    yield { type: 'error', message: '回應沒有串流資料' };
    return;
  }

  // Per-call TextDecoder (never share across calls — stateful).
  const decoder = new TextDecoder();
  const reader = response.body.getReader();

  // Buffer for incomplete SSE lines that span chunk boundaries.
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });

      // Split on any combination of CRLF / LF / CR.
      // We split on \n but first normalise \r\n → \n so CRLF works.
      buf = buf.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      const lines = buf.split('\n');
      // The last element may be an incomplete line — keep it in the buffer.
      buf = lines.pop() ?? '';

      for (const line of lines) {
        // Keepalive / comment lines start with ':'
        if (line.startsWith(':')) continue;
        // Blank line = event boundary (we emit per data: line here)
        if (line === '') continue;

        if (line.startsWith('data: ')) {
          const payload = line.slice('data: '.length).trim();
          if (payload === '[DONE]') return;
          try {
            const event = JSON.parse(payload) as AgentSseEvent;
            yield event;
            if (event.type === 'done') return;
          } catch {
            // Malformed JSON — skip silently.
          }
        }
      }
    }

    // Flush any remaining partial chunk.
    const tail = buf + decoder.decode();
    if (tail.startsWith('data: ')) {
      const payload = tail.slice('data: '.length).trim();
      if (payload && payload !== '[DONE]') {
        try {
          const event = JSON.parse(payload) as AgentSseEvent;
          yield event;
        } catch {
          // Ignore malformed tail.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// Zero-dependency async-generator SSE parser over ReadableStream<Uint8Array>.
//
// Edge cases handled:
//   - Partial lines buffered across chunk boundaries.
//   - Line splitting on \r\n, \r, or \n (all three forms per SSE spec).
//   - Lines beginning with ':' are keepalive/comment lines — skipped.
//   - Only 'data:' field is acted upon; event:/id:/retry: lines are ignored.
//   - 'data: [DONE]' sentinel ends iteration immediately.
//   - A trailing 'data:' line with no final newline is flushed on stream end.
//   - releaseLock() is called in finally, even on early return.
//
// Deliberate limitation: each 'data:' line is yielded as its own payload —
// multi-line events (several data: lines joined by '\n' per the SSE spec) are
// NOT merged. Both dialects this parser consumes (Anthropic Messages API,
// OpenAI chat completions) emit exactly one data: line per event.

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  // Per-call decoder: with {stream:true} a TextDecoder carries partial-multibyte
  // state between decode() calls, so sharing one across concurrent streams
  // (e.g. chat + explain in flight together) would corrupt split characters.
  const decoder = new TextDecoder();
  const reader = body.getReader();
  // Accumulates bytes that have not yet formed a complete line.
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any remaining buffered content as the final data line.
        const trimmed = buf.trimEnd();
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.slice(5).trimStart();
          if (payload === '[DONE]') return;
          yield payload;
        }
        return;
      }

      buf += decoder.decode(value, { stream: true });

      // Split on all three newline forms; keep the unsplit remainder as next buf.
      // Using a regex split preserves empty strings for CRLF (\r\n splits into two
      // parts but the regex eats both chars at once, so this is safe).
      const lines = buf.split(/\r\n|\r|\n/);
      // The last element is the incomplete line tail (may be '').
      buf = lines.pop() ?? '';

      for (const line of lines) {
        // Comment / keepalive — spec says lines starting with ':' must be ignored.
        if (line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trimStart();
        if (payload === '[DONE]') return;
        yield payload;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Pass-through wrapper that swallows the AbortError a cancelled fetch makes
 * reader.read() throw. A user-initiated abort is a normal cancellation, not a
 * provider failure — the stream just ends. Any other error still propagates.
 */
export async function* abortSafe<T>(
  src: AsyncIterable<T>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  try {
    yield* src;
  } catch (err) {
    if (signal?.aborted || (err as Error)?.name === 'AbortError') return;
    throw err;
  }
}

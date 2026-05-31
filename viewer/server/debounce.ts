export interface Debouncer<T> {
  trigger(item: T): void;
}

export function createDebouncer<T>(fn: (items: T[]) => void, delayMs: number): Debouncer<T> {
  let buf: T[] = [];
  let timer: NodeJS.Timeout | null = null;
  return {
    trigger(item: T) {
      buf.push(item);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        // Dedup the batch, preserving first-seen order: a file saved N times in
        // the window must surface once, not N identical entries.
        const items = [...new Set(buf)];
        buf = [];
        timer = null;
        fn(items);
      }, delayMs);
    },
  };
}

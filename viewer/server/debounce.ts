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
        const items = buf;
        buf = [];
        timer = null;
        fn(items);
      }, delayMs);
    },
  };
}

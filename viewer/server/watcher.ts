import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { createDebouncer } from './debounce.js';

export interface WatchHandle {
  close(): Promise<void>;
}

export interface WatchOptions {
  debounceMs?: number;
}

export function watchGraphs(
  graphsRoot: string,
  onBatch: (changed: string[], removed: string[]) => void,
  opts: WatchOptions = {},
): WatchHandle {
  // Tag each debounced item with its event kind so add/change vs unlink stay
  // distinguishable through the (string-keyed) dedup, then split before fan-out.
  const debounce = createDebouncer<string>((keys) => {
    const removed = new Set<string>();
    const changed: string[] = [];
    const seenChanged = new Set<string>();
    for (const key of keys) {
      const kind = key[0];
      const path = key.slice(2);
      if (kind === 'u') removed.add(path);
      else if (!seenChanged.has(path)) { seenChanged.add(path); changed.push(path); }
    }
    // A file added/changed then deleted within the window is gone: drop it from
    // changed so it is never re-sent as a graph.
    onBatch(changed.filter((p) => !removed.has(p)), [...removed]);
  }, opts.debounceMs ?? 300);

  const watcher: FSWatcher = chokidarWatch(graphsRoot, {
    ignoreInitial: true,
  });

  const handler = (kind: 'a' | 'u') => (path: string) => {
    if (path.endsWith('.matgraph.json')) debounce.trigger(`${kind}\0${path}`);
  };
  watcher.on('add', handler('a'));
  watcher.on('change', handler('a'));
  watcher.on('unlink', handler('u'));

  return {
    async close() { await watcher.close(); },
  };
}

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
  onBatch: (paths: string[]) => void,
  opts: WatchOptions = {},
): WatchHandle {
  const debounce = createDebouncer<string>(onBatch, opts.debounceMs ?? 300);

  const watcher: FSWatcher = chokidarWatch(graphsRoot, {
    ignoreInitial: true,
  });

  const handler = (path: string) => {
    if (path.endsWith('.matgraph.json')) debounce.trigger(path);
  };
  watcher.on('add', handler);
  watcher.on('change', handler);
  watcher.on('unlink', handler);

  return {
    async close() { await watcher.close(); },
  };
}

// Pure: takes elapsed milliseconds, returns a human label.
export function formatSyncAgo(deltaMs: number): string {
  const s = Math.floor(deltaMs / 1000);
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

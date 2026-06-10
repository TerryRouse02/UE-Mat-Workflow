/**
 * timeUtils.ts — shared pure time-formatting helpers.
 *
 * Two flavours of fmtTime / relTime exist because ConfigPanel and Inspector
 * have historically used different formats. Both are kept here so the
 * components can import from a single file and the test suite can cover them.
 */

// ─── ConfigPanel flavour ─────────────────────────────────────────────────────

/**
 * Format an ISO timestamp as "MM-DD HH:MM" (compact, no year, local time).
 * Returns "—" on invalid input.
 */
export function fmtTimeCompact(iso: string): string {
  try {
    const d = new Date(iso);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mn = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mn}`;
  } catch {
    return '—';
  }
}

/**
 * Return a human-readable relative time string.
 * Uses minute/hour/day resolution (ConfigPanel variant).
 * Returns "—" on invalid input.
 */
export function relTimeMinutes(iso: string): string {
  try {
    const delta = (Date.now() - new Date(iso).getTime()) / 1000;
    if (delta < 60) return '剛剛';
    if (delta < 3600) return `${Math.floor(delta / 60)} 分鐘前`;
    if (delta < 86400) return `${Math.floor(delta / 3600)} 小時前`;
    return `${Math.floor(delta / 86400)} 天前`;
  } catch {
    return '—';
  }
}

// ─── Inspector flavour ───────────────────────────────────────────────────────

/**
 * Format an ISO timestamp as "YYYY-MM-DD HH:MM" by slicing the ISO string.
 * Returns "—" on null/undefined/empty.
 */
export function fmtTimeIso(iso: string | null | undefined): string {
  if (!iso) return '—';
  return iso.replace('T', ' ').slice(0, 16);
}

/**
 * Return a human-readable relative time string.
 * Uses hour/day resolution (Inspector variant).
 * Returns "" on null/undefined/empty.
 */
export function relTimeHours(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso).getTime();
  const now = Date.now();
  const h = Math.round((now - d) / 36e5);
  if (h < 1) return '剛剛';
  if (h < 24) return h + ' 小時前';
  const days = Math.round(h / 24);
  return days + ' 天前';
}

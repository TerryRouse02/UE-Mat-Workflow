/**
 * uiHelpers.ts — pure UI logic extracted from viewer components.
 *
 * These functions are framework-free and have no side-effects, making them
 * easy to unit-test with vitest (no DOM / React required).
 */

// ─── Toast ────────────────────────────────────────────────────────────────────

export type ToastVariant = 'loading' | 'success' | 'warning' | 'error' | 'info';
export type ToastClass = 'ok' | 'err' | '';

/**
 * Map a toast variant to its CSS modifier class.
 *   success          → 'ok'
 *   error | warning  → 'err'
 *   loading | info   → ''  (accent border only, no extra class)
 */
export function variantClass(v: ToastVariant): ToastClass {
  if (v === 'success') return 'ok';
  if (v === 'error' || v === 'warning') return 'err';
  return '';
}

// ─── ConfigPanel — log parsing ────────────────────────────────────────────────

export interface LogEntry {
  t: number;
  lvl: string;
  msg: string;
}

/**
 * Heuristically classify a single raw log line.
 *
 * Rules (case-insensitive):
 *   error | fail | fatal | exception → 'error'
 *   warn                             → 'warn'
 *   loginit | logasset               → 'dim'
 *   otherwise                        → 'info'
 *
 * `t` is set to `i * 0.1` (tenth-of-a-second pseudo-timestamp matching the
 * original component behaviour).
 */
export function parseLogLine(line: string, i: number): LogEntry {
  const lower = line.toLowerCase();
  let lvl = 'info';
  if (/error|fail|fatal|exception/i.test(lower)) lvl = 'error';
  else if (/warn/i.test(lower)) lvl = 'warn';
  else if (/loginit|logasset/i.test(lower)) lvl = 'dim';
  return { t: i * 0.1, lvl, msg: line };
}

// ─── BigGraphConfirm — node / link estimate ───────────────────────────────────

/** Constant factor used to estimate edge count from node count. */
export const LINK_FACTOR = 1.6;

/**
 * Estimate the number of links in a material graph given its node count.
 * Uses the same `Math.round(nodeCount * 1.6)` formula as BigGraphConfirm.
 */
export function estimateLinks(nodeCount: number): number {
  return Math.round(nodeCount * LINK_FACTOR);
}

// ─── CommandPalette — filter predicates ──────────────────────────────────────

export interface CmdFilterItem {
  label: string;
}

export interface NodeFilterItem {
  title: string;
  id: string;
}

/**
 * Returns true when a command item's label contains the query (case-insensitive).
 */
export function matchesCmd(item: CmdFilterItem, query: string): boolean {
  return item.label.toLowerCase().includes(query.toLowerCase());
}

/**
 * Returns true when a node item's title or id contains the query (case-insensitive).
 */
export function matchesNode(item: NodeFilterItem, query: string): boolean {
  const lq = query.toLowerCase();
  return item.title.toLowerCase().includes(lq) || item.id.toLowerCase().includes(lq);
}

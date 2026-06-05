/** Node count above which opening a graph requires user confirmation. */
export const LARGE_GRAPH_THRESHOLD = 300;

/**
 * Pure predicate: returns true when opening a graph of the given nodeCount
 * should be gated behind a user confirmation dialog. Testable without DOM.
 *
 * @param nodeCount - Number of nodes in the graph; undefined means unknown (no gate).
 * @param threshold - Override the default threshold (default: LARGE_GRAPH_THRESHOLD).
 */
export function shouldConfirmOpen(
  nodeCount: number | undefined,
  threshold = LARGE_GRAPH_THRESHOLD,
): boolean {
  return nodeCount !== undefined && nodeCount > threshold;
}

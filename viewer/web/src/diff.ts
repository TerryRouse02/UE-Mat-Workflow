// diff.ts — pure graph-diff computation for the compare view.
//
// Direction: `base` is the currently OPEN graph (A), `other` is the compare
// target (B). Statuses read as "what changed going from A to B":
//   removed = only in A (will disappear)   added = only in B (new)
//   changed = same node id in both, but type or params differ
//
// The merged graph is the union rendered on the canvas: B's version wins for
// shared/changed nodes, A-only nodes ride along as removed ghosts. Comments
// are dropped — their `contains` lists don't survive a union meaningfully.

import type { MatGraph, NodeJson, ConnectionJson, GraphPayload, DerivedPins } from './protocol';

export type DiffNodeStatus = 'added' | 'removed' | 'changed';
export type DiffConnStatus = 'added' | 'removed';

export interface GraphDiff {
  merged: MatGraph;
  /** Node id → status; unchanged nodes are absent. */
  nodeStatus: Record<string, DiffNodeStatus>;
  /** Connection key (`from->to`) → status; unchanged connections are absent. */
  connStatus: Record<string, DiffConnStatus>;
  summary: {
    added: string[];
    removed: string[];
    changed: Array<{ id: string; what: string[] }>;
    connAdded: number;
    connRemoved: number;
  };
}

export const connKey = (c: ConnectionJson): string => `${c.from}->${c.to}`;

/** Order-independent stable stringify for param comparison. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function changedFields(a: NodeJson, b: NodeJson): string[] {
  const what: string[] = [];
  if (a.type !== b.type) what.push(`type: ${a.type} → ${b.type}`);
  const ap = a.params ?? {};
  const bp = b.params ?? {};
  const keys = new Set([...Object.keys(ap), ...Object.keys(bp)]);
  for (const k of keys) {
    if (stable(ap[k]) !== stable(bp[k])) what.push(`params.${k}`);
  }
  return what;
}

export function computeGraphDiff(base: MatGraph, other: MatGraph): GraphDiff {
  const baseById = new Map(base.nodes.map(n => [n.id, n]));
  const otherById = new Map(other.nodes.map(n => [n.id, n]));

  const nodeStatus: Record<string, DiffNodeStatus> = {};
  const added: string[] = [];
  const removed: string[] = [];
  const changed: Array<{ id: string; what: string[] }> = [];

  // Canvas order: B's nodes first (B's version wins for shared ids), then
  // A-only ghosts appended.
  const mergedNodes: NodeJson[] = [...other.nodes];
  for (const n of other.nodes) {
    const prev = baseById.get(n.id);
    if (!prev) {
      nodeStatus[n.id] = 'added';
      added.push(n.id);
    } else {
      const what = changedFields(prev, n);
      if (what.length > 0) {
        nodeStatus[n.id] = 'changed';
        changed.push({ id: n.id, what });
      }
    }
  }
  for (const n of base.nodes) {
    if (!otherById.has(n.id)) {
      nodeStatus[n.id] = 'removed';
      removed.push(n.id);
      mergedNodes.push(n);
    }
  }

  const baseConns = new Map(base.connections.map(c => [connKey(c), c]));
  const otherConns = new Map(other.connections.map(c => [connKey(c), c]));
  const connStatus: Record<string, DiffConnStatus> = {};
  const mergedConns: ConnectionJson[] = [...other.connections];
  let connAdded = 0;
  let connRemoved = 0;
  for (const key of otherConns.keys()) {
    if (!baseConns.has(key)) {
      connStatus[key] = 'added';
      connAdded += 1;
    }
  }
  for (const [key, c] of baseConns) {
    if (!otherConns.has(key)) {
      connStatus[key] = 'removed';
      connRemoved += 1;
      mergedConns.push(c);
    }
  }

  const merged: MatGraph = {
    ...other,
    nodes: mergedNodes,
    connections: mergedConns,
  };
  delete merged.comments;

  return { merged, nodeStatus, connStatus, summary: { added, removed, changed, connAdded, connRemoved } };
}

/**
 * Merge two payloads into the diff canvas payload: union graph + combined
 * derivedPins (B wins, A fills the removed ghosts' MaterialFunctionCall pins).
 */
export function buildDiffPayload(base: GraphPayload, other: GraphPayload): { payload: GraphPayload; diff: GraphDiff } {
  const diff = computeGraphDiff(base.graph, other.graph);
  const derivedPins: Record<string, DerivedPins> = { ...base.derivedPins, ...other.derivedPins };
  return {
    payload: {
      graph: diff.merged,
      derivedPins,
      warnings: [],
      ...(other.nodeProvenance ? { nodeProvenance: other.nodeProvenance } : {}),
    },
    diff,
  };
}

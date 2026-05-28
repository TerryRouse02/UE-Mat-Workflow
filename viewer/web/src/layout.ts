import dagre from 'dagre';
import type { Node, Edge } from 'reactflow';

export const NODE_W = 220;
const NODE_H = 100;

// Kept in sync with MaterialNode's isCodeLike() — must match how the
// component actually renders, or comment-cluster bounds will be wrong.
function isCodeLikeValue(v: unknown): boolean {
  return typeof v === 'string' && (v.includes('\n') || v.length > 40);
}

// Code <pre> block: ~14px per line + 12px padding, capped at 200px
// (matches .mat-code pre CSS max-height).
function codeBlockHeight(s: string): number {
  const lines = (s.match(/\n/g)?.length ?? 0) + 1;
  return Math.min(200, lines * 14 + 12);
}

// For inline <code>{JSON.stringify(v)}</code> values: estimate wrap.
// Node body is ~220px wide; the params section has ~24px of "key:" label
// on the left, leaving ~180px for the value. At font-size 10px monospace,
// ~32 chars per line is a safe estimate.
const PARAM_VALUE_CHARS_PER_LINE = 32;
function inlineParamHeight(stringified: string): number {
  if (!stringified) return 14;
  const lines = Math.max(1, Math.ceil(stringified.length / PARAM_VALUE_CHARS_PER_LINE));
  // Cap inline wrap at 5 lines (~70px) — past that the user can't read it anyway.
  return Math.min(5, lines) * 14;
}

export function computeNodeHeight(data: any): number {
  const inputs = (data && data.inputs) || [];
  const outputs = (data && data.outputs) || [];
  const params = (data && data.params) || {};

  const maxPins = Math.max(inputs.length, outputs.length);
  const pinHeight = maxPins * 18;

  const paramEntries = Object.entries(params);
  let paramHeight = 0;
  if (paramEntries.length > 0) {
    paramHeight = 12; // section vertical padding
    for (const [, v] of paramEntries) {
      if (isCodeLikeValue(v)) {
        paramHeight += codeBlockHeight(v as string) + 4;
      } else {
        // Non-code values render as inline <code>{JSON.stringify(v)}</code>
        // which wraps within the node. Arrays/objects can wrap to multiple lines.
        paramHeight += inlineParamHeight(JSON.stringify(v));
      }
    }
  }

  const warningHeight = data && data.warning ? 20 : 0;

  return 30 + Math.max(20, pinHeight) + paramHeight + warningHeight + 12;
}

export interface LayoutInput {
  nodes: { id: string; width?: number; height?: number; rank?: 'min' | 'max' | 'same' }[];
  edges: { id: string; source: string; target: string }[];
  clusters?: { id: string; childNodeIds: string[] }[];
}

export interface LayoutResult {
  positions: Record<string, { x: number; y: number }>;
  clusterBounds: Record<string, { x: number; y: number; width: number; height: number }>;
}

export function autoLayout(input: LayoutInput): LayoutResult {
  const g = new dagre.graphlib.Graph({ compound: !!input.clusters?.length });
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 120 });
  g.setDefaultEdgeLabel(() => ({}));

  // Declare clusters first (as parent nodes)
  if (input.clusters) {
    for (const c of input.clusters) {
      g.setNode(c.id, {});
    }
  }

  // Declare real nodes
  for (const n of input.nodes) {
    const w = n.width ?? NODE_W;
    const h = n.height ?? NODE_H;
    const opts: Record<string, unknown> = { width: w, height: h };
    if (n.rank) opts.rank = n.rank;
    g.setNode(n.id, opts);
  }

  // Parent real nodes into their cluster
  if (input.clusters) {
    for (const c of input.clusters) {
      for (const childId of c.childNodeIds) {
        if (input.nodes.find(n => n.id === childId)) {
          g.setParent(childId, c.id);
        }
      }
    }
  }

  for (const e of input.edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of input.nodes) {
    const w = n.width ?? NODE_W;
    const h = n.height ?? NODE_H;
    const p = g.node(n.id);
    positions[n.id] = { x: p.x - w / 2, y: p.y - h / 2 };
  }

  const clusterBounds: Record<string, { x: number; y: number; width: number; height: number }> = {};
  if (input.clusters) {
    for (const c of input.clusters) {
      const cn = g.node(c.id) as { x: number; y: number; width: number; height: number } | undefined;
      if (cn && typeof cn.width === 'number' && typeof cn.height === 'number') {
        clusterBounds[c.id] = {
          x: cn.x - cn.width / 2,
          y: cn.y - cn.height / 2,
          width: cn.width,
          height: cn.height,
        };
      }
    }
  }

  return { positions, clusterBounds };
}

export interface ApplyLayoutResult {
  nodes: Node[];
  clusterBounds: Record<string, { x: number; y: number; width: number; height: number }>;
}

export function applyLayout(
  nodes: Node[],
  edges: Edge[],
  clusters?: { id: string; childNodeIds: string[] }[],
): ApplyLayoutResult {
  const result = autoLayout({
    nodes: nodes.map(n => ({
      id: n.id,
      width: NODE_W,
      height: computeNodeHeight(n.data),
      rank: n.type === 'materialOutput' ? ('max' as const) : undefined,
    })),
    edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target })),
    clusters,
  });
  return {
    nodes: nodes.map(n => ({ ...n, position: result.positions[n.id] ?? { x: 0, y: 0 } })),
    clusterBounds: result.clusterBounds,
  };
}

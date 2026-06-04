import dagre from 'dagre';
import type { Node, Edge } from 'reactflow';

export const NODE_W = 220;
const NODE_H = 100;

export function computeNodeHeight(data: any): number {
  const inputs = (data && data.inputs) || [];
  const outputs = (data && data.outputs) || [];
  const maxPins = Math.max(inputs.length, outputs.length);
  const pinHeight = maxPins * 18;
  const warningHeight = data && data.warning ? 20 : 0;
  return 30 + Math.max(20, pinHeight) + warningHeight + 12;
}

export function computeNodeWidth(data: any): number {
  if (!data) return 180;
  const label = data.label || '';
  const inputs = data.inputs || [];
  const outputs = data.outputs || [];

  const titleWidth = label.length * 8 + 24;
  let maxRowWidth = 180;

  const maxPins = Math.max(inputs.length, outputs.length);
  for (let i = 0; i < maxPins; i++) {
    const inp = inputs[i];
    const out = outputs[i];

    let rowWidth = 0;
    if (inp && out) {
      // Double-sided row
      const inpWidth = inp.name.length * 7 + (inp.type && inp.type !== 'Float' ? inp.type.length * 6 + 12 : 0);
      const outWidth = out.name.length * 7 + (out.type && out.type !== 'Float' ? out.type.length * 6 + 12 : 0);
      rowWidth = inpWidth + outWidth + 24 + 32; // gap (24) + padding (32)
    } else if (inp) {
      // Single-sided input row
      const inpWidth = inp.name.length * 7 + (inp.type && inp.type !== 'Float' ? inp.type.length * 6 + 12 : 0);
      rowWidth = inpWidth + 32; // padding (32)
    } else if (out) {
      // Single-sided output row
      const outWidth = out.name.length * 7 + (out.type && out.type !== 'Float' ? out.type.length * 6 + 12 : 0);
      rowWidth = outWidth + 32; // padding (32)
    }
    if (rowWidth > maxRowWidth) maxRowWidth = rowWidth;
  }

  // Take the max of min-width (180), title width, and pin rows/params width, capped at max-width (380)
  return Math.min(380, Math.max(180, titleWidth, maxRowWidth));
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

// Namespace every key we hand to dagre. The graphs are AI-authored, so any node
// or comment id is possible — including ones that collide with dagre's innards.
// dagre's position pass runs its node-keyed result map through lodash _.forEach,
// whose array-like detection treats an object with a numeric `length` property as
// an array; a node literally named "length" therefore makes it iterate numeric
// indices and throw "Cannot set properties of undefined (setting 'x')", blanking
// the whole canvas. Prefixes that "length" can never start with make any user id
// safe; we strip them on read-back. (Distinct prefixes also keep node vs cluster
// keyspaces from ever colliding.)
const NODE_KEY = (id: string) => `rf-node:${id}`;
const CLUSTER_KEY = (id: string) => `rf-cluster:${id}`;

export function autoLayout(input: LayoutInput): LayoutResult {
  const g = new dagre.graphlib.Graph({ compound: !!input.clusters?.length });
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 120 });
  g.setDefaultEdgeLabel(() => ({}));

  // Declare clusters first (as parent nodes)
  if (input.clusters) {
    for (const c of input.clusters) {
      g.setNode(CLUSTER_KEY(c.id), {});
    }
  }

  // Declare real nodes
  for (const n of input.nodes) {
    const w = n.width ?? NODE_W;
    const h = n.height ?? NODE_H;
    const opts: Record<string, unknown> = { width: w, height: h };
    if (n.rank) opts.rank = n.rank;
    g.setNode(NODE_KEY(n.id), opts);
  }

  // Parent real nodes into their cluster
  if (input.clusters) {
    for (const c of input.clusters) {
      for (const childId of c.childNodeIds) {
        if (input.nodes.find(n => n.id === childId)) {
          g.setParent(NODE_KEY(childId), CLUSTER_KEY(c.id));
        }
      }
    }
  }

  for (const e of input.edges) g.setEdge(NODE_KEY(e.source), NODE_KEY(e.target));

  // Defence in depth: the key namespacing above fixes the known dagre/lodash
  // crash, but a pathological AI-authored graph could still trip some other dagre
  // edge case. Never white-screen the viewer over layout — fall back to a plain
  // grid so the nodes (and, via live positions, their comment boxes) still render.
  try {
    dagre.layout(g);
  } catch {
    return fallbackLayout(input);
  }

  const positions: Record<string, { x: number; y: number }> = {};
  for (const n of input.nodes) {
    const w = n.width ?? NODE_W;
    const h = n.height ?? NODE_H;
    const p = g.node(NODE_KEY(n.id));
    positions[n.id] = { x: p.x - w / 2, y: p.y - h / 2 };
  }

  const clusterBounds: Record<string, { x: number; y: number; width: number; height: number }> = {};
  if (input.clusters) {
    for (const c of input.clusters) {
      const cn = g.node(CLUSTER_KEY(c.id)) as { x: number; y: number; width: number; height: number } | undefined;
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

// Deterministic grid used only when dagre.layout throws. Layout quality is
// secondary here — the contract is simply that every node gets a finite position
// so the canvas is never blank. Clusters get no bounds; Graph.tsx already derives
// comment boxes from live node positions, so they still wrap their members.
function fallbackLayout(input: LayoutInput): LayoutResult {
  const cols = Math.max(1, Math.ceil(Math.sqrt(input.nodes.length)));
  const COL_W = NODE_W + 80;
  const ROW_H = NODE_H + 60;
  const positions: Record<string, { x: number; y: number }> = {};
  input.nodes.forEach((n, i) => {
    positions[n.id] = { x: (i % cols) * COL_W, y: Math.floor(i / cols) * ROW_H };
  });
  return { positions, clusterBounds: {} };
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
      width: computeNodeWidth(n.data),
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

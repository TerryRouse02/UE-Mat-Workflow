import dagre from 'dagre';
import type { Node, Edge } from 'reactflow';

export const NODE_W = 220;
const NODE_H = 100;

export function computeNodeHeight(data: any): number {
  const inputs = (data && data.inputs) || [];
  const outputs = (data && data.outputs) || [];
  const params = (data && data.params) || {};

  const maxPins = Math.max(inputs.length, outputs.length);
  const pinHeight = maxPins * 18;
  const paramCount = Object.keys(params).length;
  const paramHeight = paramCount > 0 ? (12 + paramCount * 14) : 0;
  const warningHeight = data && data.warning ? 20 : 0;

  return 30 + Math.max(20, pinHeight) + paramHeight + warningHeight + 12;
}

export interface LayoutInput {
  nodes: { id: string; width?: number; height?: number; rank?: 'min' | 'max' | 'same' }[];
  edges: { id: string; source: string; target: string }[];
}

export function autoLayout(input: LayoutInput): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 120 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of input.nodes) {
    const w = n.width ?? NODE_W;
    const h = n.height ?? NODE_H;
    const opts: Record<string, unknown> = { width: w, height: h };
    if (n.rank) opts.rank = n.rank;
    g.setNode(n.id, opts);
  }
  for (const e of input.edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  const out: Record<string, { x: number; y: number }> = {};
  for (const n of input.nodes) {
    const w = n.width ?? NODE_W;
    const h = n.height ?? NODE_H;
    const p = g.node(n.id);
    out[n.id] = { x: p.x - w / 2, y: p.y - h / 2 };
  }
  return out;
}

export function applyLayout(nodes: Node[], edges: Edge[]): Node[] {
  const positions = autoLayout({
    nodes: nodes.map(n => {
      const h = computeNodeHeight(n.data);
      return { id: n.id, width: NODE_W, height: h, rank: n.type === 'materialOutput' ? 'max' as const : undefined };
    }),
    edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target })),
  });
  return nodes.map(n => ({ ...n, position: positions[n.id] ?? { x: 0, y: 0 } }));
}

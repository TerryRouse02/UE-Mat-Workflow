import dagre from 'dagre';
import type { Node, Edge } from 'reactflow';

const NODE_W = 220;
const NODE_H = 100;

export interface LayoutInput {
  nodes: { id: string; width?: number; height?: number }[];
  edges: { id: string; source: string; target: string }[];
}

export function autoLayout(input: LayoutInput): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of input.nodes) {
    const w = n.width ?? NODE_W;
    const h = n.height ?? NODE_H;
    g.setNode(n.id, { width: w, height: h });
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
      const data = n.data || {};
      const inputs = data.inputs || [];
      const outputs = data.outputs || [];
      const params = data.params || {};

      const maxPins = Math.max(inputs.length, outputs.length);
      const pinHeight = maxPins * 18;
      const paramCount = Object.keys(params).length;
      const paramHeight = paramCount > 0 ? (12 + paramCount * 14) : 0;
      const warningHeight = data.warning ? 20 : 0;

      const h = 30 + Math.max(20, pinHeight) + paramHeight + warningHeight + 12;
      return { id: n.id, width: NODE_W, height: h };
    }),
    edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target })),
  });
  return nodes.map(n => ({ ...n, position: positions[n.id] ?? { x: 0, y: 0 } }));
}

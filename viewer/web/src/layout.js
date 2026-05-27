import dagre from 'dagre';
const NODE_W = 220;
const NODE_H = 100;
export function autoLayout(input) {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of input.nodes)
        g.setNode(n.id, { width: NODE_W, height: NODE_H });
    for (const e of input.edges)
        g.setEdge(e.source, e.target);
    dagre.layout(g);
    const out = {};
    for (const n of input.nodes) {
        const p = g.node(n.id);
        out[n.id] = { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 };
    }
    return out;
}
export function applyLayout(nodes, edges) {
    const positions = autoLayout({
        nodes: nodes.map(n => ({ id: n.id })),
        edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target })),
    });
    return nodes.map(n => ({ ...n, position: positions[n.id] ?? { x: 0, y: 0 } }));
}

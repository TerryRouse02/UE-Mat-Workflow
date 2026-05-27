import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from 'react';
import ReactFlow, { Background, Controls, MiniMap } from 'reactflow';
import 'reactflow/dist/style.css';
import { MaterialNode } from './nodes/MaterialNode';
import { MaterialOutputNode } from './nodes/MaterialOutputNode';
import { FunctionInputNode, FunctionOutputNode } from './nodes/FunctionIONode';
import { MaterialFunctionCallNode } from './nodes/MaterialFunctionCallNode';
import { CommentBoxOverlay } from './nodes/CommentBox';
import { applyLayout } from './layout';
const NODE_TYPES = {
    generic: MaterialNode,
    materialOutput: MaterialOutputNode,
    functionInput: FunctionInputNode,
    functionOutput: FunctionOutputNode,
    materialFunctionCall: MaterialFunctionCallNode,
};
function resolveMFRelative(mfRef, currentPath) {
    // currentPath like "main.matgraph.json" or "functions/x.matgraph.json"
    // mfRef like "./functions/y.matgraph.json" or "./z.matgraph.json"
    const dir = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/') + 1) : '';
    const cleaned = mfRef.replace(/^\.\//, '');
    return (dir + cleaned).replace(/\/\.\//g, '/');
}
export function Graph({ payload, basePath, db, onEnterMF }) {
    const { graph, derivedPins } = payload;
    const { nodes, edges } = useMemo(() => {
        const rfNodes = graph.nodes.map(n => {
            if (n.type === 'MaterialOutput') {
                return { id: n.id, type: 'materialOutput', position: { x: 0, y: 0 }, data: { id: n.id, params: n.params } };
            }
            if (n.type === 'FunctionInput') {
                return { id: n.id, type: 'functionInput', position: { x: 0, y: 0 }, data: { id: n.id, params: n.params } };
            }
            if (n.type === 'FunctionOutput') {
                return { id: n.id, type: 'functionOutput', position: { x: 0, y: 0 }, data: { id: n.id, params: n.params } };
            }
            if (n.type === 'MaterialFunctionCall') {
                const mfPath = n.params?.MaterialFunction ?? '';
                const pins = derivedPins[n.id] ?? { inputs: [], outputs: [] };
                const mfRefAbs = resolveMFRelative(mfPath, basePath);
                return {
                    id: n.id, type: 'materialFunctionCall', position: { x: 0, y: 0 },
                    data: {
                        id: n.id,
                        label: mfPath.split('/').pop()?.replace('.matgraph.json', '') ?? 'unknown',
                        inputs: pins.inputs, outputs: pins.outputs,
                        params: n.params,
                        onDoubleClick: () => onEnterMF(mfRefAbs),
                        warning: pins.inputs.length === 0 && pins.outputs.length === 0 ? 'MaterialFunction missing or empty' : undefined,
                    },
                };
            }
            const def = db.nodes[n.type];
            if (def) {
                return {
                    id: n.id, type: 'generic', position: { x: 0, y: 0 },
                    data: {
                        id: n.id, label: n.type,
                        inputs: def.inputs, outputs: def.outputs,
                        params: n.params,
                    },
                };
            }
            return {
                id: n.id, type: 'generic', position: { x: 0, y: 0 },
                data: { id: n.id, label: n.type, inputs: [], outputs: [], params: n.params, warning: `Unknown node type: ${n.type}` },
            };
        });
        const rfEdges = graph.connections.map((c, i) => {
            const [src, srcPin] = c.from.split(':');
            const [tgt, tgtPin] = c.to.split(':');
            return { id: `e${i}`, source: src, sourceHandle: srcPin, target: tgt, targetHandle: tgtPin };
        });
        return { nodes: applyLayout(rfNodes, rfEdges), edges: rfEdges };
    }, [graph, derivedPins, db, onEnterMF, basePath]);
    const commentBoxes = useMemo(() => {
        if (!graph.comments)
            return [];
        const positions = Object.fromEntries(nodes.map(n => [n.id, n.position]));
        return graph.comments.map(c => {
            const inside = c.contains.map(id => positions[id]).filter(Boolean);
            if (inside.length === 0)
                return null;
            const xs = inside.map(p => p.x), ys = inside.map(p => p.y);
            const minX = Math.min(...xs), maxX = Math.max(...xs) + 220;
            const minY = Math.min(...ys), maxY = Math.max(...ys) + 100;
            return { text: c.text, color: c.color ?? '#888', bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
        }).filter((c) => c !== null);
    }, [graph.comments, nodes]);
    return (_jsxs("div", { style: { position: 'relative', width: '100%', height: '100%' }, children: [_jsxs(ReactFlow, { nodes: nodes, edges: edges, nodeTypes: NODE_TYPES, fitView: true, style: { background: '#1a1a1a' }, children: [_jsx(Background, { gap: 20, color: "#333" }), _jsx(Controls, {}), _jsx(MiniMap, {})] }), _jsx(CommentBoxOverlay, { comments: commentBoxes })] }));
}

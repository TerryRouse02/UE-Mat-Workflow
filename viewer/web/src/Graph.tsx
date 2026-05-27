import { useMemo } from 'react';
import ReactFlow, { type Node, type Edge, Background, Controls, MiniMap } from 'reactflow';
import 'reactflow/dist/style.css';
import { MaterialNode } from './nodes/MaterialNode';
import { MaterialOutputNode } from './nodes/MaterialOutputNode';
import { FunctionInputNode, FunctionOutputNode } from './nodes/FunctionIONode';
import { MaterialFunctionCallNode } from './nodes/MaterialFunctionCallNode';
import { CommentBoxOverlay, type CommentBoxData } from './nodes/CommentBox';
import { applyLayout } from './layout';
import type { GraphPayload } from './protocol';
import type { NodeDB } from '../../server/db-types';

const NODE_TYPES = {
  generic: MaterialNode,
  materialOutput: MaterialOutputNode,
  functionInput: FunctionInputNode,
  functionOutput: FunctionOutputNode,
  materialFunctionCall: MaterialFunctionCallNode,
};

export interface GraphProps {
  payload: GraphPayload;
  basePath: string;  // path of the current graph file, relative to graphs/
  db: NodeDB;
  onEnterMF(path: string): void;
}

function inferPinsFromConnections(
  nodeId: string,
  connections: { from: string; to: string }[],
): { inputs: { name: string; type: string }[]; outputs: { name: string; type: string }[] } {
  const inputNames = new Set<string>();
  const outputNames = new Set<string>();
  for (const c of connections) {
    const [srcNode, srcPin] = c.from.split(':');
    const [tgtNode, tgtPin] = c.to.split(':');
    if (srcNode === nodeId && srcPin) outputNames.add(srcPin);
    if (tgtNode === nodeId && tgtPin) inputNames.add(tgtPin);
  }
  return {
    inputs: Array.from(inputNames).map(name => ({ name, type: 'Float' })),
    outputs: Array.from(outputNames).map(name => ({ name, type: 'Float' })),
  };
}

function resolveMFRelative(mfRef: string, currentPath: string): string {
  // currentPath like "main.matgraph.json" or "functions/x.matgraph.json"
  // mfRef like "./functions/y.matgraph.json" or "./z.matgraph.json"
  const dir = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/') + 1) : '';
  const cleaned = mfRef.replace(/^\.\//, '');
  return (dir + cleaned).replace(/\/\.\//g, '/');
}

export function Graph({ payload, basePath, db, onEnterMF }: GraphProps) {
  const { graph, derivedPins } = payload;

  const { nodes, edges } = useMemo(() => {
    const rfNodes: Node[] = graph.nodes.map(n => {
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
        const mfPath = (n.params?.MaterialFunction as string | undefined) ?? '';
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
      const dbInputs = def?.inputs ?? [];
      const dbOutputs = def?.outputs ?? [];

      // Fallback: if DB has no pin info, derive from connections in this graph
      const needInfer = dbInputs.length === 0 && dbOutputs.length === 0;
      const inferred = needInfer ? inferPinsFromConnections(n.id, graph.connections) : null;

      const finalInputs = inferred ? inferred.inputs : dbInputs;
      const finalOutputs = inferred ? inferred.outputs : dbOutputs;

      let warning: string | undefined;
      if (!def) warning = `Unknown node type: ${n.type}`;
      else if (inferred && (inferred.inputs.length > 0 || inferred.outputs.length > 0)) {
        warning = `Dynamic pins inferred from connections`;
      }

      return {
        id: n.id, type: 'generic', position: { x: 0, y: 0 },
        data: {
          id: n.id, label: n.type,
          inputs: finalInputs, outputs: finalOutputs,
          params: n.params,
          warning,
        },
      };
    });

    const rfEdges: Edge[] = graph.connections.map((c, i) => {
      const [src, srcPin] = c.from.split(':');
      const [tgt, tgtPin] = c.to.split(':');
      return { id: `e${i}`, source: src, sourceHandle: srcPin, target: tgt, targetHandle: tgtPin };
    });

    return { nodes: applyLayout(rfNodes, rfEdges), edges: rfEdges };
  }, [graph, derivedPins, db, onEnterMF, basePath]);

  const commentBoxes: CommentBoxData[] = useMemo(() => {
    if (!graph.comments) return [];
    const positions = Object.fromEntries(nodes.map(n => [n.id, n.position]));
    return graph.comments.map(c => {
      const inside = c.contains.map(id => positions[id]).filter(Boolean);
      if (inside.length === 0) return null;
      const xs = inside.map(p => p.x), ys = inside.map(p => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs) + 220;
      const minY = Math.min(...ys), maxY = Math.max(...ys) + 100;
      return { text: c.text, color: c.color ?? '#888', bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
    }).filter((c): c is CommentBoxData => c !== null);
  }, [graph.comments, nodes]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={NODE_TYPES}
        fitView style={{ background: '#1a1a1a' }}
      >
        <Background gap={20} color="#333" />
        <Controls />
        <MiniMap />
      </ReactFlow>
      <CommentBoxOverlay comments={commentBoxes} />
    </div>
  );
}

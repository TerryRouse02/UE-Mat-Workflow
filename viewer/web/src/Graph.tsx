import { useMemo } from 'react';
import ReactFlow, { type Node, type Edge, Background, Controls, MiniMap } from 'reactflow';
import 'reactflow/dist/style.css';
import { MaterialNode } from './nodes/MaterialNode';
import { MaterialOutputNode } from './nodes/MaterialOutputNode';
import { FunctionInputNode, FunctionOutputNode } from './nodes/FunctionIONode';
import { MaterialFunctionCallNode } from './nodes/MaterialFunctionCallNode';
import { CommentNode } from './nodes/CommentBox';
import { applyLayout, computeNodeHeight, NODE_W } from './layout';
import type { GraphPayload } from './protocol';
import type { NodeDB } from '../../server/db-types';

const NODE_TYPES = {
  generic: MaterialNode,
  materialOutput: MaterialOutputNode,
  functionInput: FunctionInputNode,
  functionOutput: FunctionOutputNode,
  materialFunctionCall: MaterialFunctionCallNode,
  commentBox: CommentNode,
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

  const commentNodes: Node[] = useMemo(() => {
    if (!graph.comments) return [];
    const byId = new Map(nodes.map(n => [n.id, n]));

    return graph.comments.map(c => {
      const insideBoxes = c.contains
        .map(id => {
          const n = byId.get(id);
          if (!n) return null;
          return {
            x: n.position.x,
            y: n.position.y,
            w: NODE_W,
            h: computeNodeHeight(n.data),
          };
        })
        .filter((b): b is { x: number; y: number; w: number; h: number } => b !== null);
      if (insideBoxes.length === 0) return null;

      const minX = Math.min(...insideBoxes.map(b => b.x));
      const maxX = Math.max(...insideBoxes.map(b => b.x + b.w));
      const minY = Math.min(...insideBoxes.map(b => b.y));
      const maxY = Math.max(...insideBoxes.map(b => b.y + b.h));

      // Padding: 16px horizontal on each side; 36px above (room for title), 16px below.
      const PAD_X = 16;
      const PAD_TOP = 36;
      const PAD_BOTTOM = 16;

      return {
        id: 'comment-' + c.id,
        type: 'commentBox',
        position: { x: minX - PAD_X, y: minY - PAD_TOP },
        data: {
          text: c.text,
          color: c.color ?? '#888',
          width: (maxX - minX) + PAD_X * 2,
          height: (maxY - minY) + PAD_TOP + PAD_BOTTOM,
        },
        draggable: false,
        selectable: false,
        zIndex: -1,
        style: { zIndex: -1 },
      } as Node;
    }).filter((n): n is Node => n !== null);
  }, [graph.comments, nodes]);

  const allNodes = [...commentNodes, ...nodes];

  return (
    <ReactFlow
      nodes={allNodes} edges={edges} nodeTypes={NODE_TYPES}
      fitView style={{ background: '#1a1a1a' }}

    >
      <Background gap={20} color="#333" />
      <Controls />
      <MiniMap />
    </ReactFlow>
  );
}

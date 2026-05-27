import { useMemo } from 'react';
import ReactFlow, { type Node, type Edge, Background, Controls, MiniMap } from 'reactflow';
import 'reactflow/dist/style.css';
import { MaterialNode } from './nodes/MaterialNode';
import { MaterialOutputNode } from './nodes/MaterialOutputNode';
import { FunctionInputNode, FunctionOutputNode } from './nodes/FunctionIONode';
import { MaterialFunctionCallNode } from './nodes/MaterialFunctionCallNode';
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

    const rfEdges: Edge[] = graph.connections.map((c, i) => {
      const [src, srcPin] = c.from.split(':');
      const [tgt, tgtPin] = c.to.split(':');
      return { id: `e${i}`, source: src, sourceHandle: srcPin, target: tgt, targetHandle: tgtPin };
    });

    return { nodes: applyLayout(rfNodes, rfEdges), edges: rfEdges };
  }, [graph, derivedPins, db, onEnterMF, basePath]);

  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={NODE_TYPES}
      fitView style={{ background: '#1a1a1a' }}
    >
      <Background gap={20} color="#333" />
      <Controls />
      <MiniMap />
    </ReactFlow>
  );
}

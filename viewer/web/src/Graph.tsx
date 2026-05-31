import { useMemo, useEffect } from 'react';
import ReactFlow, { type Node, type Edge, Background, Controls, MiniMap, useNodesState } from 'reactflow';
import 'reactflow/dist/style.css';
import { MaterialNode } from './nodes/MaterialNode';
import { MaterialOutputNode } from './nodes/MaterialOutputNode';
import { FunctionInputNode, FunctionOutputNode } from './nodes/FunctionIONode';
import { MaterialFunctionCallNode } from './nodes/MaterialFunctionCallNode';
import { CommentNode } from './nodes/CommentBox';
import { applyLayout, computeNodeHeight, computeNodeWidth } from './layout';
import type { GraphPayload } from './protocol';
import type { NodeDB } from '../../server/db-types';
import { validateConnectionPins } from './validate';

function setHandleHighlight(nodeId: string, handleId: string | null | undefined, on: boolean) {
  if (!handleId) return;
  const selector = `.react-flow__handle[data-nodeid="${nodeId}"][data-handleid="${CSS.escape(handleId)}"]`;
  const el = document.querySelector(selector);
  if (el) el.classList.toggle('handle-highlighted', on);
}

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
  onSelectNode?: (id: string | null) => void;
  onPositions?: (p: Record<string, { x: number; y: number }>) => void;
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

function mergePins(
  ...sources: { name: string; type: string }[][]
): { name: string; type: string }[] {
  const seen = new Map<string, { name: string; type: string }>();
  for (const src of sources) {
    for (const p of src) {
      if (!seen.has(p.name)) seen.set(p.name, p);
    }
  }
  return Array.from(seen.values());
}

function mapCmotToDisplay(cmot: string | undefined): string {
  switch (cmot) {
    case 'CMOT_Float1': return 'Float1';
    case 'CMOT_Float2': return 'Float2';
    case 'CMOT_Float3': return 'Float3';
    case 'CMOT_Float4': return 'Float4';
    case 'CMOT_MaterialAttributes': return 'MaterialAttributes';
    default: return 'Float3'; // UE default
  }
}

function resolveMFRelative(mfRef: string, currentPath: string): string {
  // currentPath like "main.matgraph.json" or "functions/x.matgraph.json"
  // mfRef like "./functions/y.matgraph.json" or "./z.matgraph.json"
  const dir = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/') + 1) : '';
  const cleaned = mfRef.replace(/^\.\//, '');
  return (dir + cleaned).replace(/\/\.\//g, '/');
}

export function Graph({ payload, basePath, db, onEnterMF, onPositions }: GraphProps) {
  const { graph, derivedPins } = payload;

  const initialLayout = useMemo(() => {
    // Load-time validation: connections referencing pins that don't exist on the
    // referenced node. Collect per-node so each problem surfaces on its node via
    // the same `warning` mechanism as "Unknown node type".
    const pinIssuesByNode = new Map<string, string[]>();
    for (const issue of validateConnectionPins(graph, db)) {
      const srcId = issue.from.split(':')[0];
      const dstId = issue.to.split(':')[0];
      const target = issue.problem.includes('no input pin') ? dstId : srcId;
      const list = pinIssuesByNode.get(target) ?? [];
      list.push(issue.problem);
      pinIssuesByNode.set(target, list);
    }

    const rfNodes: Node[] = graph.nodes.map(n => {
      if (n.type === 'MaterialOutput') {
        const pinProblems = pinIssuesByNode.get(n.id);
        return {
          id: n.id, type: 'materialOutput', position: { x: 0, y: 0 },
          data: { id: n.id, params: n.params, warning: pinProblems?.join('\n') },
        };
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
      const isDynamic = !!def?.dynamicPins;

      // Per-side inference + merge with DB + Custom-specific explicit sources
      const inferred = inferPinsFromConnections(n.id, graph.connections);

      // Custom node: params.Inputs is the authoritative source for input pin names.
      const customInputsFromParams: { name: string; type: string }[] =
        n.type === 'Custom' && Array.isArray(n.params?.Inputs)
          ? (n.params!.Inputs as Array<{ InputName?: string }>)
              .filter(i => typeof i.InputName === 'string' && i.InputName.length > 0)
              .map(i => ({ name: i.InputName as string, type: 'Float' }))
          : [];

      // Custom node: params.AdditionalOutputs declares extra outputs beyond the default 'Output'.
      const customExtraOutputs: { name: string; type: string }[] =
        n.type === 'Custom' && Array.isArray(n.params?.AdditionalOutputs)
          ? (n.params!.AdditionalOutputs as Array<{ OutputName?: string; OutputType?: string }>)
              .filter(o => typeof o.OutputName === 'string' && o.OutputName.length > 0)
              .map(o => ({ name: o.OutputName as string, type: mapCmotToDisplay(o.OutputType) }))
          : [];

      // Compute the Custom default output's display type from params.OutputType
      const customOutputDisplayType =
        n.type === 'Custom' ? mapCmotToDisplay(n.params?.OutputType as string | undefined) : null;

      const finalInputs = mergePins(
        dbInputs,
        customInputsFromParams,
        isDynamic ? inferred.inputs : [],
      );
      const finalOutputs = mergePins(
        // For Custom, replace the placeholder 'matchOutputType' on the default Output with the real type
        customOutputDisplayType
          ? dbOutputs.map(p => p.name === 'Output' ? { ...p, type: customOutputDisplayType } : p)
          : dbOutputs,
        customExtraOutputs,
        isDynamic ? inferred.outputs : [],
      );

      let warning: string | undefined;
      if (!def) warning = `Unknown node type: ${n.type}`;
      const pinProblems = pinIssuesByNode.get(n.id);
      if (pinProblems && pinProblems.length > 0) {
        warning = [warning, ...pinProblems].filter(Boolean).join('\n');
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

    const clusters = (graph.comments ?? []).map(c => ({
      id: 'comment-' + c.id,
      childNodeIds: c.contains,
    }));

    const result = applyLayout(rfNodes, rfEdges, clusters);
    return { nodes: result.nodes, edges: rfEdges, clusterBounds: result.clusterBounds };
  }, [graph, derivedPins, db, onEnterMF, basePath]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialLayout.nodes);

  // Reset to fresh layout whenever the graph/payload/MF derived pins change
  useEffect(() => {
    setNodes(initialLayout.nodes);
  }, [initialLayout.nodes, setNodes]);

  const edges = initialLayout.edges;

  useEffect(() => {
    if (!onPositions) return;
    const p: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) p[n.id] = { x: n.position.x, y: n.position.y };
    onPositions(p);
  }, [nodes, onPositions]);

  const commentNodes: Node[] = useMemo(() => {
    if (!graph.comments) return [];
    const byId = new Map(nodes.map(n => [n.id, n]));

    return graph.comments.map(c => {
      const clusterId = 'comment-' + c.id;
      const bounds = initialLayout.clusterBounds[clusterId];

      // Compute bounds from live node positions (so the box follows drags)
      // Fall back to dagre cluster bounds if there's nothing else.
      const insideBoxes = c.contains
        .map(id => {
          const n = byId.get(id);
          if (!n) return null;
          return {
            x: n.position.x,
            y: n.position.y,
            w: computeNodeWidth(n.data),
            h: computeNodeHeight(n.data),
          };
        })
        .filter((b): b is { x: number; y: number; w: number; h: number } => b !== null);

      let x: number, y: number, w: number, h: number;

      if (insideBoxes.length > 0) {
        const minX = Math.min(...insideBoxes.map(b => b.x));
        const maxX = Math.max(...insideBoxes.map(b => b.x + b.w));
        const minY = Math.min(...insideBoxes.map(b => b.y));
        const maxY = Math.max(...insideBoxes.map(b => b.y + b.h));
        const PAD_X = 32;
        const PAD_TOP = 36;
        const PAD_BOTTOM = 24;
        x = minX - PAD_X;
        y = minY - PAD_TOP;
        w = (maxX - minX) + PAD_X * 2;
        h = (maxY - minY) + PAD_TOP + PAD_BOTTOM;
      } else if (bounds) {
        x = bounds.x;
        y = bounds.y;
        w = bounds.width;
        h = bounds.height;
      } else {
        return null;
      }

      return {
        id: clusterId,
        type: 'commentBox',
        position: { x, y },
        data: {
          text: c.text,
          color: c.color ?? '#888',
          width: w,
          height: h,
        },
        draggable: false,
        selectable: false,
        zIndex: -1,
        style: { zIndex: -1 },
      } as Node;
    }).filter((n): n is Node => n !== null);
  }, [graph.comments, nodes, initialLayout.clusterBounds]);

  const allNodes = [...commentNodes, ...nodes];

  return (
    <ReactFlow
      nodes={allNodes} edges={edges} nodeTypes={NODE_TYPES}
      onNodesChange={onNodesChange}
      onEdgeMouseEnter={(_, edge) => {
        setHandleHighlight(edge.source, edge.sourceHandle, true);
        setHandleHighlight(edge.target, edge.targetHandle, true);
      }}
      onEdgeMouseLeave={(_, edge) => {
        setHandleHighlight(edge.source, edge.sourceHandle, false);
        setHandleHighlight(edge.target, edge.targetHandle, false);
      }}
      fitView style={{ background: '#1a1a1a' }}
    >
      <Background gap={20} color="#333" />
      <Controls />
      <MiniMap />
    </ReactFlow>
  );
}

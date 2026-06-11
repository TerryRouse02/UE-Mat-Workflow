import { useMemo, useEffect, useState, useRef, useCallback } from 'react';
import React from 'react';
import ReactFlow, { type Node, type Edge, Background, Controls, MiniMap, useNodesState, useReactFlow, useNodesInitialized, ReactFlowProvider, BackgroundVariant } from 'reactflow';
import 'reactflow/dist/style.css';
import './graph.css';
import { MaterialNode } from './nodes/MaterialNode';
import { MaterialOutputNode } from './nodes/MaterialOutputNode';
import { FunctionInputNode, FunctionOutputNode } from './nodes/FunctionIONode';
import { MaterialFunctionCallNode } from './nodes/MaterialFunctionCallNode';
import { CommentNode } from './nodes/CommentBox';
import { applyLayout, computeNodeHeight, computeNodeWidth } from './layout';
import type { GraphPayload } from './protocol';
import type { NodeDB } from '../../server/db-types';
import { validateConnectionPins } from './validate';
import { mfPinsUnresolved } from './graphDiagnostics';
import { pinColor } from './theme/colors';
import { splitRef } from './connstr';
import { computeCommentBounds } from './commentBounds';
import { NodeExplainPopover } from './agent/NodeExplainPopover';

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
  /** Centre + highlight a node (from a debug-panel click); nonce re-triggers it. */
  focus?: { id: string; nonce: number } | null;
}

function inferPinsFromConnections(
  nodeId: string,
  connections: { from: string; to: string }[],
): { inputs: { name: string; type: string }[]; outputs: { name: string; type: string }[] } {
  const inputNames = new Set<string>();
  const outputNames = new Set<string>();
  for (const c of connections) {
    const [srcNode, srcPin] = splitRef(c.from);
    const [tgtNode, tgtPin] = splitRef(c.to);
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

/** State for the node-explain hover popover. Null when closed. */
interface PopoverSlot {
  nodeId: string;
  nodeType: string;
  x: number;
  y: number;
}

const HOVER_DELAY_MS = 500;

function GraphInner({ payload, basePath, db, onEnterMF, onSelectNode, onPositions, focus }: GraphProps) {
  const { graph, derivedPins } = payload;

  const rf = useReactFlow();
  const [selId, setSelId] = useState<string | null>(null);

  // ─── Hover popover state ─────────────────────────────────────────────────
  // Single {nodeId, nodeType, x, y} slot; no per-node state, no layout re-run.
  const [popover, setPopover] = useState<PopoverSlot | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // LLM result cache lives at GraphInner scope so it persists across close/reopen cycles.
  const explainCacheRef = useRef<Map<string, string>>(new Map());

  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  }, []);

  const handleNodeMouseEnter = useCallback((_event: React.MouseEvent, node: Node) => {
    clearHoverTimer();
    const nodeType = (node.data as { nodeType?: string })?.nodeType ?? node.id;
    const event = _event;
    hoverTimerRef.current = setTimeout(() => {
      setPopover({
        nodeId: node.id,
        nodeType,
        x: event.clientX,
        y: event.clientY,
      });
    }, HOVER_DELAY_MS);
  }, [clearHoverTimer]);

  const handleNodeMouseLeave = useCallback(() => {
    clearHoverTimer();
    // Do NOT close an already-open popover on mouse leave — the user needs to
    // interact with it (click 深入解說, scroll, then close via × or Escape).
    // The popover is closed via its own close button or pane-click.
  }, [clearHoverTimer]);

  // Close popover when the pane is clicked (i.e., clicking outside any node).
  const closePopover = useCallback(() => {
    clearHoverTimer();
    setPopover(null);
  }, [clearHoverTimer]);

  // Cleanup timer on unmount.
  useEffect(() => () => clearHoverTimer(), [clearHoverTimer]);

  const initialLayout = useMemo(() => {
    // Load-time validation: connections referencing pins that don't exist on the
    // referenced node. Collect per-node so each problem surfaces on its node via
    // the same `warning` mechanism as "Unknown node type".
    const pinIssuesByNode = new Map<string, string[]>();
    for (const issue of validateConnectionPins(graph, db)) {
      const list = pinIssuesByNode.get(issue.nodeId) ?? [];
      list.push(issue.problem);
      pinIssuesByNode.set(issue.nodeId, list);
    }

    const rfNodes: Node[] = graph.nodes.map(n => {
      if (n.type === 'MaterialOutput') {
        const pinProblems = pinIssuesByNode.get(n.id);
        return {
          id: n.id, type: 'materialOutput', position: { x: 0, y: 0 },
          data: { id: n.id, nodeType: n.type, params: n.params, warning: pinProblems?.join('\n') },
        };
      }
      if (n.type === 'FunctionInput') {
        return { id: n.id, type: 'functionInput', position: { x: 0, y: 0 }, data: { id: n.id, nodeType: n.type, params: n.params } };
      }
      if (n.type === 'FunctionOutput') {
        return { id: n.id, type: 'functionOutput', position: { x: 0, y: 0 }, data: { id: n.id, nodeType: n.type, params: n.params } };
      }
      if (n.type === 'MaterialFunctionCall') {
        const mfPath = (n.params?.MaterialFunction as string | undefined) ?? '';
        const pins = derivedPins[n.id] ?? { inputs: [], outputs: [] };
        const mfRefAbs = resolveMFRelative(mfPath, basePath);
        return {
          id: n.id, type: 'materialFunctionCall', position: { x: 0, y: 0 },
          data: {
            id: n.id,
            nodeType: n.type,
            label: mfPath.split('/').pop()?.replace('.matgraph.json', '') ?? 'unknown',
            inputs: pins.inputs, outputs: pins.outputs,
            params: n.params,
            onDoubleClick: () => onEnterMF(mfRefAbs),
            warning: mfPinsUnresolved(derivedPins[n.id]) ? 'MaterialFunction missing or empty' : undefined,
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
          id: n.id, nodeType: n.type, label: n.type,
          inputs: finalInputs, outputs: finalOutputs,
          params: n.params,
          warning,
          category: def?.category,
        },
      };
    });

    // Build a Map<id, type> once so edge coloring is O(E) not O(E×N).
    const nodeTypeById = new Map(graph.nodes.map(n => [n.id, n.type]));
    const rfEdges: Edge[] = graph.connections.map((c, i) => {
      const [src, srcPin] = splitRef(c.from);
      const [tgt, tgtPin] = splitRef(c.to);
      const srcNodeType = nodeTypeById.get(src) ?? '';
      const srcType = derivedPins[src]?.outputs.find(o => o.name === srcPin)?.type
        ?? db.nodes[srcNodeType]?.outputs?.find(o => o.name === srcPin)?.type;
      return { id: `e${i}`, source: src, sourceHandle: srcPin, target: tgt, targetHandle: tgtPin,
        style: { stroke: pinColor(srcType), strokeWidth: 2 } };
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

  // Fit to the nodes, but only AFTER ReactFlow has measured them — so we always
  // land centred on real nodes and never on blank space. <Graph> is keyed by the
  // active path (remounts per graph); `useNodesInitialized` flips true once the
  // fresh nodes have real dimensions. Re-run on layout changes too, to cover an
  // in-place hot-reload of the same path.
  const nodesInitialized = useNodesInitialized();
  useEffect(() => {
    if (nodesInitialized) rf.fitView({ padding: 0.2, duration: 200 });
  }, [nodesInitialized, initialLayout.nodes, rf]);

  // Debug-panel focus: centre the viewport on a node and highlight it (via selId,
  // which dims everything but it + its neighbours). Doesn't touch the App's node
  // selection, so the Inspector keeps showing the debug list.
  //
  // Read the node from React Flow's live store (rf.getNode) rather than the `nodes`
  // state closure: that gives the node's *measured* width/height — correct even for
  // reserved nodes (MaterialOutput/FunctionInput/FunctionOutput) whose data shape
  // carries no pins, so computeNodeWidth/Height would otherwise under-estimate and
  // mis-centre — and its current position, with no dependency on a stale `nodes` snapshot.
  useEffect(() => {
    if (!focus) return;
    const rn = rf.getNode(focus.id);
    if (!rn) return;
    const w = rn.width ?? computeNodeWidth(rn.data);
    const h = rn.height ?? computeNodeHeight(rn.data);
    const px = rn.positionAbsolute?.x ?? rn.position.x;
    const py = rn.positionAbsolute?.y ?? rn.position.y;
    rf.setCenter(px + w / 2, py + h / 2, { zoom: 1.1, duration: 400 });
    setSelId(focus.id);
  }, [focus, rf]);

  const commentNodes: Node[] = useMemo(() => {
    if (!graph.comments) return [];
    const byId = new Map(nodes.map(n => [n.id, n]));

    // Build nodeRect from live node positions so boxes follow drags.
    const nodeRect = (id: string) => {
      const n = byId.get(id);
      if (!n) return undefined;
      return {
        x: n.position.x,
        y: n.position.y,
        width: computeNodeWidth(n.data),
        height: computeNodeHeight(n.data),
      };
    };

    const boundsMap = computeCommentBounds(graph.comments, nodeRect);

    return graph.comments.map(c => {
      const clusterId = 'comment-' + c.id;
      const computed = boundsMap.get(c.id);

      // Fall back to dagre cluster bounds if computeCommentBounds produced no rect.
      const fallback = initialLayout.clusterBounds[clusterId];
      const rect = computed ?? fallback;
      if (!rect) return null;

      return {
        id: clusterId,
        type: 'commentBox',
        position: { x: rect.x, y: rect.y },
        data: {
          text: c.text,
          color: c.color ?? '#888',
          width: rect.width,
          height: rect.height,
        },
        draggable: false,
        selectable: false,
        zIndex: -1,
        style: { zIndex: -1 },
      } as Node;
    }).filter((n): n is Node => n !== null);
  }, [graph.comments, nodes, initialLayout.clusterBounds]);

  const connSet = useMemo(() => {
    if (!selId) return null;
    const s = new Set<string>([selId]);
    for (const c of graph.connections) {
      const a = splitRef(c.from)[0], b = splitRef(c.to)[0];
      if (a === selId) s.add(b);
      if (b === selId) s.add(a);
    }
    return s;
  }, [selId, graph.connections]);

  const allNodes = useMemo(() => [...commentNodes, ...nodes].map(n =>
    connSet && !n.id.startsWith('comment-') && !connSet.has(n.id)
      ? { ...n, style: { ...n.style, opacity: 0.3 } }
      : n
  ), [commentNodes, nodes, connSet]);
  const displayEdges = useMemo(() => connSet
    ? edges.map(e => ({ ...e, style: { ...e.style, opacity: connSet.has(e.source) && connSet.has(e.target) ? 1 : 0.15 } }))
    : edges, [edges, connSet]);

  return (
    <>
      <ReactFlow
        nodes={allNodes} edges={displayEdges} nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onNodeClick={(_, n) => { setSelId(n.id); onSelectNode?.(n.id); closePopover(); }}
        onPaneClick={() => { setSelId(null); onSelectNode?.(null); closePopover(); }}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        onEdgeMouseEnter={(_, edge) => {
          setHandleHighlight(edge.source, edge.sourceHandle, true);
          setHandleHighlight(edge.target, edge.targetHandle, true);
        }}
        onEdgeMouseLeave={(_, edge) => {
          setHandleHighlight(edge.source, edge.sourceHandle, false);
          setHandleHighlight(edge.target, edge.targetHandle, false);
        }}
        fitView
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2a2f37" />
        <Controls />
        <MiniMap pannable zoomable maskColor="rgba(0,0,0,0.6)" />
      </ReactFlow>
      {popover && (
        <NodeExplainPopover
          nodeType={popover.nodeType}
          nodeId={popover.nodeId}
          x={popover.x}
          y={popover.y}
          graphPath={basePath}
          onClose={closePopover}
          explainCache={explainCacheRef.current}
        />
      )}
    </>
  );
}

export function Graph(props: GraphProps) {
  return <ReactFlowProvider><GraphInner {...props} /></ReactFlowProvider>;
}

import type { MatGraph, NodeJson, DerivedPins } from '../protocol';
import type { ExportMeta, NodeExportMeta, OutputMeta, ParamMeta } from './export-meta-types';

export interface UEExportOptions { mfContentRoot?: string; }
export interface UEExportResult { text: string; warnings: string[]; }

const I = '   '; // 3-space indent, mirroring UE
const GRAPH_ROOT = '/Engine/Transient.UEMatWorkflowClipboard:MaterialGraph_0';

interface EmittedExpression {
  node: NodeJson;
  meta: NodeExportMeta;
  graphNodeName: string;
  expressionName: string;
}

interface EmittedComment {
  id: string;
  text: string;
  color?: string;
  contains: string[];
  graphNodeName: string;
  expressionName: string;
}

interface PinLink {
  graphNodeName: string;
  pinId: string;
}

function metaFor(meta: ExportMeta, type: string): NodeExportMeta | undefined {
  return meta.nodes[type] ?? meta.reserved[type];
}

function ueClassName(ueClass: string): string {
  const dot = ueClass.lastIndexOf('.');
  return dot >= 0 ? ueClass.slice(dot + 1) : ueClass;
}

function fmtFloat(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '0.0';
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

function quote(value: unknown): string {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function fmtParam(value: unknown, p: ParamMeta, node: NodeJson): string | null {
  switch (p.kind) {
    case 'float': return fmtFloat(value);
    case 'int': return String(Math.trunc(Number(value)));
    case 'bool': return value ? 'True' : 'False';
    case 'name':
    case 'string': return quote(value);
    case 'enum': return p.valueMap?.[String(value)] ?? String(value);
    case 'texture': {
      const path = typeof value === 'string' ? value.trim() : '';
      return path ? `Texture2D'${quote(path)}'` : 'None';
    }
    case 'vector2':
    case 'vector3':
    case 'vector4': {
      const keys = p.kind === 'vector2'
        ? ['R', 'G']
        : p.kind === 'vector3'
          ? ['R', 'G', 'B']
          : ['R', 'G', 'B', 'A'];
      const objectValue = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
      const parts = Array.isArray(value)
        ? keys.map((key, i) => `${key}=${fmtFloat(value[i])}`)
        : objectValue
          ? keys.map(key => `${key}=${fmtFloat(objectValue[key])}`)
          : p.components
            ? Object.entries(p.components).map(([ueKey, ourParam]) => `${ueKey}=${fmtFloat(node.params?.[ourParam])}`)
            : [];
      if (parts.length === 0) return null;
      return `(${parts.join(',')})`;
    }
    default: return String(value);
  }
}

function hexToRGBA(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? '').trim());
  if (!m) return '(R=0.5,G=0.5,B=0.5,A=1.0)';
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  return `(R=${fmtFloat(r)},G=${fmtFloat(g)},B=${fmtFloat(b)},A=1.0)`;
}

function maskBits(mask?: OutputMeta['mask']): string {
  if (!mask) return '';
  const on = (c: string) => (mask.includes(c) ? 1 : 0);
  return `,Mask=1,MaskR=${on('R')},MaskG=${on('G')},MaskB=${on('B')},MaskA=${on('A')}`;
}

function mfPathToAssetRef(mfRef: string, root: string): string {
  if (mfRef.startsWith('/')) return mfRef;
  const base = (mfRef.split('/').pop() ?? mfRef).replace(/\.matgraph\.json$/, '');
  const clean = root.replace(/\/+$/, '');
  return `${clean}/${base}.${base}`;
}

function functionInputIndex(node: NodeJson, nodeMeta: NodeExportMeta, pinName: string, derivedPins: Record<string, DerivedPins>): number {
  const mapped = nodeMeta.inputs[pinName]?.property ?? '';
  const match = /^FunctionInputs\((\d+)\)$/.exec(mapped);
  if (match) return Number(match[1]);
  const i = (derivedPins[node.id]?.inputs ?? []).findIndex(p => p.name === pinName);
  return i < 0 ? 0 : i;
}

function guidFor(seed: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  let c = 0x85ebca6b;
  let d = 0xc2b2ae35;
  for (let i = 0; i < seed.length; i++) {
    const code = seed.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b + code, 0x85ebca6b) >>> 0;
    c = Math.imul(c ^ (code << (i % 8)), 0xc2b2ae35) >>> 0;
    d = Math.imul(d + (code << (i % 5)), 0x27d4eb2d) >>> 0;
  }
  return [a, b, c, d].map(n => n.toString(16).padStart(8, '0')).join('').toUpperCase();
}

function objectRef(classPath: string, objectName: string): string {
  return `${ueClassName(classPath)}'${objectName}'`;
}

function pinId(nodeId: string, pinName: string, direction: 'input' | 'output'): string {
  return guidFor(`pin:${nodeId}:${direction}:${pinName}`);
}

function nodeOutputPins(node: NodeJson, meta: NodeExportMeta, derivedPins: Record<string, DerivedPins>): string[] {
  if (node.type === 'MaterialFunctionCall') {
    return (derivedPins[node.id]?.outputs ?? []).map(pin => pin.name);
  }
  return Object.entries(meta.outputs)
    .sort(([, a], [, b]) => a.index - b.index)
    .map(([name]) => name);
}

function nodeInputPins(node: NodeJson, meta: NodeExportMeta, derivedPins: Record<string, DerivedPins>): string[] {
  if (node.type === 'MaterialFunctionCall' && Object.keys(meta.inputs).length === 0) {
    return (derivedPins[node.id]?.inputs ?? []).map(pin => pin.name);
  }
  return Object.keys(meta.inputs);
}

function pinKey(nodeId: string, direction: 'input' | 'output', pinName: string): string {
  return `${nodeId}:${direction}:${pinName}`;
}

function pushPinLink(map: Map<string, PinLink[]>, key: string, link: PinLink): void {
  const links = map.get(key);
  if (links) {
    links.push(link);
  } else {
    map.set(key, [link]);
  }
}

function pinLine(
  nodeId: string,
  pinName: string,
  direction: 'input' | 'output',
  links: PinLink[],
): string {
  const parts = [
    `PinId=${pinId(nodeId, pinName, direction)}`,
    `PinName=${quote(pinName)}`,
    `Direction=${quote(direction === 'input' ? 'EGPD_Input' : 'EGPD_Output')}`,
  ];
  if (links.length > 0) {
    parts.push(`LinkedTo=(${links.map(link => `${link.graphNodeName} ${link.pinId}`).join(',')},)`);
  }
  return `${I}CustomProperties Pin (${parts.join(',')},)`;
}

export function graphToUET3D(
  graph: MatGraph,
  layout: Record<string, { x: number; y: number }>,
  meta: ExportMeta,
  derivedPins: Record<string, DerivedPins>,
  opts: UEExportOptions = {},
): UEExportResult {
  const warnings: string[] = [];
  const mfRoot = opts.mfContentRoot || '/Game/';
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const emitted: EmittedExpression[] = [];
  const byNodeId = new Map<string, EmittedExpression>();
  let counter = 0;

  for (const node of graph.nodes) {
    if (node.type === 'MaterialOutput') {
      warnings.push(`MaterialOutput "${node.id}" skipped - connect final pins manually in UE.`);
      continue;
    }
    const nodeMeta = metaFor(meta, node.type);
    if (!nodeMeta || nodeMeta.dynamicExport) {
      warnings.push(`Node "${node.id}" (type ${node.type}) not exportable yet - skipped.`);
      continue;
    }
    const item: EmittedExpression = {
      node,
      meta: nodeMeta,
      graphNodeName: `MaterialGraphNode_${counter}`,
      expressionName: `${ueClassName(nodeMeta.ueClass)}_${counter}`,
    };
    counter += 1;
    emitted.push(item);
    byNodeId.set(node.id, item);
  }

  const comments: EmittedComment[] = (graph.comments ?? []).map((comment, i) => ({
    ...comment,
    graphNodeName: `MaterialGraphNode_Comment_${i}`,
    expressionName: `MaterialExpressionComment_${i}`,
  }));

  const srcRef = (srcId: string, srcPin: string): { index: number; mask?: string } => {
    const node = byId.get(srcId);
    if (node?.type === 'MaterialFunctionCall') {
      const idx = (derivedPins[srcId]?.outputs ?? []).findIndex(o => o.name === srcPin);
      return { index: idx < 0 ? 0 : idx };
    }
    const o = node ? metaFor(meta, node.type)?.outputs?.[srcPin] : undefined;
    return { index: o?.index ?? 0, mask: o?.mask };
  };

  const incoming = new Map<string, { srcId: string; srcPin: string; dstPin: string }[]>();
  const pinLinks = new Map<string, PinLink[]>();
  for (const connection of graph.connections) {
    const [srcId, srcPin] = connection.from.split(':');
    const [dstId, dstPin] = connection.to.split(':');
    const src = byNodeId.get(srcId);
    const dst = byNodeId.get(dstId);
    if (!src || !dst) continue;

    const incomingForNode = incoming.get(dstId);
    const incomingItem = { srcId, srcPin, dstPin };
    if (incomingForNode) {
      incomingForNode.push(incomingItem);
    } else {
      incoming.set(dstId, [incomingItem]);
    }

    pushPinLink(pinLinks, pinKey(srcId, 'output', srcPin), {
      graphNodeName: dst.graphNodeName,
      pinId: pinId(dstId, dstPin, 'input'),
    });
    pushPinLink(pinLinks, pinKey(dstId, 'input', dstPin), {
      graphNodeName: src.graphNodeName,
      pinId: pinId(srcId, srcPin, 'output'),
    });
  }

  const lines: string[] = [];

  for (const comment of comments) {
    const pts = comment.contains.map(id => layout[id]).filter(Boolean) as { x: number; y: number }[];
    let x = 0;
    let y = 0;
    let w = 400;
    let h = 200;
    if (pts.length > 0) {
      const minX = Math.min(...pts.map(p => p.x));
      const maxX = Math.max(...pts.map(p => p.x));
      const minY = Math.min(...pts.map(p => p.y));
      const maxY = Math.max(...pts.map(p => p.y));
      x = Math.round(minX - 40);
      y = Math.round(minY - 50);
      w = Math.round((maxX - minX) + 300);
      h = Math.round((maxY - minY) + 200);
    }

    lines.push(`Begin Object Class=/Script/UnrealEd.MaterialGraphNode_Comment Name="${comment.graphNodeName}" ExportPath="/Script/UnrealEd.MaterialGraphNode_Comment'${GRAPH_ROOT}.${comment.graphNodeName}'"`);
    lines.push(`${I}Begin Object Class=/Script/Engine.MaterialExpressionComment Name="${comment.expressionName}" ExportPath="/Script/Engine.MaterialExpressionComment'${GRAPH_ROOT}.${comment.graphNodeName}.${comment.expressionName}'"`);
    lines.push(`${I}End Object`);
    lines.push(`${I}Begin Object Name="${comment.expressionName}"`);
    lines.push(`${I}${I}Text=${quote(comment.text)}`);
    lines.push(`${I}${I}CommentColor=${hexToRGBA(comment.color ?? '#888888')}`);
    lines.push(`${I}${I}SizeX=${w}`);
    lines.push(`${I}${I}SizeY=${h}`);
    lines.push(`${I}${I}MaterialExpressionEditorX=${x}`);
    lines.push(`${I}${I}MaterialExpressionEditorY=${y}`);
    lines.push(`${I}End Object`);
    lines.push(`${I}MaterialExpressionComment=${objectRef('/Script/Engine.MaterialExpressionComment', comment.expressionName)}`);
    lines.push(`${I}NodePosX=${x}`);
    lines.push(`${I}NodePosY=${y}`);
    lines.push(`${I}NodeWidth=${w}`);
    lines.push(`${I}NodeHeight=${h}`);
    lines.push(`${I}NodeComment=${quote(comment.text)}`);
    lines.push(`${I}CommentColor=${hexToRGBA(comment.color ?? '#888888')}`);
    lines.push(`${I}NodeGuid=${guidFor(`node:${comment.id}`)}`);
    lines.push(`End Object`);
  }

  for (const item of emitted) {
    const { node, meta: nodeMeta } = item;
    const pos = layout[node.id] ?? { x: 0, y: 0 };

    lines.push(`Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="${item.graphNodeName}" ExportPath="/Script/UnrealEd.MaterialGraphNode'${GRAPH_ROOT}.${item.graphNodeName}'"`);
    lines.push(`${I}Begin Object Class=${nodeMeta.ueClass} Name="${item.expressionName}" ExportPath="${nodeMeta.ueClass}'${GRAPH_ROOT}.${item.graphNodeName}.${item.expressionName}'"`);
    lines.push(`${I}End Object`);
    lines.push(`${I}Begin Object Name="${item.expressionName}"`);

    for (const [paramName, value] of Object.entries(node.params ?? {})) {
      const paramMeta = nodeMeta.params[paramName];
      if (!paramMeta) continue;
      const formatted = fmtParam(value, paramMeta, node);
      if (formatted === null) continue;
      lines.push(`${I}${I}${paramMeta.property}=${formatted}`);
    }

    if (nodeMeta.functionRefProperty) {
      const mfRef = nodeMeta.functionAsset ?? (node.params?.MaterialFunction as string | undefined) ?? '';
      if (mfRef) {
        const assetRef = mfPathToAssetRef(mfRef, mfRoot);
        lines.push(`${I}${I}${nodeMeta.functionRefProperty}=MaterialFunction'${quote(assetRef)}'`);
        if (node.type === 'MaterialFunctionCall' && !mfRef.startsWith('/')) {
          warnings.push(`MaterialFunctionCall "${node.id}" -> create Material Function "${assetRef}" in UE for auto-link.`);
        }
      }
    }

    for (const connection of incoming.get(node.id) ?? []) {
      const src = byNodeId.get(connection.srcId);
      if (!src) continue;
      const { index, mask } = srcRef(connection.srcId, connection.srcPin);
      const ref = `Expression=${src.expressionName},OutputIndex=${index}${maskBits(mask)}`;
      if (nodeMeta.functionRefProperty) {
        lines.push(`${I}${I}FunctionInputs(${functionInputIndex(node, nodeMeta, connection.dstPin, derivedPins)})=(Input=(${ref}))`);
      } else {
        const inProp = nodeMeta.inputs[connection.dstPin]?.property;
        if (!inProp) {
          warnings.push(`Node "${node.id}" (${node.type}): input pin "${connection.dstPin}" has no UE mapping - connection skipped.`);
          continue;
        }
        lines.push(`${I}${I}${inProp}=(${ref})`);
      }
    }

    lines.push(`${I}${I}MaterialExpressionEditorX=${Math.round(pos.x)}`);
    lines.push(`${I}${I}MaterialExpressionEditorY=${Math.round(pos.y)}`);
    lines.push(`${I}End Object`);
    lines.push(`${I}MaterialExpression=${objectRef(nodeMeta.ueClass, item.expressionName)}`);
    lines.push(`${I}NodePosX=${Math.round(pos.x)}`);
    lines.push(`${I}NodePosY=${Math.round(pos.y)}`);
    lines.push(`${I}NodeGuid=${guidFor(`node:${node.id}`)}`);

    for (const pinName of nodeInputPins(node, nodeMeta, derivedPins)) {
      lines.push(pinLine(node.id, pinName, 'input', pinLinks.get(pinKey(node.id, 'input', pinName)) ?? []));
    }
    for (const pinName of nodeOutputPins(node, nodeMeta, derivedPins)) {
      lines.push(pinLine(node.id, pinName, 'output', pinLinks.get(pinKey(node.id, 'output', pinName)) ?? []));
    }
    lines.push(`End Object`);
  }

  return { text: lines.join('\n'), warnings };
}

// Import is deferred - stub only, so the signature/wiring exists.
export function parseUET3D(_text: string): MatGraph {
  throw new Error('parseUET3D not implemented (import is not supported yet)');
}

import type { MatGraph, NodeJson, DerivedPins } from '../protocol';
import type { ExportMeta, NodeExportMeta, OutputMeta, ParamMeta } from './export-meta-types';
import { splitRef } from '../connstr';
import { MATERIAL_ATTRIBUTE_PINS } from '../material-attributes';
import { MATERIAL_ATTRIBUTE_GUIDS } from '../material-attribute-guids';

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

// Render a number as a plain (non-exponential) decimal string. UE's T3D parser
// rejects scientific notation (e.g. 1e-7, 1e+21), which String()/toFixed() can emit
// for very small or very large magnitudes. toLocaleString('fullwide') never uses an
// exponent; we then trim trailing fractional zeros, keeping at least one decimal.
function plainDecimal(n: number): string {
  let s = n.toLocaleString('fullwide', { useGrouping: false, maximumFractionDigits: 20 });
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '.0');
  else s = `${s}.0`;
  return s;
}

function fmtFloat(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '0.0';
  if (Number.isInteger(n)) {
    const fixed = n.toFixed(1);
    // toFixed reverts to exponential at |n| >= 1e21; use the plain-decimal path there.
    return /[eE]/.test(fixed) ? plainDecimal(n) : fixed;
  }
  const s = String(n);
  return /[eE]/.test(s) ? plainDecimal(n) : s;
}

function quote(value: unknown): string {
  return `"${String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n')}"`;
}

// Build a UE texture object reference: "<scriptClass>'<assetPath>'". A path that is
// already a fully-formed object ref (it contains a quote, i.e. carries its own class)
// is passed through verbatim so non-Texture2D classes (TextureCube, etc.) survive. A
// bare asset path is wrapped with the given engine class (default Texture2D). Adding a
// new default class is a one-arg change here, not new string-sniffing at the call site.
function textureObjectRef(path: string, ueClass = '/Script/Engine.Texture2D'): string {
  if (path.includes("'")) {
    // Already class-qualified. Tolerate the legacy "Texture2D'...'" shorthand (no
    // /Script/ prefix) by promoting it to the engine path; otherwise emit as-is.
    return path.startsWith("Texture2D'") ? `/Script/Engine.${path}` : path;
  }
  return `${ueClass}'${path}'`;
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
      if (!path) return 'None';
      return quote(textureObjectRef(path));
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

function functionInputIndex(node: NodeJson, nodeMeta: NodeExportMeta, pinName: string, derivedPins: Record<string, DerivedPins>, warnings?: string[]): number {
  // Metadata is authoritative: an explicit FunctionInputs(n) mapping wins.
  const mapped = nodeMeta.inputs[pinName]?.property ?? '';
  const match = /^FunctionInputs\((\d+)\)$/.exec(mapped);
  if (match) return Number(match[1]);
  // Fallback: positional index in the derived pins. Fragile if ordering desyncs, so a
  // pin we can't locate keeps the safe default (0) but is surfaced as a warning instead
  // of silently mis-wiring to the first function input.
  const i = (derivedPins[node.id]?.inputs ?? []).findIndex(p => p.name === pinName);
  if (i < 0) {
    warnings?.push(`MaterialFunctionCall "${node.id}": input pin "${pinName}" not found in metadata or derived pins - defaulting to FunctionInputs(0); verify the wire.`);
    return 0;
  }
  return i;
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
  return quote(`${classPath}'${objectName}'`);
}

function expressionExportPath(item: EmittedExpression): string {
  return `${item.meta.ueClass}'${GRAPH_ROOT}.${item.graphNodeName}.${item.expressionName}'`;
}

function commentExportPath(comment: EmittedComment): string {
  return `/Script/Engine.MaterialExpressionComment'${GRAPH_ROOT}.${comment.graphNodeName}.${comment.expressionName}'`;
}

function pinId(nodeId: string, pinName: string, direction: 'input' | 'output'): string {
  return guidFor(`pin:${nodeId}:${direction}:${pinName}`);
}

function nodeOutputPins(node: NodeJson, meta: NodeExportMeta, derivedPins: Record<string, DerivedPins>): string[] {
  if (node.type === 'Custom') {
    const extra = ((node.params?.AdditionalOutputs ?? []) as { OutputName: string }[]).map(o => o.OutputName);
    return ['Output', ...extra];
  }
  if (node.type === 'MaterialFunctionCall') {
    return (derivedPins[node.id]?.outputs ?? []).map(pin => pin.name);
  }
  if (node.type === 'MakeMaterialAttributes') {
    return ['Output'];
  }
  return Object.entries(meta.outputs)
    .sort(([, a], [, b]) => a.index - b.index)
    .map(([name]) => name);
}

function nodeInputPins(node: NodeJson, meta: NodeExportMeta, derivedPins: Record<string, DerivedPins>): string[] {
  if (node.type === 'Custom') {
    return ((node.params?.Inputs ?? []) as { InputName: string }[]).map(i => i.InputName);
  }
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
  displayName: string = pinName,
): string {
  // PinId is keyed on the graph (internal) pin name so LinkedTo stays self-consistent;
  // PinName carries the UE display name, which can differ for dynamic-pin nodes
  // (e.g. graph "BaseColor" -> UE "Base Color", graph "Result" -> UE "Output").
  const parts = [
    `PinId=${pinId(nodeId, pinName, direction)}`,
    `PinName=${quote(displayName)}`,
    `Direction=${quote(direction === 'input' ? 'EGPD_Input' : 'EGPD_Output')}`,
  ];
  if (links.length > 0) {
    parts.push(`LinkedTo=(${links.map(link => `${link.graphNodeName} ${link.pinId}`).join(',')},)`);
  }
  return `${I}CustomProperties Pin (${parts.join(',')},)`;
}

// The 15 attribute pins of a MaterialOutput root node are identical to the inputs of
// MakeMaterialAttributes, which is what lets us collect them losslessly. The canonical
// list lives in ../material-attributes (shared with the editor's MaterialOutputNode).

// UE's root material node cannot be copied to the clipboard, so any wires the author drew into a
// MaterialOutput's attribute pins would be lost on paste. To preserve them we synthesize one
// MakeMaterialAttributes expression per MaterialOutput, reroute those attribute wires into it, and
// leave its single Output pin for the user to connect to the root Material Attributes input
// (enable "Use Material Attributes"). This turns N broken manual reconnections into exactly one.
function collectMaterialOutputs(
  graph: MatGraph,
  layout: Record<string, { x: number; y: number }>,
): { nodes: NodeJson[]; connections: MatGraph['connections']; layout: Record<string, { x: number; y: number }>; warnings: string[] } {
  const outputs = graph.nodes.filter(n => n.type === 'MaterialOutput');
  if (outputs.length === 0) {
    return { nodes: graph.nodes, connections: graph.connections, layout, warnings: [] };
  }
  const warnings: string[] = [];
  const extraNodes: NodeJson[] = [];
  const extraLayout: Record<string, { x: number; y: number }> = {};
  const collectorFor = new Map<string, string>(); // MaterialOutput id -> collector id
  const seenPin = new Set<string>();               // `${collectorId}:${attr}` already wired
  const countFor = new Map<string, number>();      // collectorId -> wires collected

  for (const out of outputs) {
    const id = `${out.id}__MakeAttributes`;
    collectorFor.set(out.id, id);
    const pos = layout[out.id] ?? { x: 0, y: 0 };
    extraLayout[id] = { x: pos.x - 250, y: pos.y };
    extraNodes.push({ id, type: 'MakeMaterialAttributes', params: {} });
  }

  const connections: MatGraph['connections'] = [];
  for (const connection of graph.connections) {
    const [dstId, dstPin] = splitRef(connection.to);
    const collectorId = collectorFor.get(dstId);
    if (!collectorId || !MATERIAL_ATTRIBUTE_PINS.includes(dstPin)) {
      connections.push(connection);
      continue;
    }
    const key = `${collectorId}:${dstPin}`;
    if (seenPin.has(key)) {
      warnings.push(`MaterialOutput "${dstId}" pin "${dstPin}" wired more than once - duplicate dropped (UE allows one wire per input).`);
      continue;
    }
    seenPin.add(key);
    countFor.set(collectorId, (countFor.get(collectorId) ?? 0) + 1);
    connections.push({ ...connection, to: `${collectorId}:${dstPin}` });
  }

  for (const [outId, collectorId] of collectorFor) {
    const count = countFor.get(collectorId) ?? 0;
    if (count > 0) {
      warnings.push(`MaterialOutput "${outId}": auto-collected ${count} attribute(s) into MakeMaterialAttributes "${collectorId}". In UE, connect its Output pin to the material's Material Attributes root pin and enable "Use Material Attributes".`);
    }
  }

  return {
    nodes: [...graph.nodes, ...extraNodes],
    connections,
    layout: { ...layout, ...extraLayout },
    warnings,
  };
}

// Material Attributes family nodes (MakeMaterialAttributes, and prospectively
// SetMaterialAttributes) rebuild their input connections from the expression-level
// FExpressionInput on paste, NOT from the graph-pin LinkedTo that ordinary nodes use.
// A bare expression name fails to resolve in that code path (the Expression pointer
// ends up null and the wire drops), so these inputs need a fully-qualified object
// reference: "<ueClass>'<GraphNodeName>.<ExpressionName>'". Verified against
// tests/fixtures/ue-make-material-attributes.t3d (a genuine UE 5.7 clipboard sample).
function fqExpressionRef(src: EmittedExpression): string {
  return quote(`${src.meta.ueClass}'${src.graphNodeName}.${src.expressionName}'`);
}

// Channel-named outputs carry a component mask in the FExpressionInput; single
// outputs (Result, Value, Distance, …) do not. X/Y/Z/W alias the R/G/B/A slots.
// Verified against tests/fixtures/ue-make-material-attributes-sources.t3d:
// RGB -> ",Mask=1,MaskR=1,MaskG=1,MaskB=1"; R -> ",Mask=1,MaskR=1"; Result -> "".
const OUTPUT_CHANNELS: Record<string, string> = {
  R: 'R', G: 'G', B: 'B', A: 'A', RG: 'RG', RGB: 'RGB', RGBA: 'RGBA',
  X: 'R', Y: 'G', Z: 'B', W: 'A', XY: 'RG', XYZ: 'RGB', XYZW: 'RGBA',
};

// The channel suffix UE writes after an Expression ref for a MaterialAttributes-family
// input: only the channels that are on, zeros omitted (real UE clipboard format).
function componentMaskFor(outputPin: string): string {
  const channels = OUTPUT_CHANNELS[outputPin];
  if (!channels) return '';
  const parts = ['Mask=1'];
  for (const c of ['R', 'G', 'B', 'A']) if (channels.includes(c)) parts.push(`Mask${c}=1`);
  return `,${parts.join(',')}`;
}

// Dynamic-pin nodes: their graph pins and expression body are derived per-instance
// (from params + wires) rather than from static metadata. The exact T3D shape of each
// was reverse-engineered from real UE 5.7 clipboard fixtures:
//   ue-set-material-attributes.t3d / ue-get-material-attributes.t3d / ue-landscape-layer-blend.t3d
const DYNAMIC_SUPPORTED = new Set(['SetMaterialAttributes', 'GetMaterialAttributes', 'LandscapeLayerBlend']);

interface DynPin { name: string; display: string; }              // name = graph pin (PinId/link key); display = UE PinName
interface SetGetAttr { pin: string; display: string; guid: string; }
interface DynLayer { name: string; layerPin: string; heightPin: string; blendType: string; heightBlend: boolean; }
interface DynamicNodeInfo {
  kind: 'set' | 'get' | 'layerblend';
  inputs: DynPin[];
  outputs: DynPin[];
  outputIndexByPin: Map<string, number>;
  attrs: SetGetAttr[];   // set/get only
  layers: DynLayer[];    // layerblend only
}

// Resolve a Set/Get node's AttributeNames to {pin, display, guid}. An attribute with no
// captured GUID is dropped here with a warning (never invented) — see material-attribute-guids.
function resolveAttributes(node: NodeJson, warnings: string[]): SetGetAttr[] {
  const raw = node.params?.AttributeNames;
  const names = Array.isArray(raw) ? raw : [];
  const attrs: SetGetAttr[] = [];
  for (const item of names) {
    const name = String(item);
    const def = MATERIAL_ATTRIBUTE_GUIDS[name];
    if (!def) {
      warnings.push(`${node.type} "${node.id}": attribute "${name}" has no captured GUID - dropped (capture a UE sample that sets/gets it to enable).`);
      continue;
    }
    attrs.push({ pin: name, display: def.display, guid: def.guid });
  }
  return attrs;
}

function buildDynamicInfo(node: NodeJson, warnings: string[]): DynamicNodeInfo | undefined {
  if (node.type === 'SetMaterialAttributes') {
    const attrs = resolveAttributes(node, warnings);
    return {
      kind: 'set', attrs, layers: [],
      // Inputs(0) is the base MaterialAttributes; Inputs(1..N) are the set attributes.
      inputs: [{ name: 'MaterialAttributes', display: 'MaterialAttributes' }, ...attrs.map(a => ({ name: a.pin, display: a.display }))],
      outputs: [{ name: 'MaterialAttributes', display: 'Output' }],
      outputIndexByPin: new Map([['MaterialAttributes', 0]]),
    };
  }
  if (node.type === 'GetMaterialAttributes') {
    const attrs = resolveAttributes(node, warnings);
    // Output 0 is the MaterialAttributes pass-through; attributes are Outputs(1..N).
    const outputs: DynPin[] = [{ name: 'MaterialAttributes', display: 'MaterialAttributes' }, ...attrs.map(a => ({ name: a.pin, display: a.display }))];
    const outputIndexByPin = new Map<string, number>();
    outputs.forEach((p, i) => outputIndexByPin.set(p.name, i));
    return {
      kind: 'get', attrs, layers: [],
      inputs: [{ name: 'MaterialAttributes', display: 'Input' }],
      outputs, outputIndexByPin,
    };
  }
  if (node.type === 'LandscapeLayerBlend') {
    const raw = node.params?.Layers;
    const list = Array.isArray(raw) ? raw : [];
    const layers: DynLayer[] = list.map(entry => {
      const obj = (entry && typeof entry === 'object') ? entry as Record<string, unknown> : {};
      const name = String(obj.Name ?? '');
      const blendType = String(obj.BlendType ?? 'LB_HeightBlend');
      return { name, blendType, heightBlend: blendType === 'LB_HeightBlend', layerPin: `Layer ${name}`, heightPin: `Height ${name}` };
    });
    const inputs: DynPin[] = [];
    for (const l of layers) {
      inputs.push({ name: l.layerPin, display: l.layerPin });
      if (l.heightBlend) inputs.push({ name: l.heightPin, display: l.heightPin });
    }
    return {
      kind: 'layerblend', attrs: [], layers,
      inputs,
      outputs: [{ name: 'Result', display: 'Output' }],
      outputIndexByPin: new Map([['Result', 0]]),
    };
  }
  return undefined;
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
  const collected = collectMaterialOutputs(graph, layout);
  const nodes = collected.nodes;
  const connections = collected.connections;
  const effectiveLayout = collected.layout;
  warnings.push(...collected.warnings);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const emitted: EmittedExpression[] = [];
  const byNodeId = new Map<string, EmittedExpression>();
  let counter = 0;

  for (const node of nodes) {
    if (node.type === 'MaterialOutput') {
      continue; // attribute wires are auto-collected into MakeMaterialAttributes; see collectMaterialOutputs
    }
    const nodeMeta = metaFor(meta, node.type);
    if (!nodeMeta || (nodeMeta.dynamicExport && !DYNAMIC_SUPPORTED.has(node.type))) {
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

  // Named Reroute: a Usage links to its Declaration by a shared GUID, not a wire.
  // Map each Declaration's visible Name to its emitted expression so a Usage
  // (carrying params.rerouteName == that Name) can emit Declaration=/DeclarationGuid=.
  const declByName = new Map<string, EmittedExpression>();
  for (const item of emitted) {
    if (item.node.type === 'NamedRerouteDeclaration') {
      declByName.set(String(item.node.params?.Name ?? 'Name'), item);
    }
  }

  // Dynamic-pin nodes (Set/Get/LandscapeLayerBlend): resolve their virtual pins,
  // output indices and per-attribute GUIDs once, up front. Unknown attributes are
  // warned + dropped inside buildDynamicInfo.
  const dynamicInfo = new Map<string, DynamicNodeInfo>();
  const dynamicInputNames = new Map<string, Set<string>>();
  for (const item of emitted) {
    const info = buildDynamicInfo(item.node, warnings);
    if (info) {
      dynamicInfo.set(item.node.id, info);
      dynamicInputNames.set(item.node.id, new Set(info.inputs.map(p => p.name)));
    }
  }

  const comments: EmittedComment[] = (graph.comments ?? []).map((comment, i) => ({
    ...comment,
    graphNodeName: `MaterialGraphNode_Comment_${i}`,
    expressionName: `MaterialExpressionComment_${i}`,
  }));

  const srcRef = (srcId: string, srcPin: string): { index: number; mask?: string } => {
    const node = byId.get(srcId);
    if (node?.type === 'Custom') {
      const outs = ['Output', ...((node.params?.AdditionalOutputs ?? []) as { OutputName: string }[]).map(o => o.OutputName)];
      const idx = outs.indexOf(srcPin);
      return { index: idx < 0 ? 0 : idx };
    }
    if (node?.type === 'MaterialFunctionCall') {
      const idx = (derivedPins[srcId]?.outputs ?? []).findIndex(o => o.name === srcPin);
      return { index: idx < 0 ? 0 : idx };
    }
    const dyn = dynamicInfo.get(srcId);
    if (dyn) {
      return { index: dyn.outputIndexByPin.get(srcPin) ?? 0 };
    }
    const o = node ? metaFor(meta, node.type)?.outputs?.[srcPin] : undefined;
    return { index: o?.index ?? 0, mask: o?.mask };
  };

  const incoming = new Map<string, { srcId: string; srcPin: string; dstPin: string }[]>();
  const pinLinks = new Map<string, PinLink[]>();
  for (const connection of connections) {
    const [srcId, srcPin] = splitRef(connection.from);
    const [dstId, dstPin] = splitRef(connection.to);
    const src = byNodeId.get(srcId);
    const dst = byNodeId.get(dstId);
    if (!dst) continue;
    if (!src) {
      // The destination is exported but its source was skipped (a dynamicExport
      // node, etc.). Don't drop the wire silently — surface it.
      warnings.push(`Node "${dstId}" input "${dstPin}" dropped: source "${srcId}" (${byId.get(srcId)?.type ?? 'unknown'}) was not exported.`);
      continue;
    }
    const dynIn = dynamicInputNames.get(dstId);
    if (dynIn && !dynIn.has(dstPin)) {
      // A wire into a dynamic-pin node whose pin doesn't exist (unknown attribute that
      // was already dropped+warned in buildDynamicInfo, or a stale layer pin). Skip it
      // so no dangling LinkedTo is emitted on the source's output.
      continue;
    }

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
    const pts = comment.contains.map(id => effectiveLayout[id]).filter(Boolean) as { x: number; y: number }[];
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
    lines.push(`${I}Begin Object Class=/Script/Engine.MaterialExpressionComment Name="${comment.expressionName}" ExportPath="${commentExportPath(comment)}"`);
    lines.push(`${I}End Object`);
    lines.push(`${I}Begin Object Name="${comment.expressionName}" ExportPath="${commentExportPath(comment)}"`);
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
    const pos = effectiveLayout[node.id] ?? { x: 0, y: 0 };
    const dyn = dynamicInfo.get(node.id);

    lines.push(`Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="${item.graphNodeName}" ExportPath="/Script/UnrealEd.MaterialGraphNode'${GRAPH_ROOT}.${item.graphNodeName}'"`);
    lines.push(`${I}Begin Object Class=${nodeMeta.ueClass} Name="${item.expressionName}" ExportPath="${expressionExportPath(item)}"`);
    lines.push(`${I}End Object`);
    lines.push(`${I}Begin Object Name="${item.expressionName}" ExportPath="${expressionExportPath(item)}"`);

    // Dynamic-pin nodes carry virtual authoring params (AttributeNames / Layers) that are
    // NOT real UE properties — their expression body is emitted below instead.
    if (!dyn) {
      for (const [paramName, value] of Object.entries(node.params ?? {})) {
        const paramMeta = nodeMeta.params[paramName];
        if (!paramMeta) continue;
        const formatted = fmtParam(value, paramMeta, node);
        if (formatted === null) continue;
        lines.push(`${I}${I}${paramMeta.property}=${formatted}`);
      }
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

    if (node.type === 'Custom') {
      const inputs = (node.params?.Inputs ?? []) as { InputName: string }[];
      const incomingByPin = new Map((incoming.get(node.id) ?? []).map(c => [c.dstPin, c]));
      inputs.forEach((inp, i) => {
        const c = incomingByPin.get(inp.InputName);
        if (c) {
          const { index, mask } = srcRef(c.srcId, c.srcPin);
          const ref = `Expression=${byNodeId.get(c.srcId)!.expressionName},OutputIndex=${index}${maskBits(mask)}`;
          lines.push(`${I}${I}Inputs(${i})=(InputName=${quote(inp.InputName)},Input=(${ref}))`);
        } else {
          lines.push(`${I}${I}Inputs(${i})=(InputName=${quote(inp.InputName)})`);
        }
      });
      const addOuts = (node.params?.AdditionalOutputs ?? []) as { OutputName: string; OutputType?: string }[];
      addOuts.forEach((o, i) => {
        lines.push(`${I}${I}AdditionalOutputs(${i})=(OutputName=${quote(o.OutputName)},OutputType=${o.OutputType ?? 'CMOT_Float1'})`);
      });
    } else if (dyn) {
      const incomingByPin = new Map((incoming.get(node.id) ?? []).map(c => [c.dstPin, c]));
      // FExpressionInput body for a wire into pin `p`: fully-qualified Expression ref +
      // OutputIndex (omitted when 0) + the source output's component mask. '' if unwired.
      const exprInput = (p: string): string => {
        const c = incomingByPin.get(p);
        const s = c ? byNodeId.get(c.srcId) : undefined;
        if (!c || !s) return '';
        const { index } = srcRef(c.srcId, c.srcPin);
        const idxPart = index > 0 ? `,OutputIndex=${index}` : '';
        return `Expression=${fqExpressionRef(s)}${idxPart}${componentMaskFor(c.srcPin)}`;
      };
      if (dyn.kind === 'set') {
        // Inputs(0) = base MaterialAttributes; Inputs(1..N) each set one attribute (InputName
        // interleaved before the mask, per fixture) with a matching AttributeSetTypes GUID.
        lines.push(`${I}${I}Inputs(0)=(${exprInput('MaterialAttributes')})`);
        dyn.attrs.forEach((attr, k) => {
          const c = incomingByPin.get(attr.pin);
          const s = c ? byNodeId.get(c.srcId) : undefined;
          if (c && s) {
            const { index } = srcRef(c.srcId, c.srcPin);
            const idxPart = index > 0 ? `,OutputIndex=${index}` : '';
            lines.push(`${I}${I}Inputs(${k + 1})=(Expression=${fqExpressionRef(s)}${idxPart},InputName=${quote(attr.display)}${componentMaskFor(c.srcPin)})`);
          } else {
            lines.push(`${I}${I}Inputs(${k + 1})=(InputName=${quote(attr.display)})`);
          }
        });
        dyn.attrs.forEach((attr, k) => lines.push(`${I}${I}AttributeSetTypes(${k})=${attr.guid}`));
      } else if (dyn.kind === 'get') {
        const e = exprInput('MaterialAttributes');
        if (e) lines.push(`${I}${I}MaterialAttributes=(${e})`);
        dyn.attrs.forEach((attr, k) => lines.push(`${I}${I}AttributeGetTypes(${k})=${attr.guid}`));
        // Output 0 is the MaterialAttributes pass-through; named attributes are Outputs(1..N).
        dyn.attrs.forEach((attr, k) => lines.push(`${I}${I}Outputs(${k + 1})=(OutputName=${quote(attr.display)})`));
      } else {
        // LandscapeLayerBlend: one Layers(i) struct per layer; HeightInput only for height blend.
        dyn.layers.forEach((layer, i) => {
          const parts = [`LayerName=${quote(layer.name)}`, `BlendType=${layer.blendType}`];
          const li = exprInput(layer.layerPin);
          if (li) parts.push(`LayerInput=(${li})`);
          if (layer.heightBlend) {
            const hi = exprInput(layer.heightPin);
            if (hi) parts.push(`HeightInput=(${hi})`);
          }
          lines.push(`${I}${I}Layers(${i})=(${parts.join(',')})`);
        });
      }
    } else {
      const seenInputPins = new Set<string>();
      for (const connection of incoming.get(node.id) ?? []) {
        const src = byNodeId.get(connection.srcId);
        if (!src) continue;
        if (seenInputPins.has(connection.dstPin)) {
          warnings.push(`Node "${node.id}" input "${connection.dstPin}" wired more than once - keeping the first (UE allows one wire per input).`);
          continue;
        }
        seenInputPins.add(connection.dstPin);
        const { index, mask } = srcRef(connection.srcId, connection.srcPin);
        const ref = `Expression=${src.expressionName},OutputIndex=${index}${maskBits(mask)}`;
        if (nodeMeta.functionRefProperty) {
          lines.push(`${I}${I}FunctionInputs(${functionInputIndex(node, nodeMeta, connection.dstPin, derivedPins, warnings)})=(Input=(${ref}))`);
        } else {
          const inProp = nodeMeta.inputs[connection.dstPin]?.property;
          if (!inProp) {
            warnings.push(`Node "${node.id}" (${node.type}): input pin "${connection.dstPin}" has no UE mapping - connection skipped.`);
            continue;
          }
          if (node.type === 'MakeMaterialAttributes') {
            // Fully-qualified Expression ref (see fqExpressionRef), then OutputIndex
            // (only when >0, before the mask) and the source output's component mask.
            // Order/format verified against ue-make-material-attributes-sources.t3d.
            const idxPart = index > 0 ? `,OutputIndex=${index}` : '';
            const maskPart = componentMaskFor(connection.srcPin);
            lines.push(`${I}${I}${inProp}=(Expression=${fqExpressionRef(src)}${idxPart}${maskPart})`);
          } else if (dynamicInfo.has(connection.srcId)) {
            // Source is a dynamic-pin node (Get/Set/LayerBlend): its graph pins are rebuilt on
            // paste, so a bare ref + LinkedTo won't restore the wire. A fully-qualified
            // Expression ref does — verified against ue-get-material-attributes.t3d consumers.
            const idxPart = index > 0 ? `,OutputIndex=${index}` : '';
            lines.push(`${I}${I}${inProp}=(Expression=${fqExpressionRef(src)}${idxPart}${maskBits(mask)})`);
          } else {
            lines.push(`${I}${I}${inProp}=(${ref})`);
          }
        }
      }
    }

    if (node.type === 'NamedRerouteDeclaration') {
      // Stable per-name GUID so every Usage of this name resolves back here.
      lines.push(`${I}${I}VariableGuid=${guidFor('reroute:' + String(node.params?.Name ?? 'Name'))}`);
    } else if (node.type === 'NamedRerouteUsage') {
      const rrName = String(node.params?.rerouteName ?? '');
      const decl = rrName ? declByName.get(rrName) : undefined;
      if (decl) {
        lines.push(`${I}${I}Declaration=${fqExpressionRef(decl)}`);
        lines.push(`${I}${I}DeclarationGuid=${guidFor('reroute:' + rrName)}`);
      } else {
        warnings.push(`NamedRerouteUsage "${node.id}": params.rerouteName "${rrName}" matches no NamedRerouteDeclaration Name - orphaned on paste.`);
      }
    }
    lines.push(`${I}${I}MaterialExpressionEditorX=${Math.round(pos.x)}`);
    lines.push(`${I}${I}MaterialExpressionEditorY=${Math.round(pos.y)}`);
    lines.push(`${I}End Object`);
    lines.push(`${I}MaterialExpression=${objectRef(nodeMeta.ueClass, item.expressionName)}`);
    lines.push(`${I}NodePosX=${Math.round(pos.x)}`);
    lines.push(`${I}NodePosY=${Math.round(pos.y)}`);
    lines.push(`${I}NodeGuid=${guidFor(`node:${node.id}`)}`);

    if (dyn) {
      for (const p of dyn.inputs) {
        lines.push(pinLine(node.id, p.name, 'input', pinLinks.get(pinKey(node.id, 'input', p.name)) ?? [], p.display));
      }
      for (const p of dyn.outputs) {
        lines.push(pinLine(node.id, p.name, 'output', pinLinks.get(pinKey(node.id, 'output', p.name)) ?? [], p.display));
      }
    } else {
      for (const pinName of nodeInputPins(node, nodeMeta, derivedPins)) {
        lines.push(pinLine(node.id, pinName, 'input', pinLinks.get(pinKey(node.id, 'input', pinName)) ?? []));
      }
      for (const pinName of nodeOutputPins(node, nodeMeta, derivedPins)) {
        lines.push(pinLine(node.id, pinName, 'output', pinLinks.get(pinKey(node.id, 'output', pinName)) ?? []));
      }
    }
    lines.push(`End Object`);
  }

  return { text: lines.join('\n'), warnings };
}

// Import is deferred - stub only, so the signature/wiring exists.
export function parseUET3D(_text: string): MatGraph {
  throw new Error('parseUET3D not implemented (import is not supported yet)');
}

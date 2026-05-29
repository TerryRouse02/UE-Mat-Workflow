import type { MatGraph, NodeJson, DerivedPins } from '../protocol';
import type { ExportMeta, NodeExportMeta, OutputMeta, ParamMeta } from './export-meta-types';

export interface UEExportOptions { mfContentRoot?: string; }
export interface UEExportResult { text: string; warnings: string[]; }

const I = '   '; // 3-space indent, mirroring UE

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

function fmtParam(value: unknown, p: ParamMeta, node: NodeJson): string | null {
  switch (p.kind) {
    case 'float': return fmtFloat(value);
    case 'int': return String(Math.trunc(Number(value)));
    case 'bool': return value ? 'True' : 'False';
    case 'name':
    case 'string': return `"${String(value)}"`;
    case 'enum': return p.valueMap?.[String(value)] ?? String(value);
    case 'texture': return 'None';
    case 'vector2': case 'vector3': case 'vector4': {
      if (!p.components) return null;
      const parts = Object.entries(p.components)
        .map(([ueKey, ourParam]) => `${ueKey}=${fmtFloat(node.params?.[ourParam])}`);
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
  if (mfRef.startsWith('/')) return mfRef;            // engine / explicit asset path
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

  // Decide which nodes are emitted, and assign UE names.
  const emitted: NodeJson[] = [];
  const ueName = new Map<string, string>();
  let counter = 0;
  for (const n of graph.nodes) {
    if (n.type === 'MaterialOutput') {
      warnings.push(`MaterialOutput "${n.id}" skipped — connect final pins manually in UE.`);
      continue;
    }
    const m = metaFor(meta, n.type);
    if (!m || m.dynamicExport) {
      warnings.push(`Node "${n.id}" (type ${n.type}) not exportable yet — skipped.`);
      continue;
    }
    emitted.push(n);
    ueName.set(n.id, `${ueClassName(m.ueClass)}_${counter++}`);
  }
  const isEmitted = (id: string) => ueName.has(id);

  // Source output index/mask for a connection endpoint.
  const srcRef = (srcId: string, srcPin: string): { index: number; mask?: string } => {
    const node = byId.get(srcId);
    if (node?.type === 'MaterialFunctionCall') {
      const idx = (derivedPins[srcId]?.outputs ?? []).findIndex(o => o.name === srcPin);
      return { index: idx < 0 ? 0 : idx };
    }
    const o = node ? metaFor(meta, node.type)?.outputs?.[srcPin] : undefined;
    return { index: o?.index ?? 0, mask: o?.mask };
  };

  // Incoming connections per emitted node.
  const incoming = new Map<string, { srcId: string; srcPin: string; dstPin: string }[]>();
  for (const c of graph.connections) {
    const [srcId, srcPin] = c.from.split(':');
    const [dstId, dstPin] = c.to.split(':');
    if (!isEmitted(srcId) || !isEmitted(dstId)) continue;
    (incoming.get(dstId) ?? incoming.set(dstId, []).get(dstId)!).push({ srcId, srcPin, dstPin });
  }

  const lines: string[] = [];

  // Comment objects (declare + fill) first so they sit behind in UE.
  const comments = graph.comments ?? [];
  const commentName = new Map<string, string>();
  comments.forEach((cm, i) => commentName.set(cm.id, `MaterialExpressionComment_${i}`));

  // ---- PASS 1: declare every object ----
  for (const cm of comments) {
    lines.push(`Begin Object Class=/Script/Engine.MaterialExpressionComment Name="${commentName.get(cm.id)}"`);
    lines.push(`End Object`);
  }
  for (const n of emitted) {
    const m = metaFor(meta, n.type)!;
    lines.push(`Begin Object Class=${m.ueClass} Name="${ueName.get(n.id)}"`);
    lines.push(`End Object`);
  }

  // ---- PASS 2: fill properties ----
  for (const cm of comments) {
    const pts = cm.contains.map(id => layout[id]).filter(Boolean) as { x: number; y: number }[];
    let x = 0, y = 0, w = 400, h = 200;
    if (pts.length > 0) {
      const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x));
      const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y));
      x = Math.round(minX - 40); y = Math.round(minY - 50);
      w = Math.round((maxX - minX) + 220 + 80); h = Math.round((maxY - minY) + 120 + 80);
    }
    lines.push(`Begin Object Name="${commentName.get(cm.id)}"`);
    lines.push(`${I}Text="${cm.text}"`);
    lines.push(`${I}CommentColor=${hexToRGBA(cm.color ?? '#888888')}`);
    lines.push(`${I}SizeX=${w}`);
    lines.push(`${I}SizeY=${h}`);
    lines.push(`${I}MaterialExpressionEditorX=${x}`);
    lines.push(`${I}MaterialExpressionEditorY=${y}`);
    lines.push(`End Object`);
  }

  for (const n of emitted) {
    const m = metaFor(meta, n.type)!;
    lines.push(`Begin Object Name="${ueName.get(n.id)}"`);

    // Params
    for (const [paramName, value] of Object.entries(n.params ?? {})) {
      const pm = m.params[paramName];
      if (!pm) continue;
      const formatted = fmtParam(value, pm, n);
      if (formatted === null) continue;
      lines.push(`${I}${pm.property}=${formatted}`);
    }

    // MaterialFunctionCall or built-in MF wrapper: function asset reference.
    if (m.functionRefProperty) {
      const mfRef = m.functionAsset ?? (n.params?.MaterialFunction as string | undefined) ?? '';
      if (mfRef) {
        const assetRef = mfPathToAssetRef(mfRef, mfRoot);
        lines.push(`${I}${m.functionRefProperty ?? 'MaterialFunction'}=MaterialFunction'"${assetRef}"'`);
        if (n.type === 'MaterialFunctionCall' && !mfRef.startsWith('/')) {
          warnings.push(`MaterialFunctionCall "${n.id}" → create Material Function "${assetRef}" in UE for auto-link.`);
        }
      }
    }

    // Incoming connections
    for (const c of incoming.get(n.id) ?? []) {
      const { index, mask } = srcRef(c.srcId, c.srcPin);
      const ref = `Expression=${ueName.get(c.srcId)},OutputIndex=${index}${maskBits(mask)}`;
      if (m.functionRefProperty) {
        lines.push(`${I}FunctionInputs(${functionInputIndex(n, m, c.dstPin, derivedPins)})=(Input=(${ref}))`);
      } else {
        const inProp = m.inputs[c.dstPin]?.property;
        if (!inProp) {
          warnings.push(`Node "${n.id}" (${n.type}): input pin "${c.dstPin}" has no UE mapping — connection skipped.`);
          continue;
        }
        lines.push(`${I}${inProp}=(${ref})`);
      }
    }

    // Position
    const pos = layout[n.id] ?? { x: 0, y: 0 };
    lines.push(`${I}MaterialExpressionEditorX=${Math.round(pos.x)}`);
    lines.push(`${I}MaterialExpressionEditorY=${Math.round(pos.y)}`);
    lines.push(`End Object`);
  }

  return { text: lines.join('\n'), warnings };
}

// Import is deferred — stub only, so the signature/wiring exists.
export function parseUET3D(_text: string): MatGraph {
  throw new Error('parseUET3D not implemented (import is not supported yet)');
}

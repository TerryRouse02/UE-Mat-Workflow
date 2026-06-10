// Node-free module: parseUET3D and the pure helpers it uses.
// No imports from React, ReactFlow, node:, or ../layout — safe to import from the server.
import type { MatGraph, NodeJson, ConnectionJson, CommentJson } from '../protocol';
import type { ExportMeta, NodeExportMeta, ParamMeta } from './export-meta-types';
import { MATERIAL_ATTRIBUTE_GUIDS } from '../material-attribute-guids.js';

export interface UEImportResult { graph: MatGraph; warnings: string[]; }

// UE sometimes labels the material root's opacity attribute pin "OpacityOverride" — a
// non-standard display name that is the standard Opacity attribute (it never co-occurs with
// a separate "Opacity" pin). Normalize known root-pin aliases to the canonical attribute name
// at import time so the stored graph (and the AI's reference data) uses the real pin name and
// round-trips through export instead of being dropped as an unknown attribute.
const ROOT_PIN_ALIASES: Record<string, string> = { OpacityOverride: 'Opacity' };

// ueClass -> our node type. Reserved entries win on a shared class so the family of built-in
// MaterialFunctionCall wrappers all import as the generic reserved MaterialFunctionCall.
function buildReverseTypeMap(meta: ExportMeta): Map<string, string> {
  const map = new Map<string, string>();
  const add = (type: string, nm: NodeExportMeta) => { if (nm.ueClass && !map.has(nm.ueClass)) map.set(nm.ueClass, type); };
  for (const [t, nm] of Object.entries(meta.reserved)) add(t, nm);
  for (const [t, nm] of Object.entries(meta.nodes)) add(t, nm);
  return map;
}

// FGuid (upper-case) -> attribute name (space-stripped, matching matgraph AttributeNames).
function buildReverseAttrTable(meta: ExportMeta): Map<string, string> {
  const map = new Map<string, string>();
  if (meta.materialAttributes && meta.materialAttributes.length > 0) {
    for (const a of meta.materialAttributes) map.set(a.guid.toUpperCase(), a.name.replace(/\s+/g, ''));
  } else {
    for (const [name, def] of Object.entries(MATERIAL_ATTRIBUTE_GUIDS)) map.set(def.guid.toUpperCase(), name);
  }
  return map;
}

// Look up node export metadata by type; reserved entries take precedence.
function metaFor(meta: ExportMeta, type: string): NodeExportMeta | undefined {
  return meta.nodes[type] ?? meta.reserved[type];
}

// Split a comma-separated list, respecting nested () and "" (UE structs nest arbitrarily;
// object refs like "Class'Path'" sit inside the double-quotes so single-quotes need no guard).
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '"' && s[i - 1] !== '\\') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map(x => x.trim()).filter(x => x.length > 0);
}

// Parse "(K1=V1,K2=V2)" (outer parens optional) into {key,value} pairs. Splits each part on
// its FIRST '=' so a value keeping its own '=' (a nested struct) survives intact.
function parseStructFields(raw: string): { key: string; value: string }[] {
  let s = raw.trim();
  if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1);
  return splitTopLevelCommas(s).map(part => {
    const eq = part.indexOf('=');
    return eq < 0 ? { key: part.trim(), value: '' } : { key: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
  });
}

// Strip surrounding "" and unescape the three sequences quote() emits (\n, \", \\).
function unquoteStr(v: string): string {
  let s = v.trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  return s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// Recover the source expression NAME from an Expression= value: bare
// "MaterialExpressionConstant_0", or a fully-qualified "/Script/...'GraphNode.Expr'".
function exprNameFromRef(raw: string): string | undefined {
  const q = /'([^']*)'/.exec(raw);
  const inner = (q ? q[1] : raw).replace(/"/g, '').trim();
  const seg = inner.includes('.') ? inner.slice(inner.lastIndexOf('.') + 1) : inner;
  return seg || undefined;
}

// Extract the engine asset path from a quoted texture object ref ("Class'Path'") or a bare path.
function assetPathFromRef(raw: string): string {
  const inner = /'([^']*)'/.exec(raw)?.[1];
  return (inner ?? unquoteStr(raw)).trim();
}

interface RawObject { className?: string; name?: string; bodyLines: string[]; }

function parseObjectHeader(line: string): { className?: string; name?: string } {
  return {
    className: /Class=([^\s]+)/.exec(line)?.[1],
    name: /Name="([^"]*)"/.exec(line)?.[1],
  };
}

// Read one Begin Object..End Object block at `start`; returns it plus the index past its End.
// Nested objects are counted by depth and retained in bodyLines.
function readObject(lines: string[], start: number): { obj: RawObject; next: number } {
  const { className, name } = parseObjectHeader(lines[start].trim());
  const body: string[] = [];
  let depth = 1;
  let i = start + 1;
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('Begin Object')) depth++;
    if (t === 'End Object') {
      depth--;
      if (depth === 0) { i++; break; }
    }
    body.push(lines[i]);
  }
  return { obj: { className, name, bodyLines: body }, next: i };
}

// Partition a body into nested objects and depth-0 scalar lines (trimmed).
function splitBody(bodyLines: string[]): { nested: RawObject[]; scalars: string[] } {
  const nested: RawObject[] = [];
  const scalars: string[] = [];
  let i = 0;
  while (i < bodyLines.length) {
    const t = bodyLines[i].trim();
    if (t.startsWith('Begin Object')) {
      const { obj, next } = readObject(bodyLines, i);
      nested.push(obj);
      i = next;
    } else {
      if (t.length) scalars.push(t);
      i++;
    }
  }
  return { nested, scalars };
}

// A scalar line "Key=Value" -> [key, value]. Returns null for non-property lines.
function scalarKV(line: string): [string, string] | null {
  if (line.startsWith('CustomProperties') || line.startsWith('Begin ') || line.startsWith('End ')) return null;
  const eq = line.indexOf('=');
  return eq < 0 ? null : [line.slice(0, eq).trim(), line.slice(eq + 1).trim()];
}

// Reverse one scalar param value by its declared kind (inverse of fmtParam).
function reverseParamValue(raw: string, p: ParamMeta): unknown {
  switch (p.kind) {
    case 'float': return Number(raw);
    case 'int': return parseInt(raw, 10);
    case 'bool': return /^true$/i.test(raw.trim());
    case 'name':
    case 'string': return unquoteStr(raw);
    case 'enum': {
      if (p.valueMap) for (const [ours, ue] of Object.entries(p.valueMap)) if (ue === raw.trim()) return ours;
      return raw.trim();
    }
    case 'texture': {
      const v = raw.trim().replace(/^"|"$/g, '');
      return /^none$/i.test(v) ? undefined : assetPathFromRef(raw);
    }
    case 'vector2':
    case 'vector3':
    case 'vector4': {
      const keys = p.kind === 'vector2' ? ['R', 'G'] : p.kind === 'vector3' ? ['R', 'G', 'B'] : ['R', 'G', 'B', 'A'];
      const m = new Map(parseStructFields(raw).map(f => [f.key, f.value]));
      return keys.map(k => Number(m.get(k) ?? '0'));
    }
    default: return raw.trim();
  }
}

// Strip UE's trailing pin type-tag (" (V2)", " (S)", " (MA)") from a MaterialFunctionCall
// graph pin name so it matches the plain function-input name in the MF index. Used only as a
// fallback when the FunctionInputs struct carries no InputName. Conservative: removes a single
// trailing " (token)" of 1-3 alphanumerics, leaving real parenthetical names like
// "Rotation Angle (0-1)" otherwise intact.
function stripPinTypeSuffix(name: string | undefined): string | undefined {
  if (name == null) return undefined;
  return name.replace(/\s+\([A-Za-z0-9]{1,3}\)$/, '');
}

// The source pin ids referenced by a `CustomProperties Pin (... LinkedTo=(Node Pid,Node2 Pid2,))`
// line — i.e. the second whitespace-separated token of each comma-separated link entry.
function parseLinkedToPinIds(line: string): string[] {
  const m = /LinkedTo=\(([^)]*)\)/.exec(line);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean)
    .map(entry => entry.split(/\s+/)[1]).filter(Boolean);
}

// One parsed FExpressionInput: source expression name, its output index, optional InputName label.
function parseInputStruct(raw: string): { expr?: string; outputIndex: number; inputName?: string } {
  let exprRaw: string | undefined;
  let outputIndex = 0;
  let inputName: string | undefined;
  let nested: string | undefined;
  for (const f of parseStructFields(raw)) {
    if (f.key === 'Expression') exprRaw = f.value;
    else if (f.key === 'OutputIndex') outputIndex = parseInt(f.value, 10) || 0;
    else if (f.key === 'InputName') inputName = unquoteStr(f.value);
    else if (f.key === 'Input') nested = f.value;
  }
  if (!exprRaw && nested) {
    const inner = parseInputStruct(nested);
    // FunctionInputs wrap the wire in a nested Input=(...) that itself carries the
    // InputName (e.g. (ExpressionInputId=..,Input=(Expression=..,InputName="UVs"))).
    // Prefer an outer InputName when present, else take the nested one.
    return { expr: inner.expr, outputIndex: inner.outputIndex, inputName: inputName ?? inner.inputName };
  }
  return { expr: exprRaw ? exprNameFromRef(exprRaw) : undefined, outputIndex, inputName };
}

interface ImportNode {
  id: string;
  type: string;
  nodeMeta?: NodeExportMeta;
  params: Record<string, unknown>;
  fill: Map<string, string>;
  inputPinOrder: string[];     // input PinNames in file order (for MFC FunctionInputs(n) labels)
  customOutputs?: string[];    // Custom: ['Output', ...AdditionalOutputs]
  getOutputs?: string[];       // GetMaterialAttributes: ['MaterialAttributes', ...attrs]
  pos: { x: number; y: number };
}

// Resolve a source node's output PinName for a given OutputIndex (inverse of srcRef / nodeOutputPins).
function resolveSourcePin(src: ImportNode, index: number, warnings: string[]): string {
  if (src.type === 'Custom') return src.customOutputs?.[index] ?? 'Output';
  if (src.type === 'SetMaterialAttributes') return 'MaterialAttributes';
  if (src.type === 'GetMaterialAttributes') return src.getOutputs?.[index] ?? 'MaterialAttributes';
  if (src.type === 'LandscapeLayerBlend') return 'Result';
  if (src.type === 'MaterialFunctionCall') {
    if (index === 0) return 'Result';
    warnings.push(`MaterialFunctionCall "${src.id}" output index ${index}: pin name unknown without the MF definition - used "Out${index}".`);
    return `Out${index}`;
  }
  const outs = src.nodeMeta?.outputs;
  if (outs) {
    for (const [name, o] of Object.entries(outs)) if (o.index === index) return name;
    const first = Object.keys(outs)[0];
    if (first) return first;
  }
  return 'Result';
}

function rgbaToHex(raw: string): string {
  const m = new Map(parseStructFields(raw).map(f => [f.key, Number(f.value)]));
  const to = (v: number) => Math.max(0, Math.min(255, Math.round((v || 0) * 255))).toString(16).padStart(2, '0');
  return `#${to(m.get('R') ?? 0)}${to(m.get('G') ?? 0)}${to(m.get('B') ?? 0)}`;
}

export function parseUET3D(text: string, meta: ExportMeta, opts: { name?: string } = {}): UEImportResult {
  const warnings: string[] = [];
  const typeOf = buildReverseTypeMap(meta);
  const attrByGuid = buildReverseAttrTable(meta);

  const lines = text.split(/\r?\n/);
  const tops: RawObject[] = [];
  for (let i = 0; i < lines.length;) {
    if (lines[i].trim().startsWith('Begin Object')) {
      const { obj, next } = readObject(lines, i);
      tops.push(obj);
      i = next;
    } else i++;
  }

  const importNodes: ImportNode[] = [];
  const byExpr = new Map<string, ImportNode>();
  const declGuidToName = new Map<string, string>();   // NamedReroute VariableGuid -> declaration Name
  // Reroute (Knot) passthroughs: exprName -> its own upstream source. A reroute
  // node carries no value; wires that source from it are re-pointed at this
  // upstream (transitively) so the wire survives instead of dangling. Collapsed,
  // not re-emitted — they are pure visual wire-routing in UE.
  const rerouteSource = new Map<string, { expr?: string; outputIndex: number }>();
  const comments: { x: number; y: number; w: number; h: number; text: string; color: string }[] = [];
  const usedIds = new Set<string>();
  // Material output "收口": the root node (MaterialGraphNode_Root) is not a UMaterialExpression,
  // so its wires live on the pins as LinkedTo=(GraphNode <SourcePinId>) rather than as
  // expression-level inputs. We index every node's *output* pin id -> its source, then resolve
  // the root's wired input pins into a MaterialOutput node so the material's final connections
  // survive the round-trip instead of being silently dropped.
  const outPinIdToSource = new Map<string, { nodeId: string; outName: string }>();
  const rootInputs: { pinName: string; linkedPinIds: string[] }[] = [];

  // ---- Pass 1: parse nodes & params ----
  for (const top of tops) {
    if (top.className === '/Script/UnrealEd.MaterialGraphNode_Root') {
      for (const l of splitBody(top.bodyLines).scalars) {
        if (!l.startsWith('CustomProperties Pin')) continue;
        const linked = parseLinkedToPinIds(l);
        if (!linked.length) continue;                       // unwired root pin -> skip
        const pn = /PinName="([^"]*)"/.exec(l)?.[1];
        if (pn) rootInputs.push({ pinName: pn, linkedPinIds: linked });
      }
      continue;
    }
    if (top.className === '/Script/UnrealEd.MaterialGraphNode_Comment') {
      const sc = splitBody(top.bodyLines).scalars;
      const kv = new Map(sc.map(scalarKV).filter(Boolean) as [string, string][]);
      comments.push({
        x: Number(kv.get('NodePosX') ?? 0), y: Number(kv.get('NodePosY') ?? 0),
        w: Number(kv.get('NodeWidth') ?? 0), h: Number(kv.get('NodeHeight') ?? 0),
        text: unquoteStr(kv.get('NodeComment') ?? '""'),
        color: rgbaToHex(kv.get('CommentColor') ?? '(R=0.5,G=0.5,B=0.5,A=1.0)'),
      });
      continue;
    }
    // Reroute knot: a MaterialGraphNode_Knot wrapping a MaterialExpressionReroute.
    // Record where its single passthrough input comes from; wire() collapses it.
    if (top.className === '/Script/UnrealEd.MaterialGraphNode_Knot') {
      const knot = splitBody(top.bodyLines);
      const rdecl = knot.nested.find(n => n.className);
      const rfillObj = knot.nested.find(n => !n.className) ?? rdecl;
      const rerouteName = rdecl?.name ?? rfillObj?.name;
      if (rerouteName) {
        const rfill = new Map(splitBody(rfillObj?.bodyLines ?? []).scalars.map(scalarKV).filter(Boolean) as [string, string][]);
        const inputRaw = rfill.get('Input');
        const inp = inputRaw ? parseInputStruct(inputRaw) : { expr: undefined, outputIndex: 0 };
        rerouteSource.set(rerouteName, { expr: inp.expr, outputIndex: inp.outputIndex });
      }
      continue;
    }
    if (top.className !== '/Script/UnrealEd.MaterialGraphNode') continue;

    const { nested, scalars } = splitBody(top.bodyLines);
    const decl = nested.find(n => n.className);
    const fillObj = nested.find(n => !n.className) ?? decl;
    const ueClass = decl?.className ?? '';
    const exprName = decl?.name ?? fillObj?.name ?? `expr_${importNodes.length}`;
    const type = typeOf.get(ueClass);
    if (!type) { warnings.push(`Unknown UE class "${ueClass}" (${exprName}) - node skipped.`); continue; }

    const fill = new Map((splitBody(fillObj?.bodyLines ?? []).scalars.map(scalarKV).filter(Boolean) as [string, string][]));
    const topKV = new Map(scalars.map(scalarKV).filter(Boolean) as [string, string][]);
    const nodeMeta = metaFor(meta, type);

    let id = exprName.replace(/^MaterialExpression/, '') || type;
    while (usedIds.has(id)) id = `${id}_`;
    usedIds.add(id);

    const node: ImportNode = {
      id, type, nodeMeta, params: {}, fill,
      inputPinOrder: scalars
        .filter(l => l.startsWith('CustomProperties Pin') && !/Direction="EGPD_Output"/.test(l))
        .map(l => /PinName="([^"]*)"/.exec(l)?.[1] ?? ''),
      pos: { x: Number(topKV.get('NodePosX') ?? 0), y: Number(topKV.get('NodePosY') ?? 0) },
    };

    // Index this node's output pin ids so the root's LinkedTo can resolve back to a source.
    // The graph pin name UE writes for a single output is "Output"; map it to the node's real
    // DB output name (e.g. Transform's "Output" -> "Result"). Channel outputs (RGB, R, …) match.
    for (const l of scalars) {
      if (!l.startsWith('CustomProperties Pin') || !/Direction="EGPD_Output"/.test(l)) continue;
      const pid = /PinId=([0-9A-Fa-f]+)/.exec(l)?.[1];
      if (!pid) continue;
      const customName = /PinName="([^"]*)"/.exec(l)?.[1] ?? 'Output';
      const outs = nodeMeta?.outputs ? Object.keys(nodeMeta.outputs) : [];
      let outName = outs.includes(customName) ? customName : (outs[0] ?? customName);
      if (type === 'NamedRerouteDeclaration' && customName === 'Output') outName = 'Result';
      // Dynamic-pin nodes expose no static outputs; map UE's generic single-output name.
      if (!outs.length && customName === 'Output') {
        if (type === 'SetMaterialAttributes') outName = 'MaterialAttributes';
        else if (type === 'LandscapeLayerBlend') outName = 'Result';
      }
      outPinIdToSource.set(pid.toUpperCase(), { nodeId: id, outName });
    }

    // Scalar params (skip values that are FExpressionInput wires, handled in pass 2).
    if (nodeMeta) {
      for (const [pn, pm] of Object.entries(nodeMeta.params)) {
        const raw = fill.get(pm.property);
        if (raw == null || /Expression=/.test(raw)) continue;
        if (pm.components) {
          const m = new Map(parseStructFields(raw).map(f => [f.key, f.value]));
          for (const [ueKey, ourParam] of Object.entries(pm.components)) node.params[ourParam] = Number(m.get(ueKey) ?? '0');
        } else {
          const v = reverseParamValue(raw, pm);
          if (v !== undefined) node.params[pn] = v;
        }
      }
    }

    // Type-specific authoring params.
    if (type === 'LandscapeLayerBlend') {
      const layers: Record<string, unknown>[] = [];
      for (const [k, v] of fill) {
        if (!/^Layers\(\d+\)$/.test(k)) continue;
        const f = new Map(parseStructFields(v).map(x => [x.key, x.value]));
        const layer: Record<string, unknown> = {
          Name: unquoteStr(f.get('LayerName') ?? '""'),
          BlendType: (f.get('BlendType') ?? 'LB_HeightBlend').trim(),
        };
        if (f.has('PreviewWeight')) layer.PreviewWeight = Number(f.get('PreviewWeight'));
        if (f.has('ConstLayerInput')) {
          const c = new Map(parseStructFields(f.get('ConstLayerInput') ?? '').map(x => [x.key, x.value]));
          layer.ConstLayerInput = [Number(c.get('X') ?? 0), Number(c.get('Y') ?? 0), Number(c.get('Z') ?? 0)];
        }
        if (f.has('ConstHeightInput')) layer.ConstHeightInput = Number(f.get('ConstHeightInput'));
        layers.push(layer);
      }
      node.params.Layers = layers;
    } else if (type === 'SetMaterialAttributes' || type === 'GetMaterialAttributes') {
      const guidKey = type === 'SetMaterialAttributes' ? 'AttributeSetTypes' : 'AttributeGetTypes';
      const names: string[] = [];
      for (let k = 0; ; k++) {
        const g = fill.get(`${guidKey}(${k})`);
        if (g == null) break;
        names.push(attrByGuid.get(g.trim().toUpperCase()) ?? g.trim());
      }
      node.params.AttributeNames = names;
      if (type === 'GetMaterialAttributes') node.getOutputs = ['MaterialAttributes', ...names];
    } else if (type === 'Custom') {
      const inputs: { InputName: string }[] = [];
      for (let k = 0; ; k++) {
        const v = fill.get(`Inputs(${k})`);
        if (v == null) break;
        const nm = parseStructFields(v).find(f => f.key === 'InputName');
        inputs.push({ InputName: nm ? unquoteStr(nm.value) : `In${k}` });
      }
      const addOuts: { OutputName: string; OutputType?: string }[] = [];
      for (let k = 0; ; k++) {
        const v = fill.get(`AdditionalOutputs(${k})`);
        if (v == null) break;
        const f = new Map(parseStructFields(v).map(x => [x.key, x.value]));
        addOuts.push({ OutputName: unquoteStr(f.get('OutputName') ?? '""'), OutputType: (f.get('OutputType') ?? 'CMOT_Float1').trim() });
      }
      if (inputs.length) node.params.Inputs = inputs;
      if (addOuts.length) node.params.AdditionalOutputs = addOuts;
      node.customOutputs = ['Output', ...addOuts.map(o => o.OutputName)];
    } else if (type === 'NamedRerouteDeclaration') {
      const nm = unquoteStr(fill.get('Name') ?? '"Name"');
      node.params.Name = nm;
      const vg = fill.get('VariableGuid');
      if (vg) declGuidToName.set(vg.trim().toUpperCase(), nm);
    }

    importNodes.push(node);
    byExpr.set(exprName, node);
  }

  // Resolve NamedRerouteUsage -> declaration name now that all declarations are known.
  for (const node of importNodes) {
    if (node.type !== 'NamedRerouteUsage') continue;
    const dg = node.fill.get('DeclarationGuid');
    const nm = dg ? declGuidToName.get(dg.trim().toUpperCase()) : undefined;
    if (nm) node.params.rerouteName = nm;
    else warnings.push(`NamedRerouteUsage "${node.id}": no matching declaration - rerouteName unresolved.`);
  }

  // ---- Pass 2: rebuild connections ----
  const connections: ConnectionJson[] = [];
  const wire = (srcExpr: string | undefined, srcIndex: number, dstId: string, dstPin: string): void => {
    if (!srcExpr) return;
    // Follow reroute (Knot) passthroughs to the real upstream source. A reroute
    // has a single output, so its incoming index is discarded in favour of the
    // upstream's stored OutputIndex. The seen-set breaks any reroute cycle.
    let expr: string | undefined = srcExpr;
    let index = srcIndex;
    const seen = new Set<string>();
    while (expr && rerouteSource.has(expr)) {
      if (seen.has(expr)) { expr = undefined; break; }
      seen.add(expr);
      const up: { expr?: string; outputIndex: number } = rerouteSource.get(expr)!;
      expr = up.expr; index = up.outputIndex;
    }
    // A reroute with no (or cyclic) upstream resolves to nothing — drop silently
    // rather than warn, since the original graph had no value there either.
    if (!expr) return;
    const src = byExpr.get(expr);
    if (!src) { warnings.push(`Node "${dstId}" input "${dstPin}": source "${expr}" not found - wire dropped.`); return; }
    connections.push({ from: `${src.id}:${resolveSourcePin(src, index, warnings)}`, to: `${dstId}:${dstPin}` });
  };

  for (const node of importNodes) {
    const { type, nodeMeta, fill } = node;

    if (type === 'LandscapeLayerBlend') {
      for (const [k, v] of fill) {
        const m = /^Layers\((\d+)\)$/.exec(k);
        if (!m) continue;
        const f = new Map(parseStructFields(v).map(x => [x.key, x.value]));
        const name = unquoteStr(f.get('LayerName') ?? '""');
        if (f.has('LayerInput')) { const inp = parseInputStruct(f.get('LayerInput')!); wire(inp.expr, inp.outputIndex, node.id, `Layer ${name}`); }
        if (f.has('HeightInput')) { const inp = parseInputStruct(f.get('HeightInput')!); wire(inp.expr, inp.outputIndex, node.id, `Height ${name}`); }
      }
      continue;
    }

    if (type === 'SetMaterialAttributes') {
      const base = fill.get('Inputs(0)');
      if (base) { const inp = parseInputStruct(base); wire(inp.expr, inp.outputIndex, node.id, 'MaterialAttributes'); }
      const names = (node.params.AttributeNames as string[]) ?? [];
      for (let k = 0; k < names.length; k++) {
        const v = fill.get(`Inputs(${k + 1})`);
        if (!v) continue;
        const inp = parseInputStruct(v);
        wire(inp.expr, inp.outputIndex, node.id, inp.inputName ? inp.inputName.replace(/\s+/g, '') : names[k]);
      }
      continue;
    }

    if (type === 'GetMaterialAttributes') {
      const v = fill.get('MaterialAttributes');
      if (v) { const inp = parseInputStruct(v); wire(inp.expr, inp.outputIndex, node.id, 'MaterialAttributes'); }
      continue;
    }

    if (type === 'Custom') {
      const inputs = (node.params.Inputs as { InputName: string }[]) ?? [];
      for (let k = 0; k < inputs.length; k++) {
        const v = fill.get(`Inputs(${k})`);
        if (!v) continue;
        const inp = parseInputStruct(v);
        wire(inp.expr, inp.outputIndex, node.id, inputs[k].InputName);
      }
      continue;
    }

    if (nodeMeta?.functionRefProperty) {
      // MaterialFunctionCall / built-in wrapper: asset path + FunctionInputs(n) by pin order.
      const ref = fill.get(nodeMeta.functionRefProperty);
      // UE serializes an unassigned MaterialFunction as `None`; treat that (and empty) as
      // absent so the graph reports the clean "params.MaterialFunction missing" diagnosis
      // rather than storing a literal "None" asset path.
      if (ref && !/^none$/i.test(ref.trim()) && !nodeMeta.functionAsset) node.params.MaterialFunction = assetPathFromRef(ref);
      for (let n = 0; ; n++) {
        const v = fill.get(`FunctionInputs(${n})`);
        if (v == null) break;
        const inp = parseInputStruct(v);
        // Prefer the FunctionInputs InputName (the plain function-input name, e.g. "UVs"),
        // which matches the MF index / derivedPins. The CustomProperties pin name carries a
        // UE type-suffix ("UVs (V2)") that never matches the index, so falling back to it
        // would collapse every input to FunctionInputs(0) on re-export. Suffix-strip the pin
        // name as a last resort before the positional placeholder.
        const dstPin = inp.inputName ?? stripPinTypeSuffix(node.inputPinOrder[n]) ?? `In${n}`;
        wire(inp.expr, inp.outputIndex, node.id, dstPin);
      }
      continue;
    }

    // Ordinary nodes (incl. MakeMaterialAttributes, FunctionOutput): each input property that
    // carries an Expression maps via meta.inputs[property] -> graph pin name.
    if (nodeMeta) {
      const pinByProperty = new Map(Object.entries(nodeMeta.inputs).map(([pin, im]) => [im.property, pin]));
      for (const [k, v] of fill) {
        if (!/Expression=/.test(v)) continue;
        const pin = pinByProperty.get(k);
        if (!pin) {
          // A UE input property the metadata doesn't map (e.g. a wrong/missing `property`
          // in nodes-ue<ver>.export.json). Surface it instead of dropping the wire silently
          // — silent drops are how a single bad metadata entry quietly disconnects a node.
          warnings.push(`Node "${node.id}" (${type}): UE input property "${k}" has no pin mapping in metadata - wire dropped (check nodes-ue*.export.json inputs for ${type}).`);
          continue;
        }
        const inp = parseInputStruct(v);
        wire(inp.expr, inp.outputIndex, node.id, pin);
      }
    }
  }

  // ---- Material output (收口): resolve the root's wired pins into a MaterialOutput node ----
  // Pin display names carry spaces ("Base Color"); strip them to the canonical pin name
  // ("BaseColor"). "Material Attributes" -> "MaterialAttributes" is the Use-Material-Attributes
  // root pin. Only emitted when the root actually had a wire, so a function/partial paste is
  // unaffected.
  let outputNode: NodeJson | undefined;
  if (rootInputs.length) {
    let outId = 'OUT';
    while (usedIds.has(outId)) outId = `${outId}_`;
    usedIds.add(outId);
    let wired = 0;
    for (const r of rootInputs) {
      const canonical = r.pinName.replace(/\s+/g, '');
      const attr = ROOT_PIN_ALIASES[canonical] ?? canonical;
      for (const pid of r.linkedPinIds) {
        const src = outPinIdToSource.get(pid.toUpperCase());
        if (!src) {
          warnings.push(`MaterialOutput pin "${r.pinName}": source pin ${pid} not found - wire dropped.`);
          continue;
        }
        connections.push({ from: `${src.nodeId}:${src.outName}`, to: `${outId}:${attr}` });
        wired++;
      }
    }
    if (wired > 0) outputNode = { id: outId, type: 'MaterialOutput' };
  }

  // ---- Comments: recover `contains` geometrically from node positions ----
  const commentJson: CommentJson[] = comments.map((c, i) => ({
    id: `comment_${i}`,
    text: c.text,
    color: c.color,
    contains: importNodes
      .filter(n => n.pos.x >= c.x && n.pos.x <= c.x + c.w && n.pos.y >= c.y && n.pos.y <= c.y + c.h)
      .map(n => n.id),
  }));

  const graphType: MatGraph['type'] =
    importNodes.some(n => n.type === 'FunctionInput' || n.type === 'FunctionOutput') ? 'MaterialFunction' : 'Material';

  // The root node carries the material's final output connections, but a UE clipboard
  // copy only includes it when the whole material was selected. If we recovered nodes
  // but no output (and this isn't a function), the final wires simply weren't in the
  // paste — say so instead of silently dropping them.
  if (graphType === 'Material' && !outputNode && importNodes.length > 0) {
    warnings.push('No material output was in the pasted selection — the final output connections were not copied. In UE, Select All (Ctrl+A) before copying to include them.');
  }

  const graph: MatGraph = {
    schemaVersion: '1.0',
    ueVersion: meta.ueVersion,
    type: graphType,
    name: opts.name ?? 'imported',
    nodes: [
      ...importNodes.map(n => (Object.keys(n.params).length ? { id: n.id, type: n.type, params: n.params } : { id: n.id, type: n.type })),
      ...(outputNode ? [outputNode] : []),
    ],
    connections,
    ...(commentJson.length ? { comments: commentJson } : {}),
  };
  return { graph, warnings };
}

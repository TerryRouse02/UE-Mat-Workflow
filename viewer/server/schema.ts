import type { MatGraph } from './types.js';

export interface ValidationResult {
  errors: string[];
  graph: MatGraph | null;
}

const REQUIRED_TOP: (keyof MatGraph)[] = ['schemaVersion', 'ueVersion', 'type', 'name', 'nodes', 'connections'];

export function validateGraph(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) {
    return { errors: ['root must be an object'], graph: null };
  }
  const g = input as Record<string, unknown>;

  for (const k of REQUIRED_TOP) {
    if (!(k in g)) errors.push(`missing required field: ${k}`);
  }
  if (g.type !== 'Material' && g.type !== 'MaterialFunction') {
    errors.push(`type must be "Material" or "MaterialFunction"`);
  }
  // The key may be present but not an array (e.g. `"connections": null`). Reject it
  // here so a malformed-but-key-complete graph never reaches the client, where an
  // unguarded `graph.connections`/`graph.nodes` deref would throw.
  if ('nodes' in g && !Array.isArray(g.nodes)) errors.push('nodes must be an array');
  if ('connections' in g && !Array.isArray(g.connections)) errors.push('connections must be an array');

  const nodes = Array.isArray(g.nodes) ? (g.nodes as { id: unknown; type: unknown }[]) : [];
  const ids = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (typeof n !== 'object' || n === null) { errors.push(`nodes[${i}] must be an object`); continue; }
    if (typeof n.id !== 'string') { errors.push(`nodes[${i}].id must be string`); continue; }
    if (typeof n.type !== 'string') { errors.push(`nodes[${i}].type must be string`); continue; }
    if (n.id.includes(':')) errors.push(`nodes[${i}].id must not contain ':'`);
    if (ids.has(n.id)) errors.push(`duplicate node id: ${n.id}`);
    ids.add(n.id);
  }

  const conns = Array.isArray(g.connections) ? (g.connections as { from: unknown; to: unknown }[]) : [];
  for (let i = 0; i < conns.length; i++) {
    const c = conns[i];
    const checkEnd = (label: 'from' | 'to', v: unknown) => {
      if (typeof v !== 'string' || !v.includes(':')) {
        errors.push(`connections[${i}].${label} must be "nodeId:pinName"`);
        return null;
      }
      const ci = v.indexOf(':');
      const nodeId = v.slice(0, ci);
      // Both halves must be non-empty: "A:" (trailing colon) or ":Pin" would
      // otherwise reach disk and surface in UE as a dangling/empty pin.
      if (!nodeId || !v.slice(ci + 1).trim()) {
        errors.push(`connections[${i}].${label} must be "nodeId:pinName" (empty nodeId or pinName)`);
        return null;
      }
      if (!ids.has(nodeId)) errors.push(`connections[${i}].${label} references unknown node: ${nodeId}`);
      return nodeId;
    };
    void checkEnd('from', c.from);
    void checkEnd('to', c.to);
  }

  return { errors, graph: errors.length === 0 ? (input as MatGraph) : null };
}

// Structural convention surfaced as a WARNING (render + flag), not a hard error so
// the canvas is never blanked: a Material must funnel into exactly one MaterialOutput
// node (SPEC hard rule 6). The server runs this when it loads any graph, so both
// agent-authored and reverse-imported materials are held to the convention visibly.
export function materialStructureWarnings(graph: MatGraph): string[] {
  if (graph.type !== 'Material') return [];
  const warnings: string[] = [];
  const outs = graph.nodes.filter(n => n.type === 'MaterialOutput');
  if (outs.length === 0) warnings.push('A Material must have exactly one MaterialOutput node — found none.');
  else if (outs.length > 1) {
    warnings.push(`A Material must have exactly one MaterialOutput node — found ${outs.length} (${outs.map(n => n.id).join(', ')}).`);
  }
  warnings.push(...semanticLintWarnings(graph));
  warnings.push(...duplicateParameterWarnings(graph));
  warnings.push(...staticSwitchNoOpWarnings(graph));
  warnings.push(...danglingOperatorWarnings(graph));
  return warnings;
}

// ---------------------------------------------------------------------------
// Semantic lint — common UE material mistakes surfaced as warnings.
// Deliberately DB-free and limited to connections that land DIRECTLY on a
// MaterialOutput pin: precise, cheap, zero false positives from indirection.
// ---------------------------------------------------------------------------

const TEXTURE_SAMPLE_TYPES = new Set(['TextureSample', 'TextureSampleParameter2D']);
/** MaterialOutput pins that take a scalar — a full vector here is usually a mistake. */
const SCALAR_OUTPUT_PINS = new Set([
  'Metallic', 'Roughness', 'Specular', 'Opacity', 'OpacityMask', 'AmbientOcclusion', 'Anisotropy',
]);
const COLOR_OUTPUT_PINS = new Set(['BaseColor', 'EmissiveColor']);

function semanticLintWarnings(graph: MatGraph): string[] {
  const out: string[] = [];
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const outputIds = new Set(graph.nodes.filter(n => n.type === 'MaterialOutput').map(n => n.id));

  for (const c of graph.connections) {
    const ti = c.to.indexOf(':');
    const fi = c.from.indexOf(':');
    if (ti < 0 || fi < 0) continue; // malformed ends are validateGraph's job
    const toId = c.to.slice(0, ti);
    if (!outputIds.has(toId)) continue;
    const toPin = c.to.slice(ti + 1);
    const src = byId.get(c.from.slice(0, fi));
    if (!src) continue;
    const sampler = typeof src.params?.SamplerType === 'string' ? src.params.SamplerType : undefined;

    // Normal map sampled as color → broken lighting.
    if (toPin === 'Normal' && TEXTURE_SAMPLE_TYPES.has(src.type) && sampler !== 'Normal') {
      out.push(
        `"${src.id}" feeds the Normal output but its SamplerType is ${sampler ? `"${sampler}"` : 'unset (defaults to Color)'} — ` +
        'normal maps need SamplerType "Normal" or lighting will be wrong.',
      );
    }

    // Normal-decoded data used as a color.
    if (COLOR_OUTPUT_PINS.has(toPin) && TEXTURE_SAMPLE_TYPES.has(src.type) && sampler === 'Normal') {
      out.push(
        `"${src.id}" has SamplerType "Normal" but feeds the ${toPin} output — ` +
        'normal-decoded data is not a color; use SamplerType "Color".',
      );
    }

    // Vector constant into a scalar output pin.
    if (SCALAR_OUTPUT_PINS.has(toPin) && (src.type === 'Constant3Vector' || src.type === 'Constant4Vector')) {
      out.push(
        `"${src.id}" (${src.type}) feeds the scalar ${toPin} output — ` +
        `use a Constant, or a single channel like "${src.id}:R", instead of a vector.`,
      );
    }
  }
  return out;
}

// Two parameter nodes sharing a ParameterName bind to the SAME value in the
// Material Instance. Sometimes intentional (a shared "master" param), so this is
// a WARNING, not an error. DB-free: any node carrying a string ParameterName counts.
function duplicateParameterWarnings(graph: MatGraph): string[] {
  const byName = new Map<string, string[]>();
  for (const n of graph.nodes) {
    const name = n.params?.ParameterName;
    if (typeof name !== 'string' || !name.trim()) continue;
    const ids = byName.get(name);
    if (ids) ids.push(n.id); else byName.set(name, [n.id]);
  }
  const out: string[] = [];
  for (const [name, ids] of byName) {
    if (ids.length > 1) {
      out.push(
        `Parameter name "${name}" is used by ${ids.length} nodes (${ids.join(', ')}) — ` +
        `they bind to the same value in the Material Instance; rename one if that is not intended.`,
      );
    }
  }
  return out;
}

// A StaticSwitch whose A and B inputs come from the SAME source does nothing when
// toggled — a likely wiring mistake. Warns; never blocks. Only fires when BOTH
// pins are wired to the identical endpoint (unwired pins are a separate concern).
const STATIC_SWITCH_TYPES = new Set(['StaticSwitch', 'StaticSwitchParameter']);

function staticSwitchNoOpWarnings(graph: MatGraph): string[] {
  const switchIds = new Set(graph.nodes.filter(n => STATIC_SWITCH_TYPES.has(n.type)).map(n => n.id));
  if (switchIds.size === 0) return [];
  const aSrc = new Map<string, string>();
  const bSrc = new Map<string, string>();
  for (const c of graph.connections) {
    const ti = c.to.indexOf(':');
    if (ti < 0) continue;
    const id = c.to.slice(0, ti);
    if (!switchIds.has(id)) continue;
    const pin = c.to.slice(ti + 1);
    if (pin === 'A') aSrc.set(id, c.from);
    else if (pin === 'B') bSrc.set(id, c.from);
  }
  const out: string[] = [];
  for (const id of switchIds) {
    const a = aSrc.get(id);
    if (a !== undefined && a === bSrc.get(id)) {
      out.push(`StaticSwitch "${id}" has identical A and B inputs (both from ${a}) — toggling it has no effect.`);
    }
  }
  return out;
}

// A combine/transform operator that feeds downstream but has NONE of its inputs
// wired and no params set is almost always forgotten wiring — it can only emit a
// default constant. WARNING. Deliberately narrow (curated operator set + must feed
// something + no params) to dodge the false positives a general "unconnected input"
// check would hit: UE inputs routinely default on purpose (If compares to 0, Lerp
// has ConstAlpha, Multiply has ConstA/B), so per-pin emptiness is NOT a reliable bug
// signal — only a fully input-less operator is.
const REQUIRES_INPUT_TYPES = new Set([
  'Multiply', 'Add', 'Subtract', 'Divide', 'Lerp', 'Power', 'Min', 'Max',
  'Clamp', 'Normalize', 'OneMinus', 'AppendVector', 'Fmod', 'If',
]);

function danglingOperatorWarnings(graph: MatGraph): string[] {
  const fed = new Set<string>();      // node ids with >=1 incoming connection
  const sources = new Set<string>();  // node ids with >=1 outgoing connection
  for (const c of graph.connections) {
    const ti = c.to.indexOf(':'); if (ti > 0) fed.add(c.to.slice(0, ti));
    const fi = c.from.indexOf(':'); if (fi > 0) sources.add(c.from.slice(0, fi));
  }
  const out: string[] = [];
  for (const n of graph.nodes) {
    if (!REQUIRES_INPUT_TYPES.has(n.type)) continue;
    const hasParams = !!n.params && Object.keys(n.params).length > 0;
    if (sources.has(n.id) && !fed.has(n.id) && !hasParams) {
      out.push(
        `"${n.id}" (${n.type}) feeds downstream but has no inputs wired and no params — ` +
        `it can only output a default; wire its inputs or remove it.`,
      );
    }
  }
  return out;
}

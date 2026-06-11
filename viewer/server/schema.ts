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

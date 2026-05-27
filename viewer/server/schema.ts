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

  const nodes = Array.isArray(g.nodes) ? (g.nodes as { id: unknown; type: unknown }[]) : [];
  const ids = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (typeof n !== 'object' || n === null) { errors.push(`nodes[${i}] must be an object`); continue; }
    if (typeof n.id !== 'string') { errors.push(`nodes[${i}].id must be string`); continue; }
    if (typeof n.type !== 'string') { errors.push(`nodes[${i}].type must be string`); continue; }
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
      const [nodeId] = v.split(':');
      if (!ids.has(nodeId)) errors.push(`connections[${i}].${label} references unknown node: ${nodeId}`);
      return nodeId;
    };
    void checkEnd('from', c.from);
    void checkEnd('to', c.to);
  }

  return { errors, graph: errors.length === 0 ? (input as MatGraph) : null };
}

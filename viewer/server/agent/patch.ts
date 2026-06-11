// server/agent/patch.ts — pure patch_graph domain operations.
// No I/O; never mutates the input graph; returns structured results.

import type { MatGraph, Node, Connection } from '../types.js';

// Re-export types so consumers import from one place.
export type { MatGraph, Node, Connection };

// ---------------------------------------------------------------------------
// PatchOp interfaces
// ---------------------------------------------------------------------------

export interface AddNodeOp {
  op: 'addNode';
  id: string;
  type: string;
  params?: Record<string, unknown>;
  why?: string;
}

export interface RemoveNodeOp {
  op: 'removeNode';
  id: string;
  why?: string;
}

export interface SetParamOp {
  op: 'setParam';
  id: string;
  key: string;
  value: unknown;
  why?: string;
}

export interface RemoveParamOp {
  op: 'removeParam';
  id: string;
  key: string;
  why?: string;
}

export interface SetNodeTypeOp {
  op: 'setNodeType';
  id: string;
  type: string;
  why?: string;
}

export interface RenameNodeOp {
  op: 'renameNode';
  id: string;
  newId: string;
  why?: string;
}

export interface ConnectOp {
  op: 'connect';
  from: string;
  to: string;
  why?: string;
}

export interface DisconnectOp {
  op: 'disconnect';
  from: string;
  to: string;
  why?: string;
}

export interface SetDescriptionOp {
  op: 'setDescription';
  value: string;
  why?: string;
}

export type PatchOp =
  | AddNodeOp
  | RemoveNodeOp
  | SetParamOp
  | RemoveParamOp
  | SetNodeTypeOp
  | RenameNodeOp
  | ConnectOp
  | DisconnectOp
  | SetDescriptionOp;

/** Canonical op names, in the order the tool docstring lists them. */
export const SUPPORTED_OPS = [
  'addNode', 'removeNode', 'setParam', 'removeParam', 'setNodeType',
  'renameNode', 'connect', 'disconnect', 'setDescription',
] as const;

// LLMs routinely emit snake_case (and the JSON-Patch-ish verbs from other
// ecosystems) — accept them as aliases instead of failing the whole patch.
const OP_ALIASES: Record<string, PatchOp['op']> = {
  add_node: 'addNode',
  remove_node: 'removeNode',
  delete_node: 'removeNode',
  set_param: 'setParam',
  remove_param: 'removeParam',
  delete_param: 'removeParam',
  set_node_type: 'setNodeType',
  change_node_type: 'setNodeType',
  replace_node: 'setNodeType',
  rename_node: 'renameNode',
  add_connection: 'connect',
  remove_connection: 'disconnect',
  delete_connection: 'disconnect',
  set_description: 'setDescription',
};

/** Resolve alias op names to canonical ones; canonical ops pass through unchanged. */
export function normalizeOp(op: PatchOp): PatchOp {
  const name = (op as { op?: unknown }).op;
  const canonical = typeof name === 'string' ? OP_ALIASES[name] : undefined;
  return canonical ? ({ ...op, op: canonical } as PatchOp) : op;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ApplyResult =
  | { ok: true; graph: MatGraph; diff: string[] }
  | { ok: false; opIndex: number; applyError: string };

// ---------------------------------------------------------------------------
// applyPatch
// ---------------------------------------------------------------------------

export function applyPatch(graph: MatGraph, ops: PatchOp[]): ApplyResult {
  // Never mutate the input.
  let g: MatGraph = structuredClone(graph);
  const diff: string[] = [];

  for (let i = 0; i < ops.length; i++) {
    const op = normalizeOp(ops[i]);
    const why = op.why ? `（${op.why}）` : '';
    const err = applyOp(g, op, diff, why);
    if (err !== null) {
      return { ok: false, opIndex: i, applyError: err };
    }
  }

  return { ok: true, graph: g, diff };
}

/**
 * Node ids touched by a successfully-applied op list — drives the viewer's
 * post-write canvas highlight. Removed nodes are gone (nothing to point at)
 * and setDescription touches no node. connect/disconnect endpoints are
 * "nodeId:pin" — applyConnect/applyDisconnect validated the ':' already.
 */
export function changedNodeIds(ops: PatchOp[]): string[] {
  const ids = new Set<string>();
  for (const raw of ops) {
    const op = normalizeOp(raw);
    switch (op.op) {
      case 'addNode':
      case 'setParam':
      case 'removeParam':
      case 'setNodeType':
        ids.add(op.id);
        break;
      case 'renameNode':
        ids.add(op.newId);
        break;
      case 'connect':
      case 'disconnect':
        ids.add(op.from.slice(0, op.from.indexOf(':')));
        ids.add(op.to.slice(0, op.to.indexOf(':')));
        break;
      default:
        break;
    }
  }
  return [...ids];
}

// Applies a single op to graph in place. Returns null on success, error string on failure.
function applyOp(g: MatGraph, op: PatchOp, diff: string[], why: string): string | null {
  switch (op.op) {
    case 'addNode':    return applyAddNode(g, op, diff, why);
    case 'removeNode': return applyRemoveNode(g, op, diff, why);
    case 'setParam':   return applySetParam(g, op, diff, why);
    case 'removeParam': return applyRemoveParam(g, op, diff, why);
    case 'setNodeType': return applySetNodeType(g, op, diff, why);
    case 'renameNode': return applyRenameNode(g, op, diff, why);
    case 'connect':    return applyConnect(g, op, diff, why);
    case 'disconnect': return applyDisconnect(g, op, diff, why);
    case 'setDescription': return applySetDescription(g, op, diff, why);
    default:
      // ops arrive as a blind cast from LLM output — an unknown op must produce
      // a clear applyError instead of falling through to undefined. Listing the
      // supported ops lets the model self-correct on the next attempt.
      return `unknown op "${String((op as { op?: unknown }).op)}" — supported ops: ${SUPPORTED_OPS.join(', ')} (snake_case aliases like add_node/add_connection are also accepted)`;
  }
}

function applyAddNode(g: MatGraph, op: AddNodeOp, diff: string[], why: string): string | null {
  if (op.id.includes(':')) {
    return `addNode: id "${op.id}" must not contain ':'`;
  }
  if (g.nodes.some(n => n.id === op.id)) {
    return `addNode: node id "${op.id}" already exists`;
  }
  const node: Node = { id: op.id, type: op.type };
  if (op.params && Object.keys(op.params).length > 0) {
    node.params = op.params;
  }
  g.nodes.push(node);
  diff.push(`加入了 \`${op.type}\` 節點「\`${op.id}\`」${why}`);
  return null;
}

function applyRemoveNode(g: MatGraph, op: RemoveNodeOp, diff: string[], why: string): string | null {
  const idx = g.nodes.findIndex(n => n.id === op.id);
  if (idx === -1) {
    return `removeNode: node "${op.id}" not found`;
  }

  // Cascade: collect connections touching this node
  const removed: Connection[] = [];
  const kept: Connection[] = [];
  for (const c of g.connections) {
    const fromId = c.from.slice(0, c.from.indexOf(':'));
    const toId = c.to.slice(0, c.to.indexOf(':'));
    if (fromId === op.id || toId === op.id) {
      removed.push(c);
    } else {
      kept.push(c);
    }
  }

  g.nodes.splice(idx, 1);
  g.connections = kept;

  diff.push(`移除了節點「\`${op.id}\`」及其 ${removed.length} 條連線${why}`);
  for (const c of removed) {
    diff.push(`　└ 斷開 ${c.from} → ${c.to}`);
  }
  return null;
}

function applySetParam(g: MatGraph, op: SetParamOp, diff: string[], why: string): string | null {
  const node = g.nodes.find(n => n.id === op.id);
  if (!node) {
    return `setParam: node "${op.id}" not found`;
  }
  if (!node.params) node.params = {};
  node.params[op.key] = op.value;
  diff.push(`將「\`${op.id}\`」的 ${op.key} 改為 ${JSON.stringify(op.value)}${why}`);
  return null;
}

function applyRemoveParam(g: MatGraph, op: RemoveParamOp, diff: string[], why: string): string | null {
  const node = g.nodes.find(n => n.id === op.id);
  if (!node) {
    return `removeParam: node "${op.id}" not found`;
  }
  if (!node.params || !(op.key in node.params)) {
    return `removeParam: node "${op.id}" has no param "${op.key}"`;
  }
  delete node.params[op.key];
  if (Object.keys(node.params).length === 0) delete node.params;
  diff.push(`移除了「\`${op.id}\`」的 ${op.key} 參數${why}`);
  return null;
}

function applySetNodeType(g: MatGraph, op: SetNodeTypeOp, diff: string[], why: string): string | null {
  const node = g.nodes.find(n => n.id === op.id);
  if (!node) {
    return `setNodeType: node "${op.id}" not found`;
  }
  if (node.type === op.type) {
    return `setNodeType: node "${op.id}" is already of type "${op.type}"`;
  }
  const oldType = node.type;
  node.type = op.type;
  // Connections and params are kept on purpose — the validation gate re-checks
  // every pin against the new type and rejects the patch if any no longer fits.
  diff.push(`將「\`${op.id}\`」的類型從 \`${oldType}\` 改為 \`${op.type}\`${why}`);
  return null;
}

function applyRenameNode(g: MatGraph, op: RenameNodeOp, diff: string[], why: string): string | null {
  if (op.newId.includes(':')) {
    return `renameNode: newId "${op.newId}" must not contain ':'`;
  }
  const idx = g.nodes.findIndex(n => n.id === op.id);
  if (idx === -1) {
    return `renameNode: node "${op.id}" not found`;
  }
  if (g.nodes.some(n => n.id === op.newId)) {
    return `renameNode: target id "${op.newId}" already exists`;
  }

  // Rewrite node id
  g.nodes[idx] = { ...g.nodes[idx], id: op.newId };

  // Rewrite all connection from/to that reference this nodeId prefix
  let connCount = 0;
  g.connections = g.connections.map(c => {
    const fromId = c.from.slice(0, c.from.indexOf(':'));
    const toId = c.to.slice(0, c.to.indexOf(':'));
    const newFrom = fromId === op.id ? `${op.newId}${c.from.slice(c.from.indexOf(':'))}` : c.from;
    const newTo = toId === op.id ? `${op.newId}${c.to.slice(c.to.indexOf(':'))}` : c.to;
    if (newFrom !== c.from || newTo !== c.to) connCount++;
    return { from: newFrom, to: newTo };
  });

  diff.push(`將「\`${op.id}\`」改名為「\`${op.newId}\`」（同步更新 ${connCount} 條連線）${why}`);
  return null;
}

// "nodeId:pinName" with both halves non-empty — "A:" or ":Pin" are rejected
// here AND by schema.ts checkEnd (the final gate before disk).
function isValidEnd(v: string): boolean {
  const ci = v.indexOf(':');
  return ci > 0 && v.slice(ci + 1).trim().length > 0;
}

function applyConnect(g: MatGraph, op: ConnectOp, diff: string[], why: string): string | null {
  if (typeof op.from !== 'string' || !isValidEnd(op.from)) {
    return `connect: from "${op.from}" must be "nodeId:pinName"`;
  }
  if (typeof op.to !== 'string' || !isValidEnd(op.to)) {
    return `connect: to "${op.to}" must be "nodeId:pinName"`;
  }
  // Duplicate connection check
  if (g.connections.some(c => c.from === op.from && c.to === op.to)) {
    return `connect: connection ${op.from} → ${op.to} already exists`;
  }
  // UE input pins take exactly one wire — an occupied target pin is a modeling
  // error, and an explicit message beats silently stacking a second connection.
  const occupied = g.connections.find(c => c.to === op.to);
  if (occupied) {
    return `connect: input pin ${op.to} already has a connection (from ${occupied.from}) — disconnect it first, or pick another pin`;
  }
  // Note: nonexistent node references are NOT checked here (validateGraph handles it).
  g.connections.push({ from: op.from, to: op.to });
  diff.push(`連接 ${op.from} → ${op.to}${why}`);
  return null;
}

function applyDisconnect(g: MatGraph, op: DisconnectOp, diff: string[], why: string): string | null {
  if (typeof op.from !== 'string' || !isValidEnd(op.from)) {
    return `disconnect: from "${op.from}" must be "nodeId:pinName"`;
  }
  if (typeof op.to !== 'string' || !isValidEnd(op.to)) {
    return `disconnect: to "${op.to}" must be "nodeId:pinName"`;
  }
  const idx = g.connections.findIndex(c => c.from === op.from && c.to === op.to);
  if (idx === -1) {
    return `disconnect: connection ${op.from} → ${op.to} not found`;
  }
  g.connections.splice(idx, 1);
  diff.push(`斷開 ${op.from} → ${op.to}${why}`);
  return null;
}

function applySetDescription(g: MatGraph, op: SetDescriptionOp, diff: string[], why: string): string | null {
  g.description = op.value;
  diff.push(`設定描述為 ${JSON.stringify(op.value)}${why}`);
  return null;
}

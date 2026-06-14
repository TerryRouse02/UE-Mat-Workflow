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
  /** Omitted → an id is auto-generated from the type ("multiply_1", …) and
      reported back via ApplyResult.assignedIds. Supply an explicit id when a
      later op in the same batch needs to reference the new node. */
  id?: string;
  type: string;
  params?: Record<string, unknown>;
  /** UE editor position (UE space). Optional — omit to let the viewer auto-place
      the node near its wiring; set it (or use setPosition) to control placement. */
  pos?: { x: number; y: number };
  why?: string;
}

export interface InsertNodeOp {
  op: 'insertNode';
  /** EXISTING connection to splice into — it is replaced by
      between.from → new:inputPin and new:outputPin → between.to. */
  between: { from: string; to: string };
  type: string;
  /** Omitted → auto-generated like addNode. */
  id?: string;
  params?: Record<string, unknown>;
  /** Omitted → first input pin of the type's DB signature (needs pinLookup). */
  inputPin?: string;
  /** Omitted → first output pin of the type's DB signature (needs pinLookup). */
  outputPin?: string;
  /** UE editor position. Optional — defaults to the midpoint of the spliced
      connection's endpoints when both carry a position; else the viewer
      auto-places it. */
  pos?: { x: number; y: number };
  why?: string;
}

export interface RemoveNodeOp {
  op: 'removeNode';
  id: string;
  /** true → splice the node's upstream source directly onto every pin the
      node fed (chain stays intact). Requires ≥1 incoming connection, and all
      outgoing connections must leave from ONE output pin. */
  heal?: boolean;
  /** When several input pins are wired, names the input pin whose source
      survives the heal. */
  healFrom?: string;
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

export interface SetPositionOp {
  op: 'setPosition';
  id: string;
  pos: { x: number; y: number };
  why?: string;
}

export type PatchOp =
  | AddNodeOp
  | InsertNodeOp
  | RemoveNodeOp
  | SetParamOp
  | RemoveParamOp
  | SetNodeTypeOp
  | RenameNodeOp
  | ConnectOp
  | DisconnectOp
  | SetDescriptionOp
  | SetPositionOp;

/** Canonical op names, in the order the tool docstring lists them. */
export const SUPPORTED_OPS = [
  'addNode', 'insertNode', 'removeNode', 'setParam', 'removeParam', 'setNodeType',
  'renameNode', 'connect', 'disconnect', 'setDescription', 'setPosition',
] as const;

/**
 * Static pin signature for a node type, in DB declaration order — lets
 * insertNode infer pins. null = no static signature (unknown type, dynamic
 * pins, MaterialFunctionCall): explicit inputPin/outputPin required then.
 * Injected by the caller (tools.ts builds it from the version DB) so this
 * module stays pure.
 */
export type PinLookup = (type: string) => { inputs: string[]; outputs: string[] } | null;

// LLMs routinely emit snake_case (and the JSON-Patch-ish verbs from other
// ecosystems) — accept them as aliases instead of failing the whole patch.
const OP_ALIASES: Record<string, PatchOp['op']> = {
  add_node: 'addNode',
  insert_node: 'insertNode',
  insert_between: 'insertNode',
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
  set_position: 'setPosition',
  move_node: 'setPosition',
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

export interface PatchOpError {
  opIndex: number;
  message: string;
}

export type ApplyResult =
  | {
      ok: true;
      graph: MatGraph;
      diff: string[];
      /** opIndex → auto-generated node id, for addNode ops that omitted `id`. */
      assignedIds: Record<number, string>;
      /** Ops after normalization + auto-id resolution — feed these (not the
          raw input) to changedNodeIds. */
      resolvedOps: PatchOp[];
    }
  | {
      ok: false;
      /** EVERY failing op, so the model fixes the whole batch in one retry
          instead of replaying one round-trip per error. */
      errors: PatchOpError[];
      /** First error, kept for callers/tests that only need fail-fast info. */
      opIndex: number;
      applyError: string;
    };

// ---------------------------------------------------------------------------
// applyPatch
// ---------------------------------------------------------------------------

/** Smallest "<type>_n" id not colliding with any existing node. */
function autoNodeId(g: MatGraph, type: unknown): string {
  const base = String(type ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'node';
  for (let n = 1; ; n++) {
    const id = `${base}_${n}`;
    if (!g.nodes.some(nd => nd.id === id)) return id;
  }
}

export interface ApplyPatchOpts {
  pinLookup?: PinLookup;
}

export function applyPatch(graph: MatGraph, ops: PatchOp[], opts?: ApplyPatchOpts): ApplyResult {
  // Never mutate the input.
  let g: MatGraph = structuredClone(graph);
  const diff: string[] = [];
  const errors: PatchOpError[] = [];
  const assignedIds: Record<number, string> = {};
  const resolvedOps: PatchOp[] = [];

  for (let i = 0; i < ops.length; i++) {
    let op = normalizeOp(ops[i]);
    if (
      (op.op === 'addNode' || op.op === 'insertNode') &&
      (op.id === undefined || op.id === null || op.id === '')
    ) {
      const id = autoNodeId(g, op.type);
      op = { ...op, id };
      assignedIds[i] = id;
    }
    resolvedOps.push(op);
    const why = op.why ? `（${op.why}）` : '';
    const err = applyOp(g, op, diff, why, opts?.pinLookup);
    if (err !== null) {
      errors.push({ opIndex: i, message: err });
      // Anti-cascade phantom: a failed addNode/insertNode whose id never
      // landed would make every later op referencing it fail spuriously
      // ("not found"). Insert the node anyway — the graph is discarded on
      // error, so this only exists to keep the remaining reports meaningful.
      if ((op.op === 'addNode' || op.op === 'insertNode') && op.id && !g.nodes.some(n => n.id === op.id)) {
        g.nodes.push({ id: op.id, type: op.type });
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, opIndex: errors[0].opIndex, applyError: errors[0].message };
  }
  return { ok: true, graph: g, diff, assignedIds, resolvedOps };
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
        if (op.id) ids.add(op.id);
        break;
      case 'insertNode':
        if (op.id) ids.add(op.id);
        if (op.between && typeof op.between.from === 'string' && op.between.from.includes(':')) {
          ids.add(op.between.from.slice(0, op.between.from.indexOf(':')));
        }
        if (op.between && typeof op.between.to === 'string' && op.between.to.includes(':')) {
          ids.add(op.between.to.slice(0, op.between.to.indexOf(':')));
        }
        break;
      case 'setParam':
      case 'removeParam':
      case 'setNodeType':
        ids.add(op.id);
        break;
      case 'renameNode':
        ids.add(op.newId);
        break;
      case 'setPosition':
        ids.add(op.id);
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
function applyOp(g: MatGraph, op: PatchOp, diff: string[], why: string, pinLookup?: PinLookup): string | null {
  switch (op.op) {
    case 'addNode':    return applyAddNode(g, op, diff, why);
    case 'insertNode': return applyInsertNode(g, op, diff, why, pinLookup);
    case 'removeNode': return applyRemoveNode(g, op, diff, why);
    case 'setParam':   return applySetParam(g, op, diff, why);
    case 'removeParam': return applyRemoveParam(g, op, diff, why);
    case 'setNodeType': return applySetNodeType(g, op, diff, why);
    case 'renameNode': return applyRenameNode(g, op, diff, why);
    case 'connect':    return applyConnect(g, op, diff, why);
    case 'disconnect': return applyDisconnect(g, op, diff, why);
    case 'setDescription': return applySetDescription(g, op, diff, why);
    case 'setPosition': return applySetPosition(g, op, diff, why);
    default:
      // ops arrive as a blind cast from LLM output — an unknown op must produce
      // a clear applyError instead of falling through to undefined. Listing the
      // supported ops lets the model self-correct on the next attempt.
      return `unknown op "${String((op as { op?: unknown }).op)}" — supported ops: ${SUPPORTED_OPS.join(', ')} (snake_case aliases like add_node/add_connection are also accepted)`;
  }
}

function applyAddNode(g: MatGraph, op: AddNodeOp, diff: string[], why: string): string | null {
  if (!op.id) {
    // Unreachable through applyPatch (auto-id resolution runs first) — guard
    // for direct callers.
    return 'addNode: id missing';
  }
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
  if (op.pos && Number.isFinite(op.pos.x) && Number.isFinite(op.pos.y)) {
    node.pos = { x: Math.round(op.pos.x), y: Math.round(op.pos.y) };
  }
  g.nodes.push(node);
  diff.push(`加入了 \`${op.type}\` 節點「\`${op.id}\`」${why}`);
  return null;
}

function applySetPosition(g: MatGraph, op: SetPositionOp, diff: string[], why: string): string | null {
  const node = g.nodes.find(n => n.id === op.id);
  if (!node) {
    return `setPosition: node "${op.id}" not found`;
  }
  const p = op.pos;
  if (!p || typeof p !== 'object' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    return 'setPosition: pos must be {x:<number>, y:<number>}';
  }
  node.pos = { x: Math.round(p.x), y: Math.round(p.y) };
  diff.push(`把節點「\`${op.id}\`」移到 (${node.pos.x}, ${node.pos.y})${why}`);
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

  // heal: splice the node's upstream source onto every pin it fed, so the
  // chain stays intact. Refused when the choice is ambiguous.
  let healSource: string | null = null;
  let healTargets: Connection[] = [];
  if (op.heal) {
    const incoming = removed.filter(c => c.to.startsWith(op.id + ':') && !c.from.startsWith(op.id + ':'));
    const outgoing = removed.filter(c => c.from.startsWith(op.id + ':') && !c.to.startsWith(op.id + ':'));
    if (incoming.length === 0) {
      return `removeNode: heal requested but "${op.id}" has no incoming connection — use removeNode without heal`;
    }
    let survivor: Connection;
    if (incoming.length === 1) {
      survivor = incoming[0];
    } else {
      const pins = incoming.map(c => c.to.slice(c.to.indexOf(':') + 1));
      if (!op.healFrom) {
        return `removeNode: "${op.id}" has ${incoming.length} incoming connections (input pins: ${pins.join(', ')}) — pass healFrom:"<inputPin>" to choose which source survives the heal`;
      }
      const match = incoming.find(c => c.to === `${op.id}:${op.healFrom}`);
      if (!match) {
        return `removeNode: healFrom "${op.healFrom}" matches no incoming connection on "${op.id}" (wired input pins: ${pins.join(', ')})`;
      }
      survivor = match;
    }
    const outPins = new Set(outgoing.map(c => c.from.slice(c.from.indexOf(':') + 1)));
    if (outPins.size > 1) {
      return `removeNode: heal is ambiguous — "${op.id}" feeds downstream from ${outPins.size} different output pins (${[...outPins].join(', ')}); rewire manually instead`;
    }
    healSource = survivor.from;
    healTargets = outgoing;
  }

  g.nodes.splice(idx, 1);
  g.connections = kept;

  if (healSource !== null && healTargets.length > 0) {
    for (const out of healTargets) {
      g.connections.push({ from: healSource, to: out.to });
    }
    diff.push(`移除了節點「\`${op.id}\`」並把 ${healSource} 縫合到其 ${healTargets.length} 個下游針腳${why}`);
    for (const out of healTargets) {
      diff.push(`　└ 接回 ${healSource} → ${out.to}`);
    }
    return null;
  }

  diff.push(`移除了節點「\`${op.id}\`」及其 ${removed.length} 條連線${why}`);
  for (const c of removed) {
    diff.push(`　└ 斷開 ${c.from} → ${c.to}`);
  }
  return null;
}

function applyInsertNode(
  g: MatGraph,
  op: InsertNodeOp,
  diff: string[],
  why: string,
  pinLookup?: PinLookup,
): string | null {
  if (!op.id) {
    // Unreachable through applyPatch (auto-id resolution runs first).
    return 'insertNode: id missing';
  }
  if (op.id.includes(':')) {
    return `insertNode: id "${op.id}" must not contain ':'`;
  }
  if (g.nodes.some(n => n.id === op.id)) {
    return `insertNode: node id "${op.id}" already exists`;
  }
  const b = op.between;
  if (
    !b || typeof b !== 'object' ||
    typeof b.from !== 'string' || !isValidEnd(b.from) ||
    typeof b.to !== 'string' || !isValidEnd(b.to)
  ) {
    return 'insertNode: between must be {from:"nodeId:pin", to:"nodeId:pin"}';
  }
  const connIdx = g.connections.findIndex(c => c.from === b.from && c.to === b.to);
  if (connIdx === -1) {
    return `insertNode: connection ${b.from} → ${b.to} not found — insertNode splices into an EXISTING connection`;
  }

  // Pin inference: explicit beats signature; signature = first pin in DB
  // order. No signature (unknown/dynamic-pin/MF type) → explicit required.
  const sig = pinLookup ? pinLookup(op.type) : null;
  let inputPin = op.inputPin;
  if (!inputPin) {
    if (!sig || sig.inputs.length === 0) {
      return `insertNode: cannot infer an input pin for type "${op.type}" — pass inputPin explicitly (unknown, dynamic-pin and MaterialFunctionCall types have no static signature)`;
    }
    inputPin = sig.inputs[0];
  }
  let outputPin = op.outputPin;
  if (!outputPin) {
    if (!sig || sig.outputs.length === 0) {
      return `insertNode: cannot infer an output pin for type "${op.type}" — pass outputPin explicitly (unknown, dynamic-pin and MaterialFunctionCall types have no static signature)`;
    }
    outputPin = sig.outputs[0];
  }

  const node: Node = { id: op.id, type: op.type };
  if (op.params && Object.keys(op.params).length > 0) {
    node.params = op.params;
  }
  // Position: explicit beats the auto-midpoint of the spliced endpoints, so a
  // node inserted into a positioned graph lands on the wire instead of being
  // auto-placed. Endpoints are looked up before the node is pushed.
  if (op.pos && Number.isFinite(op.pos.x) && Number.isFinite(op.pos.y)) {
    node.pos = { x: Math.round(op.pos.x), y: Math.round(op.pos.y) };
  } else {
    const fromNode = g.nodes.find(n => n.id === b.from.slice(0, b.from.indexOf(':')));
    const toNode = g.nodes.find(n => n.id === b.to.slice(0, b.to.indexOf(':')));
    if (
      fromNode?.pos && toNode?.pos &&
      Number.isFinite(fromNode.pos.x) && Number.isFinite(fromNode.pos.y) &&
      Number.isFinite(toNode.pos.x) && Number.isFinite(toNode.pos.y)
    ) {
      node.pos = {
        x: Math.round((fromNode.pos.x + toNode.pos.x) / 2),
        y: Math.round((fromNode.pos.y + toNode.pos.y) / 2),
      };
    }
  }
  g.connections.splice(connIdx, 1);
  g.nodes.push(node);
  g.connections.push({ from: b.from, to: `${op.id}:${inputPin}` });
  g.connections.push({ from: `${op.id}:${outputPin}`, to: b.to });

  diff.push(
    `在 ${b.from} → ${b.to} 之間插入了 \`${op.type}\` 節點「\`${op.id}\`」` +
    `（${b.from} → ${op.id}:${inputPin}，${op.id}:${outputPin} → ${b.to}）${why}`,
  );
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

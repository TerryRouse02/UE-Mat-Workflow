import type { MatGraph } from './protocol';
import type { NodeDB } from '../../server/db-types';
import { MATERIAL_OUTPUT_PINS } from './nodes/MaterialOutputNode';
import { splitRef } from './connstr';

export interface ConnectionPinIssue {
  from: string;
  to: string;
  problem: string;
}

// MaterialOutput's input pins are the fixed set of material attribute names.
const MATERIAL_OUTPUT_INPUTS = new Set<string>(MATERIAL_OUTPUT_PINS);

interface PinSets {
  inputs: Set<string>;
  outputs: Set<string>;
  // When true, this node's pins are dynamic/derived and must NOT be validated
  // against a static list (avoids false positives).
  skip: boolean;
}

// Resolve the set of valid input/output pin names for a node type, or signal
// that pin validation should be skipped (dynamic pins, derived pins, or an
// unknown node type which is reported elsewhere).
function pinSetsFor(type: string, db: NodeDB): PinSets | null {
  // Reserved types are not in db.nodes; handle each explicitly.
  switch (type) {
    case 'MaterialOutput':
      return { inputs: MATERIAL_OUTPUT_INPUTS, outputs: new Set(), skip: false };
    case 'FunctionInput':
      // Acts as a source inside a MaterialFunction: output pin "Input".
      return { inputs: new Set(), outputs: new Set(['Input']), skip: false };
    case 'FunctionOutput':
      return { inputs: new Set(['Input']), outputs: new Set(), skip: false };
    case 'MaterialFunctionCall':
      // Pins are derived from the referenced MF - cannot validate statically.
      return { inputs: new Set(), outputs: new Set(), skip: true };
  }

  const def = db.nodes[type];
  // Unknown node type: surfaced by the existing "Unknown node type" warning,
  // not a pin-existence problem. Skip here to avoid duplicate/noisy reports.
  if (!def) return null;
  // Dynamic-pin nodes (Custom, SetMaterialAttributes, ...) have user/param
  // defined pins; skip pin-existence checks.
  if (def.dynamicPins) return { inputs: new Set(), outputs: new Set(), skip: true };

  return {
    inputs: new Set((def.inputs ?? []).map(p => p.name)),
    outputs: new Set((def.outputs ?? []).map(p => p.name)),
    skip: false,
  };
}

/**
 * Validate that every connection endpoint references a pin that actually exists
 * on its node. Returns one issue per offending endpoint.
 *
 * Skips (no false positives for):
 *  - dynamic-pin nodes (Custom, SetMaterialAttributes, GetMaterialAttributes, ...)
 *  - MaterialFunctionCall (pins derived from the referenced MF)
 *  - unknown node types (already flagged by the "Unknown node type" warning)
 *  - endpoints whose node id isn't present in the graph
 */
export function validateConnectionPins(graph: MatGraph, db: NodeDB): ConnectionPinIssue[] {
  const typeById = new Map<string, string>();
  for (const n of graph.nodes) typeById.set(n.id, n.type);

  const issues: ConnectionPinIssue[] = [];

  for (const c of graph.connections) {
    const [srcId, srcPin] = splitRef(c.from);
    const [dstId, dstPin] = splitRef(c.to);

    // Source endpoint: pin must exist as an OUTPUT.
    const srcType = typeById.get(srcId);
    if (srcType !== undefined && srcPin) {
      const sets = pinSetsFor(srcType, db);
      if (sets && !sets.skip && !sets.outputs.has(srcPin)) {
        issues.push({
          from: c.from, to: c.to,
          problem: `Connection from "${c.from}": node "${srcId}" (${srcType}) has no output pin "${srcPin}".`,
        });
      }
    }

    // Destination endpoint: pin must exist as an INPUT.
    const dstType = typeById.get(dstId);
    if (dstType !== undefined && dstPin) {
      const sets = pinSetsFor(dstType, db);
      if (sets && !sets.skip && !sets.inputs.has(dstPin)) {
        issues.push({
          from: c.from, to: c.to,
          problem: `Connection to "${c.to}": node "${dstId}" (${dstType}) has no input pin "${dstPin}".`,
        });
      }
    }
  }

  return issues;
}

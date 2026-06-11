// server/agent/pin-validate.ts — connection-pin existence check for the agent
// write gate. Mirrors web/src/validate.ts (validateConnectionPins) semantics:
// the gate must reject exactly what the viewer would flag, so an LLM-invented
// pin name never reaches disk with ok:true.
//
// Skips (no false positives for):
//  - dynamic-pin nodes (Custom, SetMaterialAttributes, ... — `dynamicPins` in the DB)
//  - MaterialFunctionCall (pins derive from the referenced MF; mf-resolver's job)
//  - unknown node types (the gate's own unknown-type check already errors)
//  - endpoints whose node id isn't in the graph (validateGraph already errors)

import type { MatGraph } from '../types.js';
import { MATERIAL_OUTPUT_PINS } from '../material-attributes.js';

/** Minimal shape of a raw nodes-ue<v>.json DB entry this check needs. */
interface DbNodeEntry {
  inputs?: Array<{ name?: unknown }>;
  outputs?: Array<{ name?: unknown }>;
  dynamicPins?: boolean;
}

interface PinSets {
  inputs: Set<string>;
  outputs: Set<string>;
  skip: boolean;
}

const MATERIAL_OUTPUT_INPUTS = new Set<string>(MATERIAL_OUTPUT_PINS);

function pinNames(list: Array<{ name?: unknown }> | undefined): Set<string> {
  return new Set((list ?? []).map(p => String(p.name)));
}

// Same reserved-type table as the web validator — keep the two in sync.
function pinSetsFor(type: string, nodesMap: Record<string, unknown>): PinSets | null {
  switch (type) {
    case 'MaterialOutput':
      return { inputs: MATERIAL_OUTPUT_INPUTS, outputs: new Set(), skip: false };
    case 'FunctionInput':
      return { inputs: new Set(), outputs: new Set(['Input']), skip: false };
    case 'FunctionOutput':
      return { inputs: new Set(['Input']), outputs: new Set(), skip: false };
    case 'MaterialFunctionCall':
      return { inputs: new Set(), outputs: new Set(), skip: true };
    case 'NamedRerouteDeclaration':
      // Imported wires canonicalize to Result; root LinkedTo pins may carry
      // UE's displayed Output name (same special case as the web validator).
      return { inputs: new Set(['Input']), outputs: new Set(['Result', 'Output']), skip: false };
  }

  const def = nodesMap[type] as DbNodeEntry | undefined;
  if (!def) return null; // unknown type — reported by the gate's type check
  if (def.dynamicPins) return { inputs: new Set(), outputs: new Set(), skip: true };

  return { inputs: pinNames(def.inputs), outputs: pinNames(def.outputs), skip: false };
}

/**
 * One error string per endpoint that references a pin which does not exist on
 * its node. `nodesMap` is the raw nodes object of the version DB.
 */
export function connectionPinErrors(graph: MatGraph, nodesMap: Record<string, unknown>): string[] {
  const typeById = new Map<string, string>();
  for (const n of graph.nodes) typeById.set(n.id, n.type);

  const errors: string[] = [];

  for (const c of graph.connections) {
    const fi = c.from.indexOf(':');
    const ti = c.to.indexOf(':');
    if (fi < 0 || ti < 0) continue; // malformed ends are validateGraph's job

    const srcId = c.from.slice(0, fi);
    const srcPin = c.from.slice(fi + 1);
    const srcType = typeById.get(srcId);
    if (srcType !== undefined && srcPin) {
      const sets = pinSetsFor(srcType, nodesMap);
      if (sets && !sets.skip && !sets.outputs.has(srcPin)) {
        errors.push(`connection from "${c.from}": node "${srcId}" (${srcType}) has no output pin "${srcPin}"`);
      }
    }

    const dstId = c.to.slice(0, ti);
    const dstPin = c.to.slice(ti + 1);
    const dstType = typeById.get(dstId);
    if (dstType !== undefined && dstPin) {
      const sets = pinSetsFor(dstType, nodesMap);
      if (sets && !sets.skip && !sets.inputs.has(dstPin)) {
        errors.push(`connection to "${c.to}": node "${dstId}" (${dstType}) has no input pin "${dstPin}"`);
      }
    }
  }

  return errors;
}

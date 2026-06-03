import { readFileSync } from 'node:fs';
import type { NodeDB } from './db-types.js';

// A few UE material expressions are legitimate value "sinks" with no output pin.
// The canonical one is NamedRerouteDeclaration: you wire a value INTO it, and its
// paired NamedRerouteUsage node emits that value elsewhere — you never wire from the
// declaration itself. Verified against viewer/tests/fixtures/ue-named-reroute.t3d:
// the Usage references the Declaration via a `Declaration=` object pointer (not a
// wire) and the downstream node reads the Usage's output, so the declaration's own
// `outputs: []` is correct, not a bad crawl. The "every node has an output" rule
// must exempt these.
// Beyond NamedRerouteDeclaration, the engine's material-output / custom-output
// "sink" expressions also have no output pin — they feed a material attribute or
// a named engine output, never a downstream wire. This set was auto-discovered
// (commandlet node discovery: classes whose reflected outputs array is empty).
export const OUTPUTLESS_NODES = new Set<string>([
  'NamedRerouteDeclaration',
  'BentNormalCustomOutput', 'ClearCoatNormalCustomOutput', 'TangentOutput',
  'ThinTranslucentMaterialOutput', 'FirstPersonOutput', 'TemporalResponsivenessOutput',
  'MotionVectorWorldOffsetOutput', 'LandscapeGrassOutput', 'LandscapePhysicalMaterialOutput',
  'AbsorptionMediumMaterialOutput', 'NeuralNetworkInput',
  'RuntimeVirtualTextureOutput', 'SingleLayerWaterMaterialOutput', 'SubsurfaceMediumMaterialOutput',
  'VolumetricAdvancedMaterialOutput', 'VolumetricCloudEmptySpaceSkippingOutput', 'LegacyBlendMaterialAttributes',
]);

export function loadDB(path: string): NodeDB {
  const raw = readFileSync(path, 'utf-8');
  const db = JSON.parse(raw) as NodeDB;
  validateDB(db);
  return db;
}

export function validateDB(db: NodeDB): void {
  if (!db.nodes || typeof db.nodes !== 'object') {
    throw new Error('DB.nodes missing');
  }
  for (const [name, def] of Object.entries(db.nodes)) {
    if ((!def.outputs || def.outputs.length === 0) && !OUTPUTLESS_NODES.has(name)) {
      throw new Error(`Node "${name}" has no outputs`);
    }
    assertUniquePinNames(name, 'inputs', def.inputs ?? []);
    assertUniquePinNames(name, 'outputs', def.outputs ?? []);
  }
}

function assertUniquePinNames(node: string, side: string, pins: { name: string }[]): void {
  const seen = new Set<string>();
  for (const p of pins) {
    if (seen.has(p.name)) {
      throw new Error(`duplicate pin "${p.name}" on ${node}.${side}`);
    }
    seen.add(p.name);
  }
}

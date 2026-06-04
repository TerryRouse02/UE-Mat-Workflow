// Local-only index of the USER's OWN work-project Material Functions.
//
// nodes-ue<ver>.json covers official built-in expressions only. A user's UE
// project has its own MaterialFunctions saved as .uasset, which this repo cannot
// read. The WorkMF crawl (tools/node-t3d-metadata, mode WorkMF) writes their call
// signatures here so three consumers can use them by UE asset path:
//   1. the viewer            — renders MaterialFunctionCall pins,
//   2. the T3D exporter      — already consumes derived pins (no change needed),
//   3. the authoring agent   — reads this file to learn exact pin names.
//
// This file is gitignored and read at RUNTIME on the server. It is deliberately
// NOT loaded through the viewer/web dbRegistry build-time glob: that would bake a
// user's project asset paths into shipped/exported bundles, and its `nodes-ue*`
// version keys would collide with this different kind of data. Keep it off that path.
import { readFile } from 'node:fs/promises';
import type { WorkMfPin, WorkMfEntry, WorkMfIndex, LoadedWorkMfIndex } from './workmf-types.js';

// The type shapes live in the node-free workmf-types.ts (shared with the web).
// Re-export them here so existing server-side importers keep their path.
export type { WorkMfPin, WorkMfEntry, WorkMfIndex, LoadedWorkMfIndex };

// Read the work-MF index. An ABSENT file is not an error (most repos have no work
// MFs) → empty index, no warning. A present-but-broken file IS surfaced as a
// warning so the user notices a bad crawl, but this never throws.
export async function loadWorkMfIndex(filePath: string): Promise<LoadedWorkMfIndex> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { index: null, warnings: [] };
    return { index: null, warnings: [`workmf-index: read error: ${(e as Error).message}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { index: null, warnings: [`workmf-index: invalid JSON in ${filePath}: ${(e as Error).message}`] };
  }
  const obj = parsed as Partial<WorkMfIndex> | null;
  if (!obj || obj.kind !== 'workmf-index') {
    return { index: null, warnings: [`workmf-index: expected kind "workmf-index" in ${filePath}, got ${JSON.stringify(obj?.kind)}`] };
  }
  if (!obj.functions || typeof obj.functions !== 'object') {
    return { index: null, warnings: [`workmf-index: missing "functions" map in ${filePath}`] };
  }
  return { index: obj as WorkMfIndex, warnings: [] };
}

// Pins for a work-MF asset path, in declared order. The exporter's positional
// FunctionInputs(n) index depends on this order, so preserve it. Returns null when
// the asset is not indexed, letting the caller warn distinctly from a known-but-
// empty MF.
export function deriveWorkMfPins(
  index: WorkMfIndex | null,
  assetPath: string,
): { inputs: { name: string; type: string }[]; outputs: { name: string; type: string }[] } | null {
  const entry = index?.functions?.[assetPath];
  if (!entry) return null;
  // A locally-generated crawl could carry a malformed pin (missing name/type); fall
  // back the way the .matgraph FunctionInput path does, so a partial index degrades
  // visibly instead of emitting undefined pins.
  const pin = (p: WorkMfPin) => ({
    name: typeof p?.name === 'string' ? p.name : '(unnamed)',
    type: typeof p?.type === 'string' ? p.type : 'Float3',
  });
  return {
    inputs: (entry.inputs ?? []).map(pin),
    outputs: (entry.outputs ?? []).map(pin),
  };
}

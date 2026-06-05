import { resolve, dirname } from 'node:path';
import type { MatGraph } from './types.js';
import { loadGraph } from './graph-loader.js';
import { deriveWorkMfPins, type WorkMfIndex } from './workmf-index.js';
import type { CrawlFreshness } from './crawl-types.js';
import type { NodeSource, NodeProvenance } from './ws-protocol.js';

export interface DerivedPins {
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
}

export interface ResolvedGraph {
  graph: MatGraph;
  derivedPins: Record<string, DerivedPins>;
  warnings: string[];
  nodeProvenance: Record<string, NodeProvenance>;
}

export interface ResolveOptions {
  // The user's local work-project MF index (agent-pack/workmf-index.json), loaded
  // once by the caller and threaded through recursion. Absent → /Game asset-path
  // MFCs can't be previewed and warn.
  workMfIndex?: WorkMfIndex | null;
  // The committed official-engine MF index (agent-pack/enginemf-index-ue5.7.json),
  // covering /Engine/... built-in Material Functions. Same shape as the work index;
  // stable shipped data, so it lives in the repo (unlike the gitignored work index).
  engineMfIndex?: WorkMfIndex | null;
  // Freshness timestamps keyed by crawl kind — passed through so provenance records
  // can include when the source data was last refreshed.
  freshnessMap?: CrawlFreshness;
}

export async function resolveMaterialFunctions(
  graph: MatGraph,
  graphDir: string,
  visited: Set<string> = new Set(),
  opts: ResolveOptions = {},
): Promise<ResolvedGraph> {
  const derivedPins: Record<string, DerivedPins> = {};
  const warnings: string[] = [];
  const nodeProvenance: Record<string, NodeProvenance> = {};

  for (const node of graph.nodes) {
    if (node.type !== 'MaterialFunctionCall') continue;
    const relPath = (node.params?.MaterialFunction as string | undefined) ?? '';
    if (!relPath) {
      warnings.push(`MFC "${node.id}": params.MaterialFunction missing`);
      derivedPins[node.id] = { inputs: [], outputs: [] };
      nodeProvenance[node.id] = { source: 'unresolved', freshnessTs: null };
      continue;
    }

    // A UE asset path ("/Game/...", "/Engine/...") points at a compiled .uasset,
    // not a sibling .matgraph.json. Pin signatures come from a crawl index keyed by
    // asset path: official /Engine MFs from the committed engine-MF index, the user's
    // own /Game MFs from the local work-MF index. Anything else is a relative
    // .matgraph.json handled by the filesystem branch below.
    if (relPath.startsWith('/') && !relPath.endsWith('.matgraph.json')) {
      const fromEngine = relPath.startsWith('/Engine/');
      const index = fromEngine ? (opts.engineMfIndex ?? null) : (opts.workMfIndex ?? null);
      const pins = deriveWorkMfPins(index, relPath);
      if (pins) {
        derivedPins[node.id] = pins;
        const source: NodeSource = fromEngine ? 'enginemf' : 'workmf';
        const freshnessKey: keyof CrawlFreshness = fromEngine ? 'enginemf' : 'workmf';
        nodeProvenance[node.id] = { source, freshnessTs: opts.freshnessMap?.[freshnessKey] ?? null };
      } else {
        warnings.push(
          fromEngine
            ? `MFC "${node.id}": official MF not in engine index: ${relPath} (regenerate agent-pack/enginemf-index-ue5.7.json via Run-EngineMfIndex.ps1)`
            : `MFC "${node.id}": work MF not in index: ${relPath} (run WorkMF discover)`,
        );
        derivedPins[node.id] = { inputs: [], outputs: [] };
        nodeProvenance[node.id] = { source: 'unresolved', freshnessTs: null };
      }
      continue;
    }

    const absPath = resolve(graphDir, relPath);
    if (visited.has(absPath)) {
      warnings.push(`circular reference detected at MFC "${node.id}" → ${relPath}`);
      derivedPins[node.id] = { inputs: [], outputs: [] };
      nodeProvenance[node.id] = { source: 'unresolved', freshnessTs: null };
      continue;
    }
    const loaded = await loadGraph(absPath);
    if (!loaded.graph) {
      warnings.push(`MFC "${node.id}": MaterialFunction not found: ${relPath}`);
      derivedPins[node.id] = { inputs: [], outputs: [] };
      nodeProvenance[node.id] = { source: 'unresolved', freshnessTs: null };
      continue;
    }
    if (loaded.graph.type !== 'MaterialFunction') {
      warnings.push(`MFC "${node.id}": expected MaterialFunction, got ${loaded.graph.type}`);
      derivedPins[node.id] = { inputs: [], outputs: [] };
      nodeProvenance[node.id] = { source: 'unresolved', freshnessTs: null };
      continue;
    }
    const nextVisited = new Set(visited);
    nextVisited.add(absPath);
    const subResolved = await resolveMaterialFunctions(loaded.graph, dirname(absPath), nextVisited, opts);
    warnings.push(...subResolved.warnings);
    // Keep pins for MaterialFunctionCalls nested inside this MF too. The map is
    // flat (keyed by node.id, unique only within a file), so first writer wins on
    // a rare cross-file id clash — strictly better than dropping them.
    for (const [id, pins] of Object.entries(subResolved.derivedPins)) {
      if (!(id in derivedPins)) derivedPins[id] = pins;
    }
    for (const [id, prov] of Object.entries(subResolved.nodeProvenance)) {
      if (!(id in nodeProvenance)) nodeProvenance[id] = prov;
    }

    derivedPins[node.id] = {
      inputs: loaded.graph.nodes
        .filter(n => n.type === 'FunctionInput')
        .map(n => ({
          name: (n.params?.InputName as string | undefined) ?? '(unnamed)',
          type: typeMapForInput(n.params?.InputType as string | undefined),
        })),
      outputs: loaded.graph.nodes
        .filter(n => n.type === 'FunctionOutput')
        .map(n => ({
          name: (n.params?.OutputName as string | undefined) ?? '(unnamed)',
          type: typeMapForInput(n.params?.OutputType as string | undefined),
        })),
    };
    // Sibling .matgraph.json MFs are tagged as 'projectmat' source (they come from
    // the project materials crawl). The freshnessTs comes from the projectmat key.
    nodeProvenance[node.id] = {
      source: 'projectmat',
      freshnessTs: opts.freshnessMap?.projectmat ?? null,
    };
  }

  return { graph, derivedPins, warnings, nodeProvenance };
}

function typeMapForInput(uiType?: string): string {
  switch (uiType) {
    case 'Scalar':         return 'Float1';
    case 'VectorFloat2':   return 'Float2';
    case 'VectorFloat3':   return 'Float3';
    case 'VectorFloat4':   return 'Float4';
    case 'Texture2D':      return 'Texture2D';
    default:               return 'Float3';
  }
}

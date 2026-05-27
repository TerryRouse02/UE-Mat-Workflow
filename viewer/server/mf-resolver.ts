import { resolve, dirname } from 'node:path';
import type { MatGraph } from './types.js';
import { loadGraph } from './graph-loader.js';

export interface DerivedPins {
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
}

export interface ResolvedGraph {
  graph: MatGraph;
  derivedPins: Record<string, DerivedPins>;
  warnings: string[];
}

export async function resolveMaterialFunctions(
  graph: MatGraph,
  graphDir: string,
  visited: Set<string> = new Set(),
): Promise<ResolvedGraph> {
  const derivedPins: Record<string, DerivedPins> = {};
  const warnings: string[] = [];

  for (const node of graph.nodes) {
    if (node.type !== 'MaterialFunctionCall') continue;
    const relPath = (node.params?.MaterialFunction as string | undefined) ?? '';
    if (!relPath) {
      warnings.push(`MFC "${node.id}": params.MaterialFunction missing`);
      derivedPins[node.id] = { inputs: [], outputs: [] };
      continue;
    }
    const absPath = resolve(graphDir, relPath);
    if (visited.has(absPath)) {
      warnings.push(`circular reference detected at MFC "${node.id}" → ${relPath}`);
      derivedPins[node.id] = { inputs: [], outputs: [] };
      continue;
    }
    const loaded = await loadGraph(absPath);
    if (!loaded.graph) {
      warnings.push(`MFC "${node.id}": MaterialFunction not found: ${relPath}`);
      derivedPins[node.id] = { inputs: [], outputs: [] };
      continue;
    }
    if (loaded.graph.type !== 'MaterialFunction') {
      warnings.push(`MFC "${node.id}": expected MaterialFunction, got ${loaded.graph.type}`);
      derivedPins[node.id] = { inputs: [], outputs: [] };
      continue;
    }
    const nextVisited = new Set(visited);
    nextVisited.add(absPath);
    const subResolved = await resolveMaterialFunctions(loaded.graph, dirname(absPath), nextVisited);
    warnings.push(...subResolved.warnings);

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
          type: 'Float3',
        })),
    };
  }

  return { graph, derivedPins, warnings };
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

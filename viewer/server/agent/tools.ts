// server/agent/tools.ts — 8 tool definitions + dispatch for the material agent.
// All tools catch internal throws and convert them to {content, isError:true}.

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve, join, sep, dirname } from 'node:path';
import type { ToolDef } from './provider/types.js';
import { validateGraph, materialStructureWarnings } from '../schema.js';
import { loadGraph } from '../graph-loader.js';
import { resolveMaterialFunctions } from '../mf-resolver.js';
import { loadWorkMfIndex } from '../workmf-index.js';
import { applyPatch, type PatchOp } from './patch.js';
import * as QB from './query-bridge.js';

// ---------------------------------------------------------------------------
// ToolContext
// ---------------------------------------------------------------------------

export interface ToolContext {
  repoRoot: string;
  graphsRoot: string;            // resolve(repoRoot, 'graphs')
  ueVersion: string;             // session version — all DB lookups use this
  workMfIndexPath?: string;      // server-only; absent → work MFs unavailable
  beforeWrite?: (absPath: string) => Promise<void>;  // M2 checkpoint hook
}

// ---------------------------------------------------------------------------
// Reserved types not in DB
// ---------------------------------------------------------------------------

const RESERVED_TYPES = new Set([
  'MaterialOutput',
  'FunctionInput',
  'FunctionOutput',
  'MaterialFunctionCall',
]);

// ---------------------------------------------------------------------------
// Path guard
// ---------------------------------------------------------------------------

function isInside(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(r + sep);
}

/**
 * Validate and resolve a graph path.
 * - input must be relative
 * - must end with '.matgraph.json'
 * - resolved path must be inside graphsRoot
 */
function guardPath(input: unknown, graphsRoot: string): { abs: string } | { error: string } {
  if (typeof input !== 'string') {
    return { error: 'path must be a string' };
  }
  if (input.startsWith('/') || input.startsWith('\\')) {
    return { error: 'path must be relative, not absolute' };
  }
  if (!input.endsWith('.matgraph.json')) {
    return { error: 'path must end with ".matgraph.json"' };
  }
  const abs = resolve(graphsRoot, input);
  if (!isInside(graphsRoot, abs)) {
    return { error: 'path escapes graphs root (directory traversal rejected)' };
  }
  return { abs };
}

// ---------------------------------------------------------------------------
// Version DB lookup (node type validation)
// ---------------------------------------------------------------------------

function loadVersionDb(repoRoot: string, version: string): Record<string, unknown> | null {
  try {
    return QB.loadNodesDb(repoRoot, version).nodes;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared validation + MF resolution used by write_graph, patch_graph, validate_graph
// ---------------------------------------------------------------------------

interface ValidationReport {
  errors: string[];
  warnings: string[];
  unresolvedPins: string[];
}

async function runValidationGate(
  graph: unknown,
  graphDir: string,
  ctx: ToolContext,
): Promise<ValidationReport> {
  const { errors, graph: validGraph } = validateGraph(graph);

  if (!validGraph) {
    return { errors, warnings: [], unresolvedPins: [] };
  }

  const structWarnings = materialStructureWarnings(validGraph);

  // Check all node types exist in DB or are reserved. A DB that fails to load
  // must fail the gate loudly — silently skipping this check would let invalid
  // node types reach disk whenever the version DB is absent or unreadable.
  const nodesMap = loadVersionDb(ctx.repoRoot, ctx.ueVersion);
  if (nodesMap === null) {
    errors.push(`node DB for ueVersion ${ctx.ueVersion} could not be loaded — cannot validate node types`);
  } else {
    const unknownTypes: string[] = [];
    for (const n of validGraph.nodes) {
      if (!RESERVED_TYPES.has(n.type) && !Object.prototype.hasOwnProperty.call(nodesMap, n.type)) {
        unknownTypes.push(n.type);
      }
    }
    if (unknownTypes.length > 0) {
      errors.push(`unknown node types for ueVersion ${ctx.ueVersion}: ${unknownTypes.join(', ')}`);
    }
  }

  if (errors.length > 0) {
    return { errors, warnings: structWarnings, unresolvedPins: [] };
  }

  // MF resolution
  const { index: workMfIndex } = ctx.workMfIndexPath
    ? await loadWorkMfIndex(ctx.workMfIndexPath)
    : { index: null };
  const engineMfIndexPath = join(ctx.repoRoot, 'agent-pack', `enginemf-index-ue${ctx.ueVersion}.json`);
  const { index: engineMfIndex } = await loadWorkMfIndex(engineMfIndexPath);

  const resolved = await resolveMaterialFunctions(validGraph, graphDir, new Set(), {
    workMfIndex,
    engineMfIndex,
  });

  const unresolvedPins: string[] = [];
  for (const w of resolved.warnings) {
    if (w.includes('not in') || w.includes('not found') || w.includes('unresolved') || w.includes('missing')) {
      unresolvedPins.push(w);
    }
  }

  return {
    errors,
    warnings: [...structWarnings, ...resolved.warnings.filter(w => !unresolvedPins.includes(w))],
    unresolvedPins,
  };
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

async function atomicWrite(absPath: string, content: string): Promise<void> {
  const tmpPath = absPath + '.tmp.' + process.pid + '.' + Date.now();
  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(tmpPath, content, 'utf-8');
  await rename(tmpPath, absPath);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const toolDefs: ToolDef[] = [
  {
    name: 'search_nodes',
    description:
      'Search the UE node DB for expressions matching the query terms. Returns name/category/description. ' +
      'Verified nodes appear first; unverified entries include a ⚠ unverified marker but are never hidden. ' +
      'Use this before get_node_signature to choose the right node type.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms (space-separated or a single phrase)' },
        category: { type: 'string', description: 'Optional: filter by exact category name' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_node_signature',
    description:
      'Return the full DB entry for a node type: inputs, outputs, params, pinInfo. ' +
      'On miss, returns an error with suggestions. Always call this before writing a connection.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact node type name (e.g. "Multiply", "Lerp")' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_mf_signature',
    description:
      'Return pin signature for a Material Function by UE asset path. ' +
      '/Engine/... paths use the engine MF index; all others use the work MF index. ' +
      'On miss, returns a crawl hint — NEVER invent pin names.',
    inputSchema: {
      type: 'object',
      properties: {
        assetPath: { type: 'string', description: 'UE asset path e.g. "/Engine/Functions/MF_Foo.MF_Foo"' },
      },
      required: ['assetPath'],
    },
  },
  {
    name: 'read_graph',
    description:
      'Read and validate an existing .matgraph.json. Returns the graph JSON plus any errors/warnings. ' +
      'Call this before patch_graph to get the current on-disk state.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within graphs/ ending in .matgraph.json' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_graph',
    description:
      'Write a complete .matgraph.json. Validates before writing; never writes an invalid graph. ' +
      'All node types must exist in the version DB or be reserved types. ' +
      'Use for initial creation; use patch_graph for modifications.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within graphs/ ending in .matgraph.json' },
        graph: { type: 'object', description: 'Complete matgraph object' },
      },
      required: ['path', 'graph'],
    },
  },
  {
    name: 'patch_graph',
    description:
      'Apply a list of patch ops to an existing .matgraph.json. Validates after applying; ' +
      'never writes if validation fails. Returns diff lines on success.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within graphs/ ending in .matgraph.json' },
        ops: {
          type: 'array',
          description: 'Ordered list of patch operations',
          items: { type: 'object' },
        },
      },
      required: ['path', 'ops'],
    },
  },
  {
    name: 'validate_graph',
    description:
      'Validate a graph (by path or inline object) and return errors, warnings, and unresolved MF pins. ' +
      'Never writes anything.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to an existing .matgraph.json' },
        graph: { type: 'object', description: 'Inline graph object (alternative to path)' },
      },
    },
  },
  {
    name: 'get_graph_errors',
    description:
      'Load an existing .matgraph.json and return its current errors, warnings, and unresolved MF pins. ' +
      'Use for debugging existing files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within graphs/ ending in .matgraph.json' },
      },
      required: ['path'],
    },
  },
];

// ---------------------------------------------------------------------------
// dispatchTool
// ---------------------------------------------------------------------------

export async function dispatchTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  try {
    return await _dispatch(name, input, ctx);
  } catch (e) {
    return { content: (e instanceof Error ? e.message : String(e)), isError: true };
  }
}

async function _dispatch(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const inp = (input ?? {}) as Record<string, unknown>;

  switch (name) {
    case 'search_nodes':    return toolSearchNodes(inp, ctx);
    case 'get_node_signature': return toolGetNodeSignature(inp, ctx);
    case 'get_mf_signature':   return toolGetMfSignature(inp, ctx);
    case 'read_graph':      return toolReadGraph(inp, ctx);
    case 'write_graph':     return toolWriteGraph(inp, ctx);
    case 'patch_graph':     return toolPatchGraph(inp, ctx);
    case 'validate_graph':  return toolValidateGraph(inp, ctx);
    case 'get_graph_errors':return toolGetGraphErrors(inp, ctx);
    default:
      return { content: `unknown tool: ${name}`, isError: true };
  }
}

// ---------------------------------------------------------------------------
// search_nodes
// ---------------------------------------------------------------------------

const SEARCH_LINE_CAP = 40;

async function toolSearchNodes(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const query = String(inp.query ?? '');
  const category = inp.category != null ? String(inp.category) : undefined;

  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return { content: 'query must not be empty', isError: true };
  }

  let matches = QB.searchNodes(ctx.repoRoot, ctx.ueVersion, terms, category ? { category } : undefined);

  // Sort: verified first (stable within groups)
  const verified = matches.filter(m => m.verified);
  const unverified = matches.filter(m => !m.verified);
  matches = [...verified, ...unverified];

  if (matches.length === 0) {
    return { content: `No matches for: ${query}` };
  }

  const lines: string[] = [];
  const capped = matches.slice(0, SEARCH_LINE_CAP);
  for (const m of capped) {
    let line = m.line;
    if (!m.verified) {
      // Replace existing (unverified) marker with ⚠ marker
      line = line.replace(' (unverified)', '') + '  ⚠ unverified';
    }
    lines.push(line);
  }

  if (matches.length > SEARCH_LINE_CAP) {
    lines.push(`...${matches.length - SEARCH_LINE_CAP} more, narrow your query`);
  }

  return { content: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// get_node_signature
// ---------------------------------------------------------------------------

async function toolGetNodeSignature(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const name = String(inp.name ?? '');
  if (!name) return { content: 'name is required', isError: true };

  const { result, suggestions } = QB.getNodes(ctx.repoRoot, ctx.ueVersion, [name]);

  if (name in result) {
    return { content: JSON.stringify(result[name], null, 2) };
  }

  const sugg = suggestions[name] ?? [];
  const msg = sugg.length > 0
    ? `"${name}" not found. Did you mean: ${sugg.join(', ')}?`
    : `"${name}" not found.`;
  return { content: msg, isError: true };
}

// ---------------------------------------------------------------------------
// get_mf_signature
// ---------------------------------------------------------------------------

async function toolGetMfSignature(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const assetPath = String(inp.assetPath ?? '');
  if (!assetPath) return { content: 'assetPath is required', isError: true };

  const mfResult = QB.getMf(ctx.repoRoot, assetPath, ctx.ueVersion, ctx.workMfIndexPath);

  if (mfResult.found) {
    return { content: JSON.stringify(mfResult.entry, null, 2) };
  }

  // Not found — give crawl hint, never invent pin names
  const isEngine = assetPath.startsWith('/Engine/');
  const crawlType = isEngine ? 'Engine MF crawl' : 'WorkMF crawl';
  const msg = mfResult.reason === 'index-absent'
    ? `MF index not found — run the ${crawlType} from the viewer's Config tab, then retry. NEVER invent pin names.`
    : `"${assetPath}" not in the MF index — run the ${crawlType} from the viewer's Config tab, then retry. NEVER invent pin names.`;
  return { content: msg, isError: true };
}

// ---------------------------------------------------------------------------
// read_graph
// ---------------------------------------------------------------------------

async function toolReadGraph(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const guard = guardPath(inp.path, ctx.graphsRoot);
  if ('error' in guard) return { content: guard.error, isError: true };

  const loaded = await loadGraph(guard.abs);

  if (!loaded.graph) {
    return { content: JSON.stringify({ errors: loaded.errors }), isError: true };
  }

  const structWarnings = materialStructureWarnings(loaded.graph);

  const { index: workMfIndex } = ctx.workMfIndexPath
    ? await loadWorkMfIndex(ctx.workMfIndexPath)
    : { index: null };
  const engineMfIndexPath = join(ctx.repoRoot, 'agent-pack', `enginemf-index-ue${ctx.ueVersion}.json`);
  const { index: engineMfIndex } = await loadWorkMfIndex(engineMfIndexPath);

  const resolved = await resolveMaterialFunctions(loaded.graph, dirname(guard.abs), new Set(), {
    workMfIndex,
    engineMfIndex,
  });

  const unresolved = resolved.warnings.filter(
    w => w.includes('not in') || w.includes('not found') || w.includes('unresolved') || w.includes('missing'),
  );

  return {
    content: JSON.stringify({
      graph: loaded.graph,
      errors: loaded.errors,
      warnings: [...structWarnings, ...resolved.warnings.filter(w => !unresolved.includes(w))],
      unresolvedMfPins: unresolved,
    }, null, 2),
  };
}

// ---------------------------------------------------------------------------
// write_graph
// ---------------------------------------------------------------------------

async function toolWriteGraph(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const guard = guardPath(inp.path, ctx.graphsRoot);
  if ('error' in guard) return { content: guard.error, isError: true };

  const graph = inp.graph;
  if (!graph || typeof graph !== 'object') {
    return { content: 'graph must be an object', isError: true };
  }

  // Version check
  const g = graph as Record<string, unknown>;
  if (g.ueVersion !== ctx.ueVersion) {
    return {
      content: `graph.ueVersion "${g.ueVersion}" does not match session ueVersion "${ctx.ueVersion}"`,
      isError: true,
    };
  }

  const report = await runValidationGate(graph, dirname(guard.abs), ctx);

  if (report.errors.length > 0) {
    return {
      content: JSON.stringify({ errors: report.errors, warnings: report.warnings }),
      isError: true,
    };
  }

  // Clean — write
  await ctx.beforeWrite?.(guard.abs);
  await atomicWrite(guard.abs, JSON.stringify(graph, null, 2) + '\n');

  return {
    content: JSON.stringify({
      ok: true,
      warnings: report.warnings,
      unresolvedMfPins: report.unresolvedPins,
    }),
  };
}

// ---------------------------------------------------------------------------
// patch_graph
// ---------------------------------------------------------------------------

async function toolPatchGraph(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const guard = guardPath(inp.path, ctx.graphsRoot);
  if ('error' in guard) return { content: guard.error, isError: true };

  // File must exist
  const loaded = await loadGraph(guard.abs);
  if (!loaded.graph) {
    return {
      content: JSON.stringify({ errors: loaded.errors }),
      isError: true,
    };
  }

  const ops = inp.ops;
  if (!Array.isArray(ops)) {
    return { content: 'ops must be an array', isError: true };
  }

  // Apply patch
  const patchResult = applyPatch(loaded.graph, ops as PatchOp[]);
  if (!patchResult.ok) {
    return {
      content: JSON.stringify({ opIndex: patchResult.opIndex, applyError: patchResult.applyError }),
      isError: true,
    };
  }

  // Validate result
  const report = await runValidationGate(patchResult.graph, dirname(guard.abs), ctx);

  if (report.errors.length > 0) {
    return {
      content: JSON.stringify({ opIndex: null, validateErrors: report.errors }),
      isError: true,
    };
  }

  // Clean — write
  await ctx.beforeWrite?.(guard.abs);
  await atomicWrite(guard.abs, JSON.stringify(patchResult.graph, null, 2) + '\n');

  return {
    content: JSON.stringify({
      ok: true,
      diff: patchResult.diff,
      warnings: report.warnings,
      unresolvedMfPins: report.unresolvedPins,
    }),
  };
}

// ---------------------------------------------------------------------------
// validate_graph
// ---------------------------------------------------------------------------

async function toolValidateGraph(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  let graphData: unknown;
  let graphDir: string;

  if (inp.path != null) {
    const guard = guardPath(inp.path, ctx.graphsRoot);
    if ('error' in guard) return { content: guard.error, isError: true };
    const loaded = await loadGraph(guard.abs);
    graphData = loaded.graph ?? null;
    graphDir = dirname(guard.abs);
    if (!loaded.graph) {
      return { content: JSON.stringify({ errors: loaded.errors }), isError: true };
    }
  } else if (inp.graph != null) {
    graphData = inp.graph;
    graphDir = ctx.graphsRoot;
  } else {
    return { content: 'provide either path or graph', isError: true };
  }

  const report = await runValidationGate(graphData, graphDir, ctx);

  return {
    content: JSON.stringify({
      errors: report.errors,
      warnings: report.warnings,
      unresolvedMfPins: report.unresolvedPins,
    }),
  };
}

// ---------------------------------------------------------------------------
// get_graph_errors
// ---------------------------------------------------------------------------

async function toolGetGraphErrors(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const guard = guardPath(inp.path, ctx.graphsRoot);
  if ('error' in guard) return { content: guard.error, isError: true };

  const loaded = await loadGraph(guard.abs);
  if (!loaded.graph) {
    return {
      content: JSON.stringify({ errors: loaded.errors }),
      isError: true,
    };
  }

  const report = await runValidationGate(loaded.graph, dirname(guard.abs), ctx);

  return {
    content: JSON.stringify({
      errors: report.errors,
      warnings: report.warnings,
      unresolvedMfPins: report.unresolvedPins,
    }),
  };
}

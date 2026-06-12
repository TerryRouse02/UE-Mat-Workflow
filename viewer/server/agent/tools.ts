// server/agent/tools.ts — tool definitions + dispatch for the material agent.
// (compact_context is defined here but dispatched inside loop.ts — it needs the session.)
// All tools catch internal throws and convert them to {content, isError:true}.

import { mkdir, rename, writeFile, readdir, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { resolve, join, sep, dirname, basename, relative } from 'node:path';
import type { ToolDef } from './provider/types.js';
import { validateGraph, materialStructureWarnings } from '../schema.js';
import { loadGraph } from '../graph-loader.js';
import { resolveMaterialFunctions } from '../mf-resolver.js';
import { loadWorkMfIndex } from '../workmf-index.js';
import { probeEnv } from '../crawl-env.js';
import { applyPatch, changedNodeIds, type PatchOp, type PinLookup } from './patch.js';
import { connectionPinErrors } from './pin-validate.js';
import type { MemoryStore, MemoryScope } from './memory-store.js';
import { fetchPublic, htmlToText, webSearch, WEB_TEXT_CAP, type WebDeps } from './web-tools.js';
import { validateDbEditPatch, validateDbCreate, DB_EDIT_KEYS } from './db-edit.js';
import * as QB from './query-bridge.js';

// ---------------------------------------------------------------------------
// ToolContext
// ---------------------------------------------------------------------------

export interface ToolContext {
  repoRoot: string;
  graphsRoot: string;            // resolve(repoRoot, 'graphs')
  /**
   * Team-mode member sessions: 'users/<username>' — NEW graphs written
   * outside users/ are rerouted into this personal workspace so a member's
   * creations do not land in the shared root. Edits to existing files keep
   * their path (the beforeWrite guard still blocks foreign personal dirs).
   */
  personalRoot?: string;
  ueVersion: string;             // session version — all DB lookups use this
  workMfIndexPath?: string;      // server-only; absent → work MFs unavailable
  /**
   * M2 checkpoint hook — called before any write to absPath.
   * turnId identifies the LLM iteration so the HTTP server can group
   * multiple writes in one assistant response under one undo step.
   * Tools always supply a turnId (injected by the loop via callCtx);
   * callers that do not need per-turn grouping may omit it.
   */
  beforeWrite?: (absPath: string, turnId: string) => Promise<void>;
  /**
   * M7b two-layer memory (session + longterm). Absent → the memory tools
   * report themselves unavailable instead of failing silently.
   */
  memory?: MemoryStore;
  /** Injectable network deps for web_search / web_fetch (tests). */
  web?: WebDeps;
  /** Injectable env probe for request_crawl (tests — the real probe needs a UE install). */
  probeEnvFn?: typeof probeEnv;
  /**
   * Tail of the most recently finished crawl (read_crawl_log tool) — wired to
   * the crawl runner's lastLog() by the HTTP server. Absent → tool unavailable.
   */
  getCrawlLog?: () => {
    kind: string;
    status: 'success' | 'error';
    exitCode: number | null;
    lines: string[];
  } | null;
  /**
   * What the user is looking at right now (open graph + selected node), sent
   * by the web UI with each chat request. Read ON DEMAND via the get_viewport
   * tool — it is deliberately NOT injected into the prompt, so an open file
   * never biases a「建立」(create) request into modifying it.
   */
  viewport?: { graphPath?: string; selectedNodeId?: string };
  /**
   * Absolute paths of graphs CREATED by this conversation. write_graph may
   * freely rewrite these; any other existing file is refused unless the model
   * passes overwrite:true (reserved for an explicit user request). Owned by
   * the session (the HTTP server keeps it on the ActiveSession).
   */
  sessionCreatedPaths?: Set<string>;
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
 * Real (symlink-resolved) location of `abs`: realpath of its nearest EXISTING
 * ancestor with the not-yet-existing suffix re-attached (non-existent segments
 * cannot be symlinks). Falls back to `abs` if nothing up to the fs root
 * resolves — the lexical containment check has already run by then.
 */
async function realpathNearest(abs: string): Promise<string> {
  let cur = abs;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(cur);
      return tail.length > 0 ? join(real, ...tail) : real;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;
      tail.unshift(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Validate and resolve a graph path.
 * - input must be relative
 * - must end with '.matgraph.json'
 * - resolved path must be inside graphsRoot
 * - the REAL path (symlinks resolved, for the target and every existing
 *   ancestor) must also be inside graphsRoot — a symlink planted under
 *   graphs/ must not let reads/writes/deletes escape the tree
 */
async function guardPath(input: unknown, graphsRoot: string): Promise<{ abs: string } | { error: string }> {
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
  // Compare real-to-real so a graphsRoot that itself sits behind a symlink
  // (e.g. macOS /var → /private/var tmp dirs) still matches.
  const realRoot = await realpathNearest(resolve(graphsRoot));
  const realAbs = await realpathNearest(abs);
  if (!isInside(realRoot, realAbs)) {
    return { error: 'path escapes graphs root (symlink traversal rejected)' };
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

/**
 * insertNode pin inference source: DB pin names in declaration order.
 * Returns null (= explicit pins required) for reserved types, dynamic-pin
 * nodes and anything not in the DB — mirroring pin-validate's skip rules.
 */
function makePinLookup(nodesMap: Record<string, unknown> | null): PinLookup {
  return (type: string) => {
    if (nodesMap === null || RESERVED_TYPES.has(type)) return null;
    const def = nodesMap[type] as {
      inputs?: Array<{ name?: unknown }>;
      outputs?: Array<{ name?: unknown }>;
      dynamicPins?: boolean;
    } | undefined;
    if (!def || def.dynamicPins) return null;
    return {
      inputs: (def.inputs ?? []).map(p => String(p.name)),
      outputs: (def.outputs ?? []).map(p => String(p.name)),
    };
  };
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
    // Pin-existence check against the DB signatures (mirrors the viewer's
    // validateConnectionPins) — an invented pin name on a regular node must
    // fail the gate, not land on disk with ok:true. Unknown-type and
    // dynamic-pin nodes are skipped (reported above / unverifiable).
    errors.push(...connectionPinErrors(validGraph, nodesMap));
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
  try {
    await rename(tmpPath, absPath);
  } catch (err) {
    // A failed rename must not leave the .tmp file behind in graphs/.
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
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
      'Call this before patch_graph to get the current on-disk state. ' +
      'For LARGE graphs, pass summary:true first — it returns only node ids/types + connection count ' +
      '(an order of magnitude smaller); read the full graph only when you actually need params/connections.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within graphs/ ending in .matgraph.json' },
        summary: { type: 'boolean', description: 'true = node ids/types + counts only, no params/connections' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_graph',
    description:
      'Write a complete .matgraph.json. Validates before writing; never writes an invalid graph. ' +
      'All node types must exist in the version DB or be reserved types. ' +
      'Use for INITIAL CREATION at a path that does not exist yet; use patch_graph for modifications. ' +
      'Refuses to overwrite a pre-existing file unless this conversation created it, or overwrite:true ' +
      'is set — which is allowed ONLY after the user explicitly asked to rebuild that exact file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within graphs/ ending in .matgraph.json' },
        graph: { type: 'object', description: 'Complete matgraph object' },
        overwrite: { type: 'boolean', description: 'Allow replacing a pre-existing file. Only set this after the user explicitly confirmed rebuilding that exact file.' },
      },
      required: ['path', 'graph'],
    },
  },
  {
    name: 'patch_graph',
    description:
      'Incrementally edit an existing .matgraph.json with an ordered list of ops — ALWAYS prefer ' +
      'this over write_graph for modifications. The whole list applies atomically: nothing is ' +
      'written unless every op succeeds AND the result validates. On failure, applyErrors lists ' +
      'EVERY failing op (opIndex + message) — fix them all and resubmit once, do not retry one ' +
      'error at a time. Returns plain-language diff lines on success. Supported ops:\n' +
      '- {op:"addNode", id?, type, params?} — add a node. Omit id to auto-generate one (returned ' +
      'in assignedIds keyed by op index); give an explicit id when a later op in the SAME batch ' +
      'references the node. Explicit ids must be new and contain no ":".\n' +
      '- {op:"insertNode", between:{from:"nodeId:pin", to:"nodeId:pin"}, type, id?, params?, ' +
      'inputPin?, outputPin?} — splice a new node into an EXISTING connection in ONE op ' +
      '(replaces disconnect + addNode + connect×2). Omitted pins are inferred from the type\'s ' +
      'DB signature (first input / first output pin); dynamic-pin and MaterialFunctionCall ' +
      'types need explicit inputPin + outputPin.\n' +
      '- {op:"removeNode", id, heal?, healFrom?} — remove a node AND all its connections ' +
      '(cascades — never disconnect first). heal:true additionally splices the node\'s upstream ' +
      'source onto every pin the node fed, keeping the chain intact; when several input pins ' +
      'are wired, healFrom:"<inputPin>" picks the surviving source. Refused when the node feeds ' +
      'downstream from more than one output pin (rewire manually).\n' +
      '- {op:"setParam", id, key, value} — set/overwrite one param on a node\n' +
      '- {op:"removeParam", id, key} — delete one param from a node\n' +
      '- {op:"setNodeType", id, type} — swap a node\'s type in place (connections/params kept; pins ' +
      're-validated). Use this to replace a node — do NOT removeNode + addNode + rewire.\n' +
      '- {op:"renameNode", id, newId} — rename a node, rewriting all its connections\n' +
      '- {op:"connect", from:"nodeId:pin", to:"nodeId:pin"} — add a connection (target input pin must be free)\n' +
      '- {op:"disconnect", from:"nodeId:pin", to:"nodeId:pin"} — remove a connection\n' +
      '- {op:"setDescription", value} — set the graph description\n' +
      'snake_case aliases (add_node, add_connection, set_param, …) are also accepted. ' +
      'Every op may carry an optional why:"…" string that shows up in the user-facing diff. ' +
      'Set dryRun:true to preview: applies + validates and returns the same diff/warnings, but ' +
      'writes nothing — useful to check a large batch before committing it.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within graphs/ ending in .matgraph.json' },
        ops: {
          type: 'array',
          description: 'Ordered patch operations — see the tool description for each op\'s fields',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: [
                  'addNode', 'insertNode', 'removeNode', 'setParam', 'removeParam', 'setNodeType',
                  'renameNode', 'connect', 'disconnect', 'setDescription',
                ],
                description: 'Operation kind',
              },
            },
            required: ['op'],
          },
        },
        dryRun: {
          type: 'boolean',
          description: 'true = validate and return the diff WITHOUT writing the file',
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
  {
    name: 'list_graphs',
    description:
      'List every .matgraph.json under graphs/ with its material name and type. ' +
      'Use this FIRST when the user refers to an existing material and you do not know its path.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_viewport',
    description:
      'Get what the user is currently looking at in the viewer: the open graph path and the ' +
      'selected node id (null when nothing is open/selected). Call this when the user refers to ' +
      '「目前的圖」「這個節點」"this graph"/"this node". An open graph is CONTEXT, not a target: ' +
      'never modify it unless the user asked to change it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_mf',
    description:
      'Search Material Functions by keyword across the engine MF index and the project (work) MF index. ' +
      'Returns asset paths with pin counts. Follow up with get_mf_signature for the full pin names.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms (space-separated), matched against path/name/category' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_examples',
    description:
      'List the shipped reference example projects (agent-pack/examples). ' +
      'Each is a known-good .matgraph.json project to use as a pattern.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_example',
    description:
      'Read one shipped example project (all of its .matgraph.json files). ' +
      'Use as a reference pattern before authoring a similar material.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Example folder name from list_examples (e.g. "01_basic_pbr")' },
      },
      required: ['name'],
    },
  },
  {
    name: 'read_memory',
    description:
      'Read your local memory notes. scope "session" = notes for THIS conversation; ' +
      'scope "longterm" = user preferences and facts that persist across all conversations. ' +
      'Both are also injected into your system prompt each turn.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['session', 'longterm'], description: 'Which memory layer to read' },
      },
      required: ['scope'],
    },
  },
  {
    name: 'update_memory',
    description:
      'Write your local memory notes. Use scope "longterm" for durable user preferences ' +
      '(favorite UE version, naming style, brightness taste); scope "session" for working ' +
      'notes about THIS conversation. op "append" adds a block; op "replace" rewrites the ' +
      'whole file (use it to condense when the size cap is hit). Keep notes short.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['session', 'longterm'], description: 'Which memory layer to write' },
        op: { type: 'string', enum: ['append', 'replace'], description: 'append a block or replace the file' },
        content: { type: 'string', description: 'The note content (markdown, keep concise)' },
      },
      required: ['scope', 'op', 'content'],
    },
  },
  {
    name: 'compact_context',
    description:
      'Summarize the older turns of THIS conversation into session memory and trim them from the ' +
      'context window, freeing room for long sessions. The most recent turns are always kept. ' +
      'Call this when the user asks to compact/壓縮 the conversation, or when the history has grown ' +
      'very long. The summary is auto-injected into your system prompt afterwards, so nothing ' +
      'important is lost.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'report_off_topic',
    description:
      'Report that the user\'s latest message is UNRELATED to UE materials, shaders, textures, ' +
      'game art / game development, or using this tool (related math/color/graphics fundamentals ' +
      'count as ON topic). Call this INSTEAD of answering the off-topic content, then follow the ' +
      'instruction in the tool result. Strikes escalate: 1st = friendly reminder, 2nd = refuse and ' +
      'warn, 3rd = the server closes and deletes this session. When in doubt, do NOT call this — ' +
      'only clearly unrelated messages count.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'One short sentence (zh-TW) on why the message is off-topic' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'rename_graph',
    description:
      'Rename/move a .matgraph.json within graphs/. Undoable. References from OTHER graphs ' +
      '(MaterialFunctionCall relative paths) are NOT rewritten — check and patch them yourself ' +
      'if the renamed file is a MaterialFunction used elsewhere.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Existing relative path within graphs/' },
        to: { type: 'string', description: 'New relative path within graphs/, must not exist yet' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'delete_graph',
    description:
      'Delete a .matgraph.json from graphs/. Undoable (the pre-image is checkpointed). ' +
      'Confirm with the user before deleting anything you did not create this conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within graphs/ ending in .matgraph.json' },
      },
      required: ['path'],
    },
  },
  {
    name: 'export_to_clipboard',
    description:
      'Ask the viewer to copy the given graph to the user\'s clipboard as UE-pasteable T3D ' +
      '(same as the header 導出 button). The graph must be valid. The copy happens in the ' +
      'user\'s browser — tell the user to paste into UE\'s Material Editor with Ctrl+V. ' +
      'Use after finishing a material when the user wants it in UE.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within graphs/ ending in .matgraph.json' },
      },
      required: ['path'],
    },
  },
  {
    name: 'request_crawl',
    description:
      'PROPOSE a metadata crawl of the user\'s UE project (their /Game Material Functions or ' +
      'materials). This does NOT run anything: the user sees a confirmation card and must approve; ' +
      'the crawl launches the UE editor and takes minutes. Use when search_mf/list cannot find ' +
      'something the user says exists in their project. After calling this, END your turn and wait — ' +
      'never assume the crawl ran.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['workmf', 'projectmat'], description: 'workmf = index the project\'s Material Functions; projectmat = dump project materials' },
        contentRoot: { type: 'string', description: 'UE content root to crawl, default "/Game"' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'propose_db_edit',
    description:
      'PROPOSE a change to the public node DB (agent-pack/nodes-ue<v>.json): fix an EXISTING ' +
      'node entry (description/category/inputs/outputs/params/verified), or with create:true ADD ' +
      'a missing public UE node (forced verified:false until an export crawl supplies its ' +
      'metadata). This does NOT write anything: the user sees a confirmation card; on approval ' +
      'the server applies it, regenerates the index, and runs the parity audit (rolls back on ' +
      'failure). Proposing verified:true on an existing node = asking the user to attest they ' +
      'checked it in UE. ONLY clean public Epic/UE data may be proposed — never project-specific ' +
      'content. After calling this, END your turn and wait for the user.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeName: { type: 'string', description: 'Exact node type name' },
        patch: {
          type: 'object',
          description: `Fields to set. Allowed keys: ${DB_EDIT_KEYS.join(', ')}. inputs/outputs/params replace the whole list. With create:true, description/category/inputs/outputs are required.`,
        },
        rationale: { type: 'string', description: 'Why this is correct (cite the UE doc/source you verified against)' },
        create: { type: 'boolean', description: 'true = add a NEW node (must not exist yet); default false = edit an existing one' },
      },
      required: ['nodeName', 'patch', 'rationale'],
    },
  },
  {
    name: 'read_crawl_log',
    description:
      'Read the log tail of the most recently FINISHED metadata crawl (success or failure). ' +
      'Use to diagnose why a crawl failed or to verify what it found. Returns kind, status, ' +
      'exit code, and the last log lines.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: { type: 'number', description: 'How many trailing lines to return (default 60, max 200)' },
      },
    },
  },
  {
    name: 'web_search',
    description:
      'Search the public web. Returns {title, url, snippet} hits plus the backend used ' +
      '(user-configurable: Tavily / Brave / SearXNG, DuckDuckGo as the zero-key default with ' +
      'automatic fallback). Use when you need knowledge newer or more specific than you have — ' +
      'UE release notes, node behavior details, material techniques. ' +
      'Follow up with web_fetch to read a result.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description:
      'Fetch a public http(s) URL and return its readable text (HTML stripped, headings/lists kept ' +
      'as markdown markers, boilerplate nav/footer removed). Private/loopback addresses are blocked. ' +
      'Long pages are windowed: the result reports totalChars and nextOffset — call again with ' +
      'offset=nextOffset to read the next window. Use for UE documentation and pages found via web_search.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public http(s) URL' },
        offset: { type: 'number', description: 'Character offset into the extracted text (from a previous call\'s nextOffset). Default 0.' },
      },
      required: ['url'],
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
    case 'list_graphs':     return toolListGraphs(ctx);
    case 'get_viewport':    return toolGetViewport(ctx);
    case 'search_mf':       return toolSearchMf(inp, ctx);
    case 'list_examples':   return toolListExamples(ctx);
    case 'read_example':    return toolReadExample(inp, ctx);
    case 'read_memory':     return toolReadMemory(inp, ctx);
    case 'update_memory':   return toolUpdateMemory(inp, ctx);
    case 'rename_graph':    return toolRenameGraph(inp, ctx);
    case 'delete_graph':    return toolDeleteGraph(inp, ctx);
    case 'export_to_clipboard': return toolExportToClipboard(inp, ctx);
    case 'request_crawl':   return toolRequestCrawl(inp, ctx);
    case 'propose_db_edit': return toolProposeDbEdit(inp, ctx);
    case 'read_crawl_log':  return toolReadCrawlLog(inp, ctx);
    case 'web_search':      return toolWebSearch(inp, ctx);
    case 'web_fetch':       return toolWebFetch(inp, ctx);
    case 'compact_context':
      // Needs the live session/provider — the loop intercepts it before dispatch.
      return { content: 'compact_context 只能由代理迴圈執行。', isError: true };
    case 'report_off_topic':
      // Needs the session's strike counter — the loop intercepts it before dispatch.
      return { content: 'report_off_topic 只能由代理迴圈執行。', isError: true };
    default:
      return { content: `unknown tool: ${name}`, isError: true };
  }
}

// ---------------------------------------------------------------------------
// list_graphs / search_mf / list_examples / read_example (M9 discovery tools)
// ---------------------------------------------------------------------------

const LIST_GRAPHS_CAP = 200;

// On-demand viewport lookup (the grounding half of the create-vs-modify fix):
// the web UI sends the open graph + selected node with every chat request, the
// server caches it in ToolContext, and the model reads it only when it needs
// to resolve「目前/這個」— it is never injected into the prompt.
async function toolGetViewport(ctx: ToolContext): Promise<{ content: string; isError?: boolean }> {
  return {
    content: JSON.stringify({
      openGraphPath: ctx.viewport?.graphPath ?? null,
      selectedNodeId: ctx.viewport?.selectedNodeId ?? null,
    }),
  };
}

async function toolListGraphs(ctx: ToolContext): Promise<{ content: string; isError?: boolean }> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= LIST_GRAPHS_CAP) return;
      if (e.name.startsWith('.')) continue;
      // Never follow symlinks — a planted link must not let the walk (or the
      // later readFile) escape graphs/.
      if (e.isSymbolicLink()) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith('.matgraph.json')) files.push(p);
    }
  }
  await walk(ctx.graphsRoot);

  if (files.length === 0) {
    return { content: 'No .matgraph.json files under graphs/ yet.' };
  }

  const lines: string[] = [];
  for (const abs of files.sort()) {
    const rel = relative(ctx.graphsRoot, abs).split(sep).join('/');
    let info = '';
    try {
      const g = JSON.parse(await readFile(abs, 'utf-8')) as { name?: unknown; type?: unknown; ueVersion?: unknown };
      info = `  [${typeof g.type === 'string' ? g.type : '?'}]  ${typeof g.name === 'string' ? g.name : ''}  (ue${typeof g.ueVersion === 'string' ? g.ueVersion : '?'})`;
    } catch {
      info = '  [unparseable]';
    }
    lines.push(rel + info);
  }
  if (files.length >= LIST_GRAPHS_CAP) lines.push(`...capped at ${LIST_GRAPHS_CAP} files`);
  return { content: lines.join('\n') };
}

async function toolSearchMf(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const query = String(inp.query ?? '');
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    return { content: 'query must not be empty', isError: true };
  }

  const matches = QB.searchMf(ctx.repoRoot, terms, ctx.ueVersion, ctx.workMfIndexPath);
  if (matches.length === 0) {
    return { content: `No MF matches for: ${query}` };
  }

  const lines = matches.slice(0, SEARCH_LINE_CAP).map(m => m.line);
  if (matches.length > SEARCH_LINE_CAP) {
    lines.push(`...${matches.length - SEARCH_LINE_CAP} more, narrow your query`);
  }
  return { content: lines.join('\n') };
}

const EXAMPLE_NAME_RE = /^[A-Za-z0-9_-]+$/;
const EXAMPLE_TOTAL_CHAR_CAP = 30_000;

function examplesDir(ctx: ToolContext): string {
  return join(ctx.repoRoot, 'agent-pack', 'examples');
}

async function listExampleNames(ctx: ToolContext): Promise<string[]> {
  try {
    const entries = await readdir(examplesDir(ctx), { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch {
    return [];
  }
}

async function toolListExamples(ctx: ToolContext): Promise<{ content: string; isError?: boolean }> {
  const names = await listExampleNames(ctx);
  if (names.length === 0) {
    return { content: 'No examples found in agent-pack/examples.' };
  }
  const lines: string[] = [];
  for (const name of names) {
    let files: string[] = [];
    try {
      files = (await readdir(join(examplesDir(ctx), name))).filter(f => f.endsWith('.matgraph.json'));
    } catch { /* skip unreadable */ }
    lines.push(`${name}: ${files.join(', ') || '(no matgraph files)'}`);
  }
  return { content: lines.join('\n') };
}

async function toolReadExample(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const name = String(inp.name ?? '');
  if (!EXAMPLE_NAME_RE.test(name)) {
    return { content: 'invalid example name (letters/digits/underscore/dash only)', isError: true };
  }

  const dir = join(examplesDir(ctx), name);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    const names = await listExampleNames(ctx);
    return {
      content: `example "${name}" not found. Available: ${names.join(', ') || '(none)'}`,
      isError: true,
    };
  }

  const files = entries.filter(f => f.endsWith('.matgraph.json')).sort();
  if (files.length === 0) {
    return { content: `example "${name}" has no .matgraph.json files`, isError: true };
  }

  const parts: string[] = [];
  let total = 0;
  for (const f of files) {
    const text = await readFile(join(dir, f), 'utf-8');
    total += text.length;
    if (total > EXAMPLE_TOTAL_CHAR_CAP) {
      parts.push(`--- ${f} --- (omitted: example exceeds ${EXAMPLE_TOTAL_CHAR_CAP} chars)`);
      continue;
    }
    parts.push(`--- ${f} ---\n${text}`);
  }
  return { content: parts.join('\n') };
}

// ---------------------------------------------------------------------------
// read_memory / update_memory (M7b)
// ---------------------------------------------------------------------------

function parseScope(v: unknown): MemoryScope | null {
  return v === 'session' || v === 'longterm' ? v : null;
}

async function toolReadMemory(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  if (!ctx.memory) return { content: 'memory store unavailable in this context', isError: true };
  const scope = parseScope(inp.scope);
  if (!scope) return { content: 'scope must be "session" or "longterm"', isError: true };
  const content = await ctx.memory.read(scope);
  return { content: content || '(empty)' };
}

async function toolUpdateMemory(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  if (!ctx.memory) return { content: 'memory store unavailable in this context', isError: true };
  const scope = parseScope(inp.scope);
  if (!scope) return { content: 'scope must be "session" or "longterm"', isError: true };
  const op = inp.op;
  if (op !== 'append' && op !== 'replace') {
    return { content: 'op must be "append" or "replace"', isError: true };
  }
  const content = inp.content;
  if (typeof content !== 'string') {
    return { content: 'content must be a string', isError: true };
  }

  // Size-cap violations throw inside the store and surface as isError via
  // dispatchTool's catch — the model then condenses with op:"replace".
  if (op === 'append') await ctx.memory.append(scope, content);
  else await ctx.memory.replace(scope, content);

  return { content: JSON.stringify({ ok: true, scope, op }) };
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
  const guard = await guardPath(inp.path, ctx.graphsRoot);
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
  const warnings = [...structWarnings, ...resolved.warnings.filter(w => !unresolved.includes(w))];

  // summary mode: orientation without the payload — node ids/types and the
  // connection count, no params and no connection list. For big graphs this
  // is an order of magnitude smaller than the full read.
  if (inp.summary === true) {
    return {
      content: JSON.stringify({
        summary: true,
        name: loaded.graph.name,
        type: loaded.graph.type,
        nodeCount: loaded.graph.nodes.length,
        connectionCount: loaded.graph.connections.length,
        nodes: loaded.graph.nodes.map(n => ({ id: n.id, type: n.type })),
        errors: loaded.errors,
        warnings,
        unresolvedMfPins: unresolved,
      }),
    };
  }

  // Compact stringify on purpose: this payload lands in the conversation
  // history and is re-sent every iteration — pretty-print indentation alone
  // costs 20–30% extra tokens on large graphs.
  return {
    content: JSON.stringify({
      graph: loaded.graph,
      errors: loaded.errors,
      warnings,
      unresolvedMfPins: unresolved,
    }),
  };
}

// ---------------------------------------------------------------------------
// write_graph
// ---------------------------------------------------------------------------

async function toolWriteGraph(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  // Member personal workspace: a NEW file targeted outside users/ lands in
  // the member's own dir instead of the shared root. Existing files (and
  // explicit users/ paths) keep their address.
  if (ctx.personalRoot && typeof inp.path === 'string' && !inp.path.startsWith('users/')) {
    const sharedGuard = await guardPath(inp.path, ctx.graphsRoot);
    if (!('error' in sharedGuard)) {
      try {
        await readFile(sharedGuard.abs, 'utf-8'); // exists → keep shared path
      } catch {
        inp = { ...inp, path: `${ctx.personalRoot}/${inp.path}` };
      }
    }
  }

  const guard = await guardPath(inp.path, ctx.graphsRoot);
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

  // One pre-read serves the overwrite guard AND the changed-node highlight.
  // Only ENOENT means "new file"; any other failure (permissions, a directory
  // in the way) is a real I/O error and must surface, not pass as a fresh file.
  let oldRaw: string | null = null;
  try {
    oldRaw = await readFile(guard.abs, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return { content: `write_graph: cannot read existing file: ${(e as Error).message}`, isError: true };
    }
  }

  // HARD overwrite guard (the safety net behind the create/modify prompt
  // rules): an existing file this conversation did NOT create is only
  // rewritable with an explicit overwrite:true — which the model may set only
  // after the user asked for that exact file to be rebuilt.
  if (oldRaw !== null && inp.overwrite !== true && !ctx.sessionCreatedPaths?.has(guard.abs)) {
    return {
      content:
        `write_graph: 「${String(inp.path)}」已存在，且不是本次對話建立的檔案。` +
        '修改既有材質請改用 patch_graph；建立新材質請改用一個不存在的新路徑；' +
        '只有在使用者明確要求整檔重寫這個檔案時，才能帶 overwrite: true 重試。',
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

  // Changed nodes vs the previous on-disk version (for the canvas highlight):
  // new file (or unparseable old content) → every node; overwrite → nodes
  // that are new or differ from old.
  const newNodes = Array.isArray(g.nodes) ? (g.nodes as Array<{ id?: unknown }>) : [];
  let changed: string[];
  try {
    if (oldRaw === null) throw new Error('new file');
    const old = JSON.parse(oldRaw) as { nodes?: Array<{ id?: unknown }> };
    const oldById = new Map((old.nodes ?? []).map(n => [String(n.id), JSON.stringify(n)]));
    changed = newNodes
      .filter(n => oldById.get(String(n.id)) !== JSON.stringify(n))
      .map(n => String(n.id));
  } catch {
    changed = newNodes.map(n => String(n.id));
  }

  // Clean — write. The loop injects a callCtx wrapper that supplies the real
  // per-iteration turnId; the empty string here is never seen by the outer hook.
  await ctx.beforeWrite?.(guard.abs, '');
  await atomicWrite(guard.abs, JSON.stringify(graph, null, 2) + '\n');
  // A freshly created file belongs to this conversation — later full rewrites
  // of it (self-corrections, 重做) skip the overwrite guard.
  if (oldRaw === null) ctx.sessionCreatedPaths?.add(guard.abs);

  return {
    content: JSON.stringify({
      ok: true,
      // The ACTUAL path written — may differ from the model's input when a
      // member's new graph was rerouted into their personal workspace.
      path: String(inp.path),
      warnings: report.warnings,
      unresolvedMfPins: report.unresolvedPins,
      changedNodeIds: changed,
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
  const guard = await guardPath(inp.path, ctx.graphsRoot);
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

  // Apply patch — applyErrors carries EVERY failing op so the model can fix
  // the whole batch in a single retry.
  const pinLookup = makePinLookup(loadVersionDb(ctx.repoRoot, ctx.ueVersion));
  const patchResult = applyPatch(loaded.graph, ops as PatchOp[], { pinLookup });
  if (!patchResult.ok) {
    return {
      content: JSON.stringify({ applyErrors: patchResult.errors }),
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

  const assignedIds =
    Object.keys(patchResult.assignedIds).length > 0 ? patchResult.assignedIds : undefined;
  const payload = {
    ok: true as const,
    diff: patchResult.diff,
    warnings: report.warnings,
    unresolvedMfPins: report.unresolvedPins,
    changedNodeIds: changedNodeIds(patchResult.resolvedOps),
    ...(assignedIds ? { assignedIds } : {}),
  };

  // dryRun: full apply + validation, nothing written — the loop suppresses
  // the diff / graph_written fan-out when it sees dryRun:true.
  if (inp.dryRun === true) {
    return { content: JSON.stringify({ ...payload, dryRun: true }) };
  }

  // Clean — write. The loop injects a callCtx wrapper that supplies the real
  // per-iteration turnId; the empty string here is never seen by the outer hook.
  await ctx.beforeWrite?.(guard.abs, '');
  await atomicWrite(guard.abs, JSON.stringify(patchResult.graph, null, 2) + '\n');

  return { content: JSON.stringify(payload) };
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
    const guard = await guardPath(inp.path, ctx.graphsRoot);
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
  const guard = await guardPath(inp.path, ctx.graphsRoot);
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

// ---------------------------------------------------------------------------
// rename_graph / delete_graph — undoable file management
// ---------------------------------------------------------------------------

async function toolRenameGraph(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const from = await guardPath(inp.from, ctx.graphsRoot);
  if ('error' in from) return { content: `from: ${from.error}`, isError: true };
  const to = await guardPath(inp.to, ctx.graphsRoot);
  if ('error' in to) return { content: `to: ${to.error}`, isError: true };

  try {
    await stat(from.abs);
  } catch {
    return { content: `rename_graph: source "${String(inp.from)}" does not exist`, isError: true };
  }
  let destExists = true;
  try { await stat(to.abs); } catch { destExists = false; }
  if (destExists) {
    return { content: `rename_graph: target "${String(inp.to)}" already exists`, isError: true };
  }

  // Pre-images: source content (undo restores it) + absent target (undo deletes it).
  await ctx.beforeWrite?.(from.abs, '');
  await ctx.beforeWrite?.(to.abs, '');
  await mkdir(dirname(to.abs), { recursive: true });
  await rename(from.abs, to.abs);

  return {
    content: JSON.stringify({
      ok: true,
      from: inp.from,
      to: inp.to,
      diff: [`將 \`${String(inp.from)}\` 改名為 \`${String(inp.to)}\``],
      warnings: ['references from other graphs (relative MaterialFunctionCall paths) are NOT rewritten'],
    }),
  };
}

async function toolDeleteGraph(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const guard = await guardPath(inp.path, ctx.graphsRoot);
  if ('error' in guard) return { content: guard.error, isError: true };

  try {
    await stat(guard.abs);
  } catch {
    return { content: `delete_graph: "${String(inp.path)}" does not exist`, isError: true };
  }

  await ctx.beforeWrite?.(guard.abs, '');
  await unlink(guard.abs);

  return {
    content: JSON.stringify({
      ok: true,
      path: inp.path,
      diff: [`刪除了 \`${String(inp.path)}\`（可用「還原」復原）`],
    }),
  };
}

// ---------------------------------------------------------------------------
// export_to_clipboard — validate, then let the loop signal the viewer.
// The T3D build + clipboard write happen in the BROWSER (single source of
// truth: web export/ueT3D.ts needs the rendered dagre positions anyway).
// ---------------------------------------------------------------------------

async function toolExportToClipboard(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const guard = await guardPath(inp.path, ctx.graphsRoot);
  if ('error' in guard) return { content: guard.error, isError: true };

  const loaded = await loadGraph(guard.abs);
  if (!loaded.graph) {
    return {
      content: JSON.stringify({ errors: loaded.errors, note: 'graph is invalid — fix it before exporting' }),
      isError: true,
    };
  }

  return {
    content: JSON.stringify({
      ok: true,
      path: inp.path,
      note: '已請求檢視器將此圖以 T3D 複製到剪貼簿（瀏覽器分頁需在前景）。請提醒使用者到 UE 材質編輯器按 Ctrl+V 貼上。',
    }),
  };
}

// ---------------------------------------------------------------------------
// request_crawl — a PROPOSAL only. The loop emits a crawl_proposal event; the
// user approves via a chat card that calls the existing POST /api/crawl path.
// The agent never gains the authority to spawn the UE editor itself.
// ---------------------------------------------------------------------------

async function toolRequestCrawl(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const kind = inp.kind;
  if (kind !== 'workmf' && kind !== 'projectmat') {
    return { content: 'request_crawl: kind must be "workmf" or "projectmat"', isError: true };
  }
  let contentRoot = '/Game';
  if (inp.contentRoot != null) {
    if (typeof inp.contentRoot !== 'string' || !inp.contentRoot.startsWith('/')) {
      return { content: 'request_crawl: contentRoot must be a UE path starting with "/"', isError: true };
    }
    contentRoot = inp.contentRoot;
  }

  const env = await (ctx.probeEnvFn ?? probeEnv)(ctx.repoRoot);
  if (!env.ready) {
    const failing = Object.entries(env.checks)
      .filter(([, c]) => !c.ok)
      .map(([k, c]) => `${k}: ${c.detail}`);
    return {
      content: JSON.stringify({
        ok: false,
        envReady: false,
        failing,
        note: '爬取環境未就緒——請使用者先到 Config 分頁完成設定（ProjectPath/EngineRoot 等）。',
      }),
      isError: true,
    };
  }

  return {
    content: JSON.stringify({
      ok: true,
      kind,
      contentRoot,
      note:
        '已向使用者送出爬取確認卡（爬取會啟動 UE 編輯器、需數分鐘）。請結束本輪並等待使用者確認與完成回報，' +
        '絕不要假設爬取已執行或已完成。',
    }),
  };
}

// ---------------------------------------------------------------------------
// propose_db_edit — a PROPOSAL only (same model as request_crawl). The loop
// emits db_edit_proposal; the user approves via a chat card that calls
// POST /api/agent/db-edit. The agent never writes the public DB itself.
// ---------------------------------------------------------------------------

const RATIONALE_CAP = 600;

async function toolProposeDbEdit(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const nodeName = inp.nodeName;
  if (typeof nodeName !== 'string' || !nodeName.trim()) {
    return { content: 'propose_db_edit: nodeName must be a non-empty string', isError: true };
  }
  const rationale = inp.rationale;
  if (typeof rationale !== 'string' || !rationale.trim()) {
    return { content: 'propose_db_edit: rationale is required —說明依據（UE 文件/來源）', isError: true };
  }
  const create = inp.create === true;
  const v = create ? validateDbCreate(inp.patch) : validateDbEditPatch(inp.patch);
  if (!v.ok) {
    return { content: `propose_db_edit: ${v.error}`, isError: true };
  }
  const db = loadVersionDb(ctx.repoRoot, ctx.ueVersion);
  if (!db) {
    return { content: `propose_db_edit: 找不到 UE ${ctx.ueVersion} 的節點 DB`, isError: true };
  }
  if (create && nodeName in db) {
    return {
      content: `propose_db_edit: 節點「${nodeName}」已存在於 nodes-ue${ctx.ueVersion}.json — 請改用修改（不帶 create）`,
      isError: true,
    };
  }
  if (!create && !(nodeName in db)) {
    return {
      content: `propose_db_edit: 節點「${nodeName}」不存在於 nodes-ue${ctx.ueVersion}.json — 要補齊新節點請帶 create: true`,
      isError: true,
    };
  }
  return {
    content: JSON.stringify({
      ok: true,
      nodeName,
      ueVersion: ctx.ueVersion,
      create,
      patch: v.patch,
      rationale: rationale.trim().slice(0, RATIONALE_CAP),
      note:
        (create
          ? '已向使用者送出「新增節點」確認卡（強制 verified:false，提醒使用者之後執行節點導出爬取補齊 metadata 才能匯出到 UE）。'
          : '已向使用者送出節點 DB 修改確認卡。') +
        '請結束本輪等待使用者決定；絕不要假設修改已套用。獲准後伺服器會自動重生索引並跑 parity audit。',
    }),
  };
}

// ---------------------------------------------------------------------------
// read_crawl_log — log tail of the last finished crawl (diagnosis aid)
// ---------------------------------------------------------------------------

const CRAWL_LOG_DEFAULT_LINES = 60;
const CRAWL_LOG_MAX_LINES = 200;
const CRAWL_LOG_CHAR_CAP = 12_000;

async function toolReadCrawlLog(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  if (!ctx.getCrawlLog) {
    return { content: 'read_crawl_log: 此會話沒有爬取執行器（伺服器未掛載）。', isError: true };
  }
  const snap = ctx.getCrawlLog();
  if (!snap) {
    return { content: '尚無已完成的爬取紀錄。爬取需由使用者從 Config 分頁或確認卡啟動。' };
  }
  let n = CRAWL_LOG_DEFAULT_LINES;
  if (typeof inp.lines === 'number' && Number.isFinite(inp.lines)) {
    n = Math.max(1, Math.min(CRAWL_LOG_MAX_LINES, Math.floor(inp.lines)));
  }
  let tail = snap.lines.slice(-n).join('\n');
  let truncated = false;
  if (tail.length > CRAWL_LOG_CHAR_CAP) {
    tail = tail.slice(-CRAWL_LOG_CHAR_CAP);
    truncated = true;
  }
  return {
    content: JSON.stringify({
      ok: true,
      kind: snap.kind,
      status: snap.status,
      exitCode: snap.exitCode,
      truncated,
      logTail: tail,
    }),
  };
}

// ---------------------------------------------------------------------------
// web_search / web_fetch — public-web access (SSRF-guarded, see web-tools.ts)
// ---------------------------------------------------------------------------

async function toolWebSearch(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const query = inp.query;
  if (typeof query !== 'string' || !query.trim()) {
    return { content: 'web_search: query must be a non-empty string', isError: true };
  }
  const r = await webSearch(query.trim(), ctx.web ?? {});
  if (!r.ok) return { content: `web_search: ${r.error}`, isError: true };
  return { content: JSON.stringify({ ok: true, backend: r.backend, ...(r.note ? { note: r.note } : {}), results: r.results }) };
}

async function toolWebFetch(
  inp: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ content: string; isError?: boolean }> {
  const url = inp.url;
  if (typeof url !== 'string' || !url.trim()) {
    return { content: 'web_fetch: url must be a non-empty string', isError: true };
  }
  const offset = typeof inp.offset === 'number' && Number.isFinite(inp.offset) && inp.offset > 0
    ? Math.floor(inp.offset)
    : 0;
  const r = await fetchPublic(url.trim(), ctx.web ?? {});
  if (!r.ok) return { content: `web_fetch: ${r.error}`, isError: true };

  const isHtml = r.contentType.includes('text/html') || /^\s*<(!doctype|html)/i.test(r.body);
  const full = isHtml ? htmlToText(r.body) : r.body;
  // Windowed view: each call re-fetches and slices (no cache to invalidate);
  // nextOffset lets the model walk a long page in WEB_TEXT_CAP chunks.
  const text = full.slice(offset, offset + WEB_TEXT_CAP);
  const truncated = r.truncatedBody || offset + text.length < full.length;
  return {
    content: JSON.stringify({
      ok: true,
      url: r.finalUrl,
      status: r.status,
      totalChars: full.length,
      offset,
      truncated,
      ...(offset + text.length < full.length ? { nextOffset: offset + text.length } : {}),
      text,
    }),
  };
}

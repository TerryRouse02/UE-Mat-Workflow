// M1 tools.ts tests — dispatch behavior for all 8 tools.
// Uses a tmp dir as fake graphsRoot; real agent-pack data stays read-only
// via ctx.repoRoot pointing at the actual repo root.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dispatchTool, type ToolContext } from '../server/agent/tools.js';

// ---------------------------------------------------------------------------
// Repo root (where the real agent-pack lives)
// ---------------------------------------------------------------------------

// Resolve from this test file's location: viewer/tests/ → ../.. → repo root
const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..', '..');

// ---------------------------------------------------------------------------
// Fixture graph data (modeled on 01_basic_pbr)
// ---------------------------------------------------------------------------

const VALID_GRAPH = {
  schemaVersion: '1.0',
  ueVersion: '5.7',
  type: 'Material',
  name: 'test_mat',
  nodes: [
    { id: 'tex', type: 'TextureSampleParameter2D', params: { ParameterName: 'BaseColorMap', SamplerType: 'Color' } },
    { id: 'mul', type: 'Multiply' },
    { id: 'OUT', type: 'MaterialOutput' },
  ],
  connections: [
    { from: 'tex:RGB', to: 'mul:A' },
    { from: 'mul:Result', to: 'OUT:BaseColor' },
  ],
};

// A graph with an invalid node type
const INVALID_TYPE_GRAPH = {
  ...VALID_GRAPH,
  nodes: [
    ...VALID_GRAPH.nodes,
    { id: 'bad', type: 'NonExistentNodeXYZ' },
  ],
};

// A structurally invalid graph (missing required field)
const MISSING_FIELD_GRAPH = {
  schemaVersion: '1.0',
  ueVersion: '5.7',
  // type missing
  name: 'test',
  nodes: [],
  connections: [],
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let ctx: ToolContext;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ue-tools-test-'));
  // graphs/ inside the tmp dir
  await mkdir(join(tmpDir, 'graphs'), { recursive: true });

  ctx = {
    repoRoot: REPO_ROOT,
    graphsRoot: join(tmpDir, 'graphs'),
    ueVersion: '5.7',
    workMfIndexPath: join(REPO_ROOT, 'agent-pack', 'workmf-index.json'),
  };
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Path guard tests (shared across path-taking tools)
// ---------------------------------------------------------------------------

describe('path guard', () => {
  it('rejects absolute path', async () => {
    const r = await dispatchTool('read_graph', { path: '/etc/passwd.matgraph.json' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/absolute/);
  });

  it('rejects directory traversal', async () => {
    const r = await dispatchTool('read_graph', { path: '../evil.matgraph.json' }, ctx);
    expect(r.isError).toBe(true);
  });

  it('rejects wrong extension', async () => {
    const r = await dispatchTool('read_graph', { path: 'proj/file.json' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/\.matgraph\.json/);
  });
});

// ---------------------------------------------------------------------------
// write_graph
// ---------------------------------------------------------------------------

describe('write_graph', () => {
  it('happy path: writes file and it parses back correctly', async () => {
    const r = await dispatchTool('write_graph', {
      path: 'mymaterial/test_mat.matgraph.json',
      graph: VALID_GRAPH,
    }, ctx);
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content);
    expect(parsed.ok).toBe(true);

    // File must exist
    const abs = join(ctx.graphsRoot, 'mymaterial', 'test_mat.matgraph.json');
    const raw = await readFile(abs, 'utf-8');
    const written = JSON.parse(raw);
    expect(written.name).toBe('test_mat');
  });

  it('invalid graph (schema error) → isError true AND file absent', async () => {
    const r = await dispatchTool('write_graph', {
      path: 'proj/bad.matgraph.json',
      graph: MISSING_FIELD_GRAPH,
    }, ctx);
    expect(r.isError).toBe(true);
    // File must NOT exist
    try {
      await readFile(join(ctx.graphsRoot, 'proj', 'bad.matgraph.json'), 'utf-8');
      expect.fail('File should not exist');
    } catch (e) {
      expect((e as NodeJS.ErrnoException).code).toBe('ENOENT');
    }
  });

  it('unknown node type → rejected', async () => {
    const r = await dispatchTool('write_graph', {
      path: 'proj/badtype.matgraph.json',
      graph: INVALID_TYPE_GRAPH,
    }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/NonExistentNodeXYZ/);
  });

  it('ueVersion mismatch → rejected', async () => {
    const r = await dispatchTool('write_graph', {
      path: 'proj/mismatch.matgraph.json',
      graph: { ...VALID_GRAPH, ueVersion: '5.0' },
    }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/ueVersion/);
  });

  it('beforeWrite hook is called with abs path before write', async () => {
    const calls: string[] = [];
    const hookCtx: ToolContext = {
      ...ctx,
      beforeWrite: async (p: string) => { calls.push(p); },
    };
    await dispatchTool('write_graph', {
      path: 'mat/test_mat.matgraph.json',
      graph: VALID_GRAPH,
    }, hookCtx);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/test_mat\.matgraph\.json$/);
    expect(calls[0]).toMatch(/graphs/);
  });

  it('reports changedNodeIds: all ids on a fresh file, only the differing ones on overwrite', async () => {
    const path = 'hl/fresh.matgraph.json';
    const r1 = await dispatchTool('write_graph', { path, graph: VALID_GRAPH }, ctx);
    expect(JSON.parse(r1.content).changedNodeIds.sort()).toEqual(['OUT', 'mul', 'tex']);

    // Overwrite with one param changed on `tex` — mul/OUT are identical.
    const modified = {
      ...VALID_GRAPH,
      nodes: VALID_GRAPH.nodes.map(n =>
        n.id === 'tex' ? { ...n, params: { ...n.params, ParameterName: 'AlbedoMap' } } : n,
      ),
    };
    const r2 = await dispatchTool('write_graph', { path, graph: modified }, ctx);
    expect(JSON.parse(r2.content).changedNodeIds).toEqual(['tex']);
  });
});

// ---------------------------------------------------------------------------
// patch_graph
// ---------------------------------------------------------------------------

describe('patch_graph', () => {
  async function writeFixture(relPath: string, graph: object = VALID_GRAPH) {
    const abs = join(ctx.graphsRoot, relPath);
    await mkdir(join(ctx.graphsRoot, 'proj'), { recursive: true });
    await writeFile(abs, JSON.stringify(graph, null, 2) + '\n', 'utf-8');
  }

  it('happy path: returns diff lines and file is updated', async () => {
    await writeFixture('proj/test_mat.matgraph.json');
    const r = await dispatchTool('patch_graph', {
      path: 'proj/test_mat.matgraph.json',
      ops: [{ op: 'setParam', id: 'mul', key: 'ConstA', value: 0.5 }],
    }, ctx);
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content);
    expect(out.ok).toBe(true);
    expect(Array.isArray(out.diff)).toBe(true);
    expect(out.diff.length).toBeGreaterThan(0);

    // File updated
    const raw = await readFile(join(ctx.graphsRoot, 'proj', 'test_mat.matgraph.json'), 'utf-8');
    const updated = JSON.parse(raw);
    expect(updated.nodes.find((n: { id: string }) => n.id === 'mul')?.params?.ConstA).toBe(0.5);
  });

  it('bad op (addNode duplicate) → opIndex error, file unchanged', async () => {
    await writeFixture('proj/test_mat.matgraph.json');
    const before = await readFile(join(ctx.graphsRoot, 'proj', 'test_mat.matgraph.json'), 'utf-8');

    const r = await dispatchTool('patch_graph', {
      path: 'proj/test_mat.matgraph.json',
      ops: [{ op: 'addNode', id: 'mul', type: 'Multiply' }],  // 'mul' already exists
    }, ctx);
    expect(r.isError).toBe(true);
    const out = JSON.parse(r.content);
    expect(typeof out.opIndex).toBe('number');
    expect(out.opIndex).toBe(0);

    // File unchanged
    const after = await readFile(join(ctx.graphsRoot, 'proj', 'test_mat.matgraph.json'), 'utf-8');
    expect(after).toBe(before);
  });

  it('beforeWrite hook called before patch write', async () => {
    await writeFixture('proj/test_mat.matgraph.json');
    const calls: string[] = [];
    const hookCtx: ToolContext = {
      ...ctx,
      beforeWrite: async (p: string) => { calls.push(p); },
    };
    await dispatchTool('patch_graph', {
      path: 'proj/test_mat.matgraph.json',
      ops: [{ op: 'setParam', id: 'mul', key: 'ConstA', value: 0.1 }],
    }, hookCtx);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// search_nodes
// ---------------------------------------------------------------------------

describe('search_nodes', () => {
  it('returns results with verified nodes listed first', async () => {
    // 'Texture' category has both verified (TextureSampleParameter2D, TextureSample)
    // and unverified nodes
    const r = await dispatchTool('search_nodes', { query: 'texture' }, ctx);
    expect(r.isError).toBeUndefined();
    const lines = r.content.split('\n').filter(l => l && !l.startsWith('...'));
    // Find first unverified line index
    const firstUnverified = lines.findIndex(l => l.includes('⚠ unverified'));
    const firstVerifiedAfterUnverified = lines.slice(firstUnverified + 1).findIndex(l => !l.includes('⚠'));
    // All verified should come before any unverified
    if (firstUnverified > -1) {
      expect(firstVerifiedAfterUnverified).toBe(-1);
    }
  });

  it('unverified entries get ⚠ unverified marker', async () => {
    const r = await dispatchTool('search_nodes', { query: 'DBufferTexture' }, ctx);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('⚠ unverified');
  });

  it('cap at ~40 lines with tail message', async () => {
    // 'math' returns many nodes — should be capped
    const r = await dispatchTool('search_nodes', { query: 'math' }, ctx);
    const lines = r.content.split('\n');
    // Either fits in 40 or has the "N more" tail
    const hasMore = lines.some(l => l.includes('more, narrow your query'));
    const underCap = lines.length <= 40;
    expect(hasMore || underCap).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// get_node_signature
// ---------------------------------------------------------------------------

describe('get_node_signature', () => {
  it('Lerp hit: returns full DB entry', async () => {
    const r = await dispatchTool('get_node_signature', { name: 'Lerp' }, ctx);
    expect(r.isError).toBeUndefined();
    const entry = JSON.parse(r.content);
    expect(entry.category).toBe('Math');
    expect(entry.inputs).toBeDefined();
    expect(entry.outputs).toBeDefined();
  });

  it('miss: returns isError with suggestions', async () => {
    const r = await dispatchTool('get_node_signature', { name: 'LerpXYZNonExistent' }, ctx);
    expect(r.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// get_mf_signature
// ---------------------------------------------------------------------------

describe('get_mf_signature', () => {
  const ENGINE_PATH = '/Engine/ArtTools/RenderToTexture/MaterialFunctions/CheckerPattern.CheckerPattern';

  it('engine hit: returns signature from engine index', async () => {
    const r = await dispatchTool('get_mf_signature', { assetPath: ENGINE_PATH }, ctx);
    expect(r.isError).toBeUndefined();
    const entry = JSON.parse(r.content);
    expect(entry.displayName).toBe('CheckerPattern');
    expect(Array.isArray(entry.inputs)).toBe(true);
    expect(Array.isArray(entry.outputs)).toBe(true);
  });

  it('workmf hit via tmp workmf-index fixture', async () => {
    // Write a tmp workmf index fixture
    const workMfPath = join(tmpDir, 'workmf-index.json');
    await writeFile(workMfPath, JSON.stringify({
      schemaVersion: '1.0',
      kind: 'workmf-index',
      ueVersion: '5.7',
      functions: {
        '/Game/Functions/MF_Test.MF_Test': {
          assetPath: '/Game/Functions/MF_Test.MF_Test',
          displayName: 'MF_Test',
          category: '/Game/Functions',
          inputs: [{ name: 'Amount', type: 'Float1', index: 0 }],
          outputs: [{ name: 'Result', type: 'Float3', index: 0 }],
          missing: false,
        },
      },
    }), 'utf-8');

    const workCtx: ToolContext = { ...ctx, workMfIndexPath: workMfPath };
    const r = await dispatchTool('get_mf_signature', { assetPath: '/Game/Functions/MF_Test.MF_Test' }, workCtx);
    expect(r.isError).toBeUndefined();
    const entry = JSON.parse(r.content);
    expect(entry.displayName).toBe('MF_Test');
  });

  it('miss → returns isError with crawl-hint message and never invent pins note', async () => {
    const r = await dispatchTool('get_mf_signature', { assetPath: '/Engine/Nonexistent/MF_Fake.MF_Fake' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/crawl/i);
    expect(r.content).toMatch(/NEVER invent pin names/);
  });
});

// ---------------------------------------------------------------------------
// validate_graph
// ---------------------------------------------------------------------------

describe('validate_graph', () => {
  it('valid graph inline → no errors', async () => {
    const r = await dispatchTool('validate_graph', { graph: VALID_GRAPH }, ctx);
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content);
    expect(out.errors).toHaveLength(0);
  });

  it('invalid graph inline → reports errors', async () => {
    const r = await dispatchTool('validate_graph', { graph: MISSING_FIELD_GRAPH }, ctx);
    // Either isError or errors array has entries
    const out = JSON.parse(r.content);
    expect(out.errors.length).toBeGreaterThan(0);
  });

  it('valid graph by path → no errors', async () => {
    const abs = join(ctx.graphsRoot, 'vtest');
    await mkdir(abs, { recursive: true });
    await writeFile(join(abs, 'test_mat.matgraph.json'), JSON.stringify(VALID_GRAPH, null, 2) + '\n', 'utf-8');
    const r = await dispatchTool('validate_graph', { path: 'vtest/test_mat.matgraph.json' }, ctx);
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content);
    expect(out.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// get_graph_errors
// ---------------------------------------------------------------------------

describe('get_graph_errors', () => {
  it('valid file → errors array is empty', async () => {
    const abs = join(ctx.graphsRoot, 'errs');
    await mkdir(abs, { recursive: true });
    await writeFile(join(abs, 'test_mat.matgraph.json'), JSON.stringify(VALID_GRAPH, null, 2) + '\n', 'utf-8');
    const r = await dispatchTool('get_graph_errors', { path: 'errs/test_mat.matgraph.json' }, ctx);
    expect(r.isError).toBeUndefined();
    const out = JSON.parse(r.content);
    expect(out.errors).toHaveLength(0);
  });

  it('non-existent file → isError', async () => {
    const r = await dispatchTool('get_graph_errors', { path: 'no/such.matgraph.json' }, ctx);
    expect(r.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// unknown tool
// ---------------------------------------------------------------------------

describe('unknown tool', () => {
  it('returns isError', async () => {
    const r = await dispatchTool('not_a_real_tool', {}, ctx);
    expect(r.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validation gate must fail loudly when the version DB cannot load — silently
// skipping the node-type check would let invalid types reach disk.
// ---------------------------------------------------------------------------

describe('missing version DB', () => {
  it('write_graph is rejected loudly when no DB exists for the session ueVersion', async () => {
    const badCtx: ToolContext = { ...ctx, ueVersion: '9.9' };
    const r = await dispatchTool(
      'write_graph',
      { path: 'proj/m.matgraph.json', graph: { ...VALID_GRAPH, ueVersion: '9.9' } },
      badCtx,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/node DB for ueVersion 9\.9 could not be loaded/);
  });
});

// ---------------------------------------------------------------------------
// M9 discovery tools: list_graphs / search_mf / list_examples / read_example
// ---------------------------------------------------------------------------

describe('list_graphs', () => {
  it('lists graphs with type/name and posix-relative paths', async () => {
    await mkdir(join(tmpDir, 'graphs', 'proj_a'), { recursive: true });
    await writeFile(
      join(tmpDir, 'graphs', 'proj_a', 'water.matgraph.json'),
      JSON.stringify(VALID_GRAPH, null, 2),
      'utf-8',
    );
    await writeFile(join(tmpDir, 'graphs', 'broken.matgraph.json'), '{not json', 'utf-8');

    const r = await dispatchTool('list_graphs', {}, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('proj_a/water.matgraph.json');
    expect(r.content).toContain('[Material]');
    expect(r.content).toContain('test_mat');
    // Unparseable files are listed, marked, and never crash the tool.
    expect(r.content).toContain('broken.matgraph.json');
    expect(r.content).toContain('[unparseable]');
  });

  it('reports an empty graphs dir gracefully', async () => {
    const r = await dispatchTool('list_graphs', {}, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('No .matgraph.json');
  });
});

describe('search_mf', () => {
  it('finds engine MFs by keyword against the real index', async () => {
    const r = await dispatchTool('search_mf', { query: 'BlendAngleCorrectedNormals' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('BlendAngleCorrectedNormals');
    expect(r.content).toContain('[engine]');
    expect(r.content).toContain('/Engine/Functions/');
  });

  it('empty query is an error; no matches is a normal message', async () => {
    const empty = await dispatchTool('search_mf', { query: '   ' }, ctx);
    expect(empty.isError).toBe(true);

    const none = await dispatchTool('search_mf', { query: 'zz_no_such_mf_zz' }, ctx);
    expect(none.isError).toBeFalsy();
    expect(none.content).toContain('No MF matches');
  });
});

describe('list_examples / read_example', () => {
  it('lists the shipped examples with their matgraph files', async () => {
    const r = await dispatchTool('list_examples', {}, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('01_basic_pbr: 01_basic_pbr.matgraph.json');
    expect(r.content).toContain('04_snow');
  });

  it('reads every matgraph file of an example project', async () => {
    const r = await dispatchTool('read_example', { name: '04_snow' }, ctx);
    expect(r.isError).toBeFalsy();
    // The snow example ships a material + a sibling MF.
    expect(r.content).toContain('--- 04_snow.matgraph.json ---');
    expect(r.content).toContain('--- blend_normals.matgraph.json ---');
    expect(r.content).toContain('"type": "MaterialFunction"');
  });

  it('rejects traversal-shaped names and reports unknown examples with the available list', async () => {
    const bad = await dispatchTool('read_example', { name: '../SPEC' }, ctx);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('invalid example name');

    const missing = await dispatchTool('read_example', { name: 'no_such_example' }, ctx);
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain('Available:');
    expect(missing.content).toContain('01_basic_pbr');
  });
});

// ---------------------------------------------------------------------------
// rename_graph / delete_graph
// ---------------------------------------------------------------------------

describe('rename_graph / delete_graph', () => {
  it('rename moves the file, returns a diff line, and snapshots both ends for undo', async () => {
    const writes: string[] = [];
    const hookCtx: ToolContext = { ...ctx, beforeWrite: async (p) => { writes.push(p); } };
    await dispatchTool('write_graph', { path: 'fm/old.matgraph.json', graph: VALID_GRAPH }, ctx);

    const r = await dispatchTool('rename_graph', { from: 'fm/old.matgraph.json', to: 'fm/new.matgraph.json' }, hookCtx);
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.diff.join('')).toContain('改名');
    expect(writes).toHaveLength(2); // pre-images: source content + absent target

    await expect(readFile(join(ctx.graphsRoot, 'fm', 'new.matgraph.json'), 'utf-8')).resolves.toContain('test_mat');
    await expect(readFile(join(ctx.graphsRoot, 'fm', 'old.matgraph.json'), 'utf-8')).rejects.toThrow();
  });

  it('rename rejects a missing source and an existing target', async () => {
    await dispatchTool('write_graph', { path: 'fm/a.matgraph.json', graph: VALID_GRAPH }, ctx);
    await dispatchTool('write_graph', { path: 'fm/b.matgraph.json', graph: VALID_GRAPH }, ctx);
    const miss = await dispatchTool('rename_graph', { from: 'fm/none.matgraph.json', to: 'fm/x.matgraph.json' }, ctx);
    expect(miss.isError).toBe(true);
    const clash = await dispatchTool('rename_graph', { from: 'fm/a.matgraph.json', to: 'fm/b.matgraph.json' }, ctx);
    expect(clash.isError).toBe(true);
    expect(clash.content).toMatch(/already exists/);
  });

  it('delete removes the file after checkpointing; missing path errors', async () => {
    const writes: string[] = [];
    const hookCtx: ToolContext = { ...ctx, beforeWrite: async (p) => { writes.push(p); } };
    await dispatchTool('write_graph', { path: 'fm/doomed.matgraph.json', graph: VALID_GRAPH }, ctx);

    const r = await dispatchTool('delete_graph', { path: 'fm/doomed.matgraph.json' }, hookCtx);
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(r.content).diff.join('')).toContain('刪除');
    expect(writes).toHaveLength(1);
    await expect(readFile(join(ctx.graphsRoot, 'fm', 'doomed.matgraph.json'), 'utf-8')).rejects.toThrow();

    const miss = await dispatchTool('delete_graph', { path: 'fm/doomed.matgraph.json' }, ctx);
    expect(miss.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// export_to_clipboard / request_crawl
// ---------------------------------------------------------------------------

describe('export_to_clipboard', () => {
  it('accepts a valid graph and echoes the path for the loop to signal the viewer', async () => {
    await dispatchTool('write_graph', { path: 'exp/ok.matgraph.json', graph: VALID_GRAPH }, ctx);
    const r = await dispatchTool('export_to_clipboard', { path: 'exp/ok.matgraph.json' }, ctx);
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe('exp/ok.matgraph.json');
  });

  it('rejects a missing or invalid graph', async () => {
    const r = await dispatchTool('export_to_clipboard', { path: 'exp/none.matgraph.json' }, ctx);
    expect(r.isError).toBe(true);
  });
});

describe('request_crawl', () => {
  const readyEnv = { ready: true, platform: 'win32', projectPath: 'p', engineRoot: 'e', checks: {} };
  const notReadyEnv = {
    ready: false, platform: 'win32', projectPath: null, engineRoot: null,
    checks: { config: { ok: false, detail: 'missing local.config.json' } },
  };

  it('proposes the crawl (never runs anything) when the env probe is green', async () => {
    const r = await dispatchTool('request_crawl', { kind: 'workmf' }, {
      ...ctx,
      probeEnvFn: async () => readyEnv as never,
    });
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content);
    expect(parsed).toMatchObject({ ok: true, kind: 'workmf', contentRoot: '/Game' });
    expect(parsed.note).toContain('等待使用者確認');
  });

  it('rejects bad kinds and bad content roots; reports a non-ready env as a tool error', async () => {
    const badKind = await dispatchTool('request_crawl', { kind: 'export' }, ctx);
    expect(badKind.isError).toBe(true);
    const badRoot = await dispatchTool('request_crawl', { kind: 'workmf', contentRoot: 'Game' }, ctx);
    expect(badRoot.isError).toBe(true);

    const notReady = await dispatchTool('request_crawl', { kind: 'projectmat' }, {
      ...ctx,
      probeEnvFn: async () => notReadyEnv as never,
    });
    expect(notReady.isError).toBe(true);
    expect(notReady.content).toContain('Config');
  });
});

describe('read_crawl_log', () => {
  it('returns the last finished crawl tail and respects the lines cap', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const withLog = {
      ...ctx,
      getCrawlLog: () => ({ kind: 'workmf', status: 'error' as const, exitCode: 1, lines }),
    };
    const r = await dispatchTool('read_crawl_log', { lines: 10 }, withLog);
    expect(r.isError).toBeUndefined();
    const parsed = JSON.parse(r.content);
    expect(parsed).toMatchObject({ ok: true, kind: 'workmf', status: 'error', exitCode: 1 });
    expect(parsed.logTail.split('\n')).toHaveLength(10);
    expect(parsed.logTail).toContain('line 100');
    expect(parsed.logTail).not.toContain('line 90\n');
  });

  it('reports "no crawl yet" without error, and unavailable runner as an error', async () => {
    const none = await dispatchTool('read_crawl_log', {}, { ...ctx, getCrawlLog: () => null });
    expect(none.isError).toBeUndefined();
    expect(none.content).toContain('尚無');

    const noRunner = await dispatchTool('read_crawl_log', {}, ctx);
    expect(noRunner.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// web_search / web_fetch (network injected via ctx.web)
// ---------------------------------------------------------------------------

describe('web_search / web_fetch via dispatch', () => {
  const publicLookup = async () => [{ address: '93.184.216.34' }];

  it('web_fetch returns stripped text for HTML and blocks private targets', async () => {
    const fetchFn = (async () => new Response('<html><body><p>UE docs body</p></body></html>', {
      status: 200, headers: { 'content-type': 'text/html' },
    })) as typeof fetch;
    const ok = await dispatchTool('web_fetch', { url: 'https://example.com/doc' }, { ...ctx, web: { fetchFn, lookupFn: publicLookup } });
    expect(ok.isError).toBeUndefined();
    expect(JSON.parse(ok.content).text).toContain('UE docs body');

    const blocked = await dispatchTool('web_fetch', { url: 'http://192.168.0.1/' }, { ...ctx, web: { fetchFn, lookupFn: publicLookup } });
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toMatch(/blocked/);
  });

  it('web_search surfaces parse failures as tool errors', async () => {
    const fetchFn = (async () => new Response('<html>no results</html>', { status: 200 })) as typeof fetch;
    const r = await dispatchTool('web_search', { query: 'anything' }, { ...ctx, web: { fetchFn, lookupFn: publicLookup } });
    expect(r.isError).toBe(true);
  });
});

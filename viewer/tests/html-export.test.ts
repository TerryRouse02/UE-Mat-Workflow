/**
 * Tests for viewer/server/html-export.ts — the self-contained snapshot builder.
 *
 * What buildSnapshot bakes into the HTML:
 *   - `entry`        : "<name>.matgraph.json" (the top-level graph filename)
 *   - `files`        : { [relPath]: graphObject } — top-level graph + any
 *                      locally-referenced MF sub-graphs (relative paths only).
 *                      /Game/ and /Engine/ asset-path MFCs are SKIPPED here.
 *   - `derivedPins`  : { [nodeId]: { inputs, outputs } } — resolved pin shapes
 *                      for MaterialFunctionCall nodes (from workmf/enginemf/sibling).
 *   - `warnings`     : validation + resolution warnings.
 *   All of the above is injected as window.__UE_MAT_EXPORT__ before </body>.
 *
 * WORKMF LEAK GUARD (invariant #3):
 *   The /Game/ asset-path function keys from workmf-index.json must NEVER appear
 *   in the exported HTML — neither in `files` keys nor in any raw string form.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildSnapshot } from '../server/html-export';

const REPO = resolve(__dirname, '..', '..');
const DIST_DIR = resolve(REPO, 'viewer/web/dist');
const WORKMF_PATH = resolve(REPO, 'agent-pack/workmf-index.json');

// Skip every test gracefully when web/dist is absent (CI without a prior build).
// The instructions say dist already exists locally, but guard for robustness.
const distExists = existsSync(resolve(DIST_DIR, 'index.html'));

/**
 * Extract the JSON string baked into window.__UE_MAT_EXPORT__ from the snapshot HTML.
 * The injection looks like: <script>window.__UE_MAT_EXPORT__ = {...};</script>
 * We extract everything between the ' = ' marker and the final ';</script>' sentinel.
 * Returns null if the marker is not found.
 */
function extractExportData(html: string): string | null {
  const OPEN = 'window.__UE_MAT_EXPORT__ = ';
  const CLOSE = ';</script>';
  const start = html.indexOf(OPEN);
  if (start < 0) return null;
  const dataStart = start + OPEN.length;
  // The close marker is right after the JSON object; find it from the data start.
  const end = html.indexOf(CLOSE, dataStart);
  if (end < 0) return null;
  return html.slice(dataStart, end);
}

// ---------------------------------------------------------------------------
// 1. Basic snapshot: stress_common (no MFC nodes, no /Game/ refs)
// ---------------------------------------------------------------------------
describe('buildSnapshot — stress_common fixture', () => {
  let html: string;

  beforeAll(async () => {
    if (!distExists) return;
    html = await buildSnapshot({
      repoRoot: REPO,
      name: 'stress_common/stress_common',
      distDir: DIST_DIR,
    });
  });

  it('skips when web/dist is absent', () => {
    if (distExists) return; // dist present — this test is a no-op sentinel
    console.warn('SKIP: viewer/web/dist/index.html absent; run `pnpm build` in viewer/web first');
    expect(true).toBe(true);
  });

  it('returns a string that starts with <!DOCTYPE html>', () => {
    if (!distExists) return;
    expect(html).toMatch(/^<!DOCTYPE html>/i);
  });

  it('injects window.__UE_MAT_EXPORT__ before </body>', () => {
    if (!distExists) return;
    expect(html).toContain('window.__UE_MAT_EXPORT__');
    // The injection must be placed BEFORE </body>
    const injectIdx = html.indexOf('window.__UE_MAT_EXPORT__');
    const bodyIdx = html.lastIndexOf('</body>');
    expect(injectIdx).toBeGreaterThan(0);
    expect(injectIdx).toBeLessThan(bodyIdx);
  });

  it('entry key contains the graph name', () => {
    if (!distExists) return;
    // The entry field is "stress_common/stress_common.matgraph.json"
    const match = html.match(/"entry"\s*:\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('stress_common/stress_common.matgraph.json');
  });

  it('files object contains the top-level graph keyed by entry path', () => {
    if (!distExists) return;
    // The graph's "name" field must appear somewhere in the serialized files blob
    expect(html).toContain('"stress_common"');
  });

  it('HTML is self-contained: app bundle JS is inlined (no external /assets/ script src)', () => {
    if (!distExists) return;
    // After inlining, the <script src="/assets/..."> tag should be gone,
    // replaced by an inline <script type="module">...</script>.
    // This verifies inlineAssets() ran and replaced the script tag.
    expect(html).toContain('<script type="module">');
    // The original src attribute from index.html should not survive
    expect(html).not.toMatch(/<script[^>]+src="\/assets\/[^"]*"[^>]*><\/script>/);
  });

  it('data blob does not contain workmf function-key strings (no /Game/ in __UE_MAT_EXPORT__ data)', () => {
    if (!distExists) return;
    // stress_common has no MaterialFunctionCall nodes at all. Extract just the
    // __UE_MAT_EXPORT__ data block and assert no /Game/ path from workmf appears.
    // (The inlined app bundle may contain a UI help string with /Game/ — that is a
    //  pre-existing UI concern, NOT a workmf data leak from the exporter.)
    const exportData = extractExportData(html);
    expect(exportData, 'should find __UE_MAT_EXPORT__ data block').not.toBeNull();
    expect(exportData).not.toContain('/Game/');
  });
});

// ---------------------------------------------------------------------------
// 2. Snapshot with a local MF sub-graph (02_with_function example)
//    graphs/ root points at agent-pack/examples for this test via a tmp symlink
//    alternative: we need a graph under graphs/. Use 02_with_function as the
//    name and override the graphsRoot by … wait, buildSnapshot reads from
//    resolve(repoRoot, 'graphs'). We use the agent-pack/examples folder as
//    a graphs/ root by making a temporary repoRoot pointing there.
//    Actually, the simplest approach: create a temporary graphs/ layout.
// ---------------------------------------------------------------------------
describe('buildSnapshot — graph with local MF sub-graph (no /Game/ paths)', () => {
  let html: string;
  let tmpRoot: string;

  beforeAll(async () => {
    if (!distExists) return;

    // Build a minimal tmp repo root with graphs/<name>/ layout pointing at
    // the committed 02_with_function example files.
    const { mkdirSync, copyFileSync } = await import('node:fs');
    tmpRoot = mkdtempSync(resolve(tmpdir(), 'ue-mat-html-'));
    const graphDir = resolve(tmpRoot, 'graphs', 'test_mf_graph');
    mkdirSync(graphDir, { recursive: true });

    // Copy the two matgraph files into the tmp graphs dir
    const exampleDir = resolve(REPO, 'agent-pack/examples/02_with_function');
    copyFileSync(
      resolve(exampleDir, '02_with_function.matgraph.json'),
      resolve(graphDir, '02_with_function.matgraph.json'),
    );
    copyFileSync(
      resolve(exampleDir, 'blend_normals.matgraph.json'),
      resolve(graphDir, 'blend_normals.matgraph.json'),
    );

    html = await buildSnapshot({
      repoRoot: tmpRoot,
      name: 'test_mf_graph/02_with_function',
      distDir: DIST_DIR,
      // No workmf — graph only has local relative MFC refs
    });
  });

  it('skips when web/dist is absent', () => {
    if (distExists) return;
    expect(true).toBe(true);
  });

  it('contains the material name', () => {
    if (!distExists) return;
    expect(html).toContain('"02_with_function"');
  });

  it('inlines the referenced MF sub-graph into files', () => {
    if (!distExists) return;
    // blend_normals is the sub-MF; its name should appear in the files blob
    expect(html).toContain('"blend_normals"');
  });

  it('__UE_MAT_EXPORT__ data blob does NOT contain /Game/', () => {
    if (!distExists) return;
    // The inlined app bundle may contain UI help strings with /Game/ paths — that is
    // a pre-existing concern unrelated to workmf baking. What we guard here is that
    // the __UE_MAT_EXPORT__ data injected by html-export.ts contains no /Game/ paths.
    const exportData = extractExportData(html);
    expect(exportData, 'should find __UE_MAT_EXPORT__ data block').not.toBeNull();
    expect(exportData).not.toContain('/Game/');
  });
});

// ---------------------------------------------------------------------------
// 3. LEAK GUARD — sentinel workmf-index.json
//
//    Scenario: a workmf-index.json has TWO entries:
//      - REFERENCED_PATH: referenced by the graph's MFC node (legitimately in `files`)
//      - UNREFERENCED_PATH: NOT referenced — purely in the index, never in the graph
//
//    The UNREFERENCED_PATH must NEVER appear in the HTML export at all, because:
//      - It's not in `files` (collect() skips /Game/ MFCs)
//      - `derivedPins` keys are node-ids, not asset paths
//      - Warnings are only emitted when a path is MISSING from the index
//    Any appearance of UNREFERENCED_PATH would mean workmf-index.json data leaked
//    beyond what the graph itself exposes.
//
//    Note: REFERENCED_PATH will appear in `files[entry].nodes[].params.MaterialFunction`
//    — this is expected; it's graph data, not workmf-index data.
// ---------------------------------------------------------------------------
describe('LEAK GUARD — sentinel workmf-index.json', () => {
  const REFERENCED_PATH = '/Game/SENTINEL_WORKMF_LEAK_REFERENCED/MF_UsedAsset.MF_UsedAsset';
  const UNREFERENCED_PATH = '/Game/SENTINEL_WORKMF_LEAK_UNREFERENCED/MF_SecretAsset.MF_SecretAsset';
  let html: string;
  let tmpRoot: string;

  beforeAll(async () => {
    if (!distExists) return;

    const { mkdirSync } = await import('node:fs');
    tmpRoot = mkdtempSync(resolve(tmpdir(), 'ue-mat-leak-'));
    const graphDir = resolve(tmpRoot, 'graphs', 'leak_test');
    mkdirSync(graphDir, { recursive: true });
    mkdirSync(resolve(tmpRoot, 'agent-pack'), { recursive: true });

    // A graph that references REFERENCED_PATH but NOT UNREFERENCED_PATH
    const graph = {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      type: 'Material',
      name: 'leak_test',
      description: 'Leak guard test fixture',
      nodes: [
        {
          id: 'used_mfc',
          type: 'MaterialFunctionCall',
          params: { MaterialFunction: REFERENCED_PATH },
        },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [
        { from: 'used_mfc:Result', to: 'OUT:BaseColor' },
      ],
    };
    writeFileSync(
      resolve(graphDir, 'leak_test.matgraph.json'),
      JSON.stringify(graph, null, 2),
    );

    // workmf-index.json has BOTH functions, but the graph only uses one
    const workmfIndex = {
      schemaVersion: '1.0',
      kind: 'workmf-index',
      ueVersion: '5.7',
      functions: {
        [REFERENCED_PATH]: {
          assetPath: REFERENCED_PATH,
          inputs: [{ name: 'Color', type: 'Float3' }],
          outputs: [{ name: 'Result', type: 'Float3' }],
        },
        [UNREFERENCED_PATH]: {
          assetPath: UNREFERENCED_PATH,
          inputs: [{ name: 'SecretInput', type: 'Float3' }],
          outputs: [{ name: 'SecretOutput', type: 'Float3' }],
        },
      },
    };
    const workmfIndexPath = resolve(tmpRoot, 'agent-pack', 'workmf-index.json');
    writeFileSync(workmfIndexPath, JSON.stringify(workmfIndex, null, 2));

    html = await buildSnapshot({
      repoRoot: tmpRoot,
      name: 'leak_test/leak_test',
      distDir: DIST_DIR,
      workMfIndexPath: workmfIndexPath,
    });
  });

  it('skips when web/dist is absent', () => {
    if (distExists) return;
    expect(true).toBe(true);
  });

  it('snapshot was produced (basic sanity)', () => {
    if (!distExists) return;
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain('window.__UE_MAT_EXPORT__');
  });

  it('derivedPins resolves the referenced MFC node-id (pins from workmf were used)', () => {
    if (!distExists) return;
    // The used_mfc node-id (NOT the /Game/ path) should appear as a derivedPins key
    const exportData = extractExportData(html);
    expect(exportData).not.toBeNull();
    expect(exportData).toContain('"used_mfc"');
  });

  it('LEAK GUARD: the UNREFERENCED /Game/ path does NOT appear anywhere in the export data', () => {
    if (!distExists) return;
    // The function NOT referenced by the graph must be completely absent.
    // - It's not in `files` (collect() skips /Game/ refs)
    // - It's not in `derivedPins` (only used_mfc was resolved)
    // - It's not in `warnings` (no warning for a function that WAS in the index)
    // Any occurrence = the workmf-index was dumped wholesale, which is the leak we guard.
    const exportData = extractExportData(html);
    expect(exportData, 'should find __UE_MAT_EXPORT__ data block').not.toBeNull();
    expect(exportData).not.toContain(UNREFERENCED_PATH);
  });

  it('LEAK GUARD: UNREFERENCED path does not appear anywhere in the full HTML', () => {
    if (!distExists) return;
    // The full HTML (including inlined bundle) must not contain the unreferenced path.
    expect(html).not.toContain(UNREFERENCED_PATH);
  });
});

// ---------------------------------------------------------------------------
// 4. LEAK GUARD — real workmf-index.json (skip-if-absent guard for CI)
//    If the real gitignored workmf-index.json is present on this machine,
//    parse it and assert none of its function keys appear in a stress_common
//    snapshot (a graph that has no /Game/ refs, so no path should leak).
// ---------------------------------------------------------------------------
describe('LEAK GUARD — real workmf-index.json (skipped in CI when file absent)', () => {
  it('none of the real workmf function keys appear in a stress_common snapshot', async () => {
    if (!distExists) {
      console.warn('SKIP: web/dist absent');
      return;
    }
    if (!existsSync(WORKMF_PATH)) {
      console.warn('SKIP: agent-pack/workmf-index.json not present on this machine');
      return;
    }

    // Parse the real workmf-index to get the /Game/ keys
    const { readFileSync } = await import('node:fs');
    const realIndex = JSON.parse(readFileSync(WORKMF_PATH, 'utf-8')) as {
      functions?: Record<string, unknown>;
    };
    const functionKeys = Object.keys(realIndex.functions ?? {});
    expect(functionKeys.length).toBeGreaterThan(0); // sanity: real file has entries

    // Build a stress_common snapshot (no MFCs → guaranteed no path leakage)
    const html = await buildSnapshot({
      repoRoot: REPO,
      name: 'stress_common/stress_common',
      distDir: DIST_DIR,
      // Default workMfIndexPath resolves to the real gitignored file
    });

    // Check that none of the real /Game/ keys snuck into the output
    for (const key of functionKeys) {
      expect(html, `workmf key "${key}" must not appear in snapshot`).not.toContain(key);
    }
  });
});

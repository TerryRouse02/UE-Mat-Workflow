import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { importProjectMaterials } from '../server/projectmat-importer';
import type { ExportMeta } from '../web/src/export/export-meta-types';

const exportMeta = JSON.parse(
  readFileSync(resolve(__dirname, '../../agent-pack/nodes-ue5.7.export.json'), 'utf-8'),
) as ExportMeta;

describe('importProjectMaterials', () => {
  it('converts staged T3D dumps into _project matgraph files and clears staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'projmat-'));
    const graphsRoot = join(root, 'graphs');
    const stagingDir = join(root, 'staging');
    await mkdir(stagingDir, { recursive: true });
    const t3d = readFileSync(resolve(__dirname, 'fixtures/ue-make-material-attributes.t3d'), 'utf-8');
    await writeFile(join(stagingDir, 'M_Test.t3d'), t3d, 'utf-8');

    const result = await importProjectMaterials({ stagingDir, graphsRoot, exportMeta });

    expect(result.imported).toContain('M_Test');
    const out = JSON.parse(
      await readFile(join(graphsRoot, '_project', 'M_Test', 'M_Test.matgraph.json'), 'utf-8'),
    );
    expect(out.type).toBe('Material');
    expect(out.name).toBe('M_Test');
    expect(out.nodes.length).toBeGreaterThan(0);
    // staged file is consumed
    expect(await readdir(stagingDir)).toEqual([]);
  });

  it('imports MaterialFunction dumps too, tagged as MaterialFunction (kept separate in the UI)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'projmat-'));
    const graphsRoot = join(root, 'graphs');
    const stagingDir = join(root, 'staging');
    await mkdir(stagingDir, { recursive: true });
    // A Material dump alongside a MaterialFunction dump (the MF fixture carries
    // FunctionInput/Output nodes, so parseUET3D classifies it as a MF). Both are
    // imported; the Files panel splits them by type into 工作's 母材質 / 函式 groups.
    await writeFile(
      join(stagingDir, 'M_Test.t3d'),
      readFileSync(resolve(__dirname, 'fixtures/ue-make-material-attributes.t3d'), 'utf-8'),
      'utf-8',
    );
    await writeFile(
      join(stagingDir, 'MF_Helper.t3d'),
      readFileSync(resolve(__dirname, 'fixtures/ue-material-function.t3d'), 'utf-8'),
      'utf-8',
    );

    const result = await importProjectMaterials({ stagingDir, graphsRoot, exportMeta });

    expect(result.imported).toContain('M_Test');
    expect(result.imported).toContain('MF_Helper');
    const mat = JSON.parse(
      await readFile(join(graphsRoot, '_project', 'M_Test', 'M_Test.matgraph.json'), 'utf-8'),
    );
    const fn = JSON.parse(
      await readFile(join(graphsRoot, '_project', 'MF_Helper', 'MF_Helper.matgraph.json'), 'utf-8'),
    );
    expect(mat.type).toBe('Material');
    expect(fn.type).toBe('MaterialFunction');
    // every staged file is consumed
    expect(await readdir(stagingDir)).toEqual([]);
  });

  it('returns a warning (does not throw) when the staging dir is missing', async () => {
    const result = await importProjectMaterials({
      stagingDir: join(tmpdir(), 'does-not-exist-xyz-12345'),
      graphsRoot: tmpdir(),
      exportMeta,
    });
    expect(result.imported).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('stamps sourcePath from the crawl manifest and cleans the manifest up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'projmat-'));
    const graphsRoot = join(root, 'graphs');
    const stagingDir = join(root, 'staging');
    await mkdir(stagingDir, { recursive: true });
    await writeFile(
      join(stagingDir, 'M_Test.t3d'),
      readFileSync(resolve(__dirname, 'fixtures/ue-make-material-attributes.t3d'), 'utf-8'),
      'utf-8',
    );
    // Manifest: raw .t3d basename → UE object path. A non-string entry must be ignored.
    await writeFile(
      join(stagingDir, 'manifest.json'),
      JSON.stringify({ M_Test: '/Game/Materials/M_Test.M_Test', Other: 123 }),
      'utf-8',
    );

    const result = await importProjectMaterials({ stagingDir, graphsRoot, exportMeta });
    expect(result.imported).toContain('M_Test');
    const graph = JSON.parse(
      await readFile(join(graphsRoot, '_project', 'M_Test', 'M_Test.matgraph.json'), 'utf-8'),
    ) as { sourcePath?: string };
    expect(graph.sourcePath).toBe('/Game/Materials/M_Test.M_Test');
    // staging fully cleaned — .t3d removed per-file, manifest.json removed at the end.
    expect(await readdir(stagingDir)).toEqual([]);
  });

  it('imports normally when no manifest is present (no sourcePath)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'projmat-'));
    const graphsRoot = join(root, 'graphs');
    const stagingDir = join(root, 'staging');
    await mkdir(stagingDir, { recursive: true });
    await writeFile(
      join(stagingDir, 'M_Test.t3d'),
      readFileSync(resolve(__dirname, 'fixtures/ue-make-material-attributes.t3d'), 'utf-8'),
      'utf-8',
    );
    const result = await importProjectMaterials({ stagingDir, graphsRoot, exportMeta });
    expect(result.imported).toContain('M_Test');
    const graph = JSON.parse(
      await readFile(join(graphsRoot, '_project', 'M_Test', 'M_Test.matgraph.json'), 'utf-8'),
    ) as { sourcePath?: string };
    expect(graph.sourcePath).toBeUndefined();
  });
});

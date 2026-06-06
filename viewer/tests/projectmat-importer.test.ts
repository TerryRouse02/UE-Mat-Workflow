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

  it('skips MaterialFunction dumps — projectmat is base-materials only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'projmat-'));
    const graphsRoot = join(root, 'graphs');
    const stagingDir = join(root, 'staging');
    await mkdir(stagingDir, { recursive: true });
    // A real Material dump alongside a MaterialFunction dump (the MF fixture
    // carries FunctionInput/Output nodes, so parseUET3D classifies it as a MF).
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
    expect(result.imported).not.toContain('MF_Helper');
    expect(result.skipped).toContain('MF_Helper');
    // the skipped MF must NOT be written under _project/
    await expect(
      readFile(join(graphsRoot, '_project', 'MF_Helper', 'MF_Helper.matgraph.json'), 'utf-8'),
    ).rejects.toThrow();
    // every staged file is consumed regardless of skip/import
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
});

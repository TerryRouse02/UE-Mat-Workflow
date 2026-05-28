import { describe, it, expect } from 'vitest';
import { groupFiles, type FileEntry } from '../web/src/groupFiles';

const F = (path: string, type: FileEntry['type'] = 'Material'): FileEntry => ({ path, type });

describe('groupFiles', () => {
  it('groups one project folder containing one Material + one MF', () => {
    const result = groupFiles([
      F('obsidian/obsidian.matgraph.json', 'Material'),
      F('obsidian/fresnel_lib.matgraph.json', 'MaterialFunction'),
    ]);
    expect(result.projects).toEqual([
      {
        folder: 'obsidian',
        material: F('obsidian/obsidian.matgraph.json', 'Material'),
        mfs: [F('obsidian/fresnel_lib.matgraph.json', 'MaterialFunction')],
      },
    ]);
    expect(result.unorganized).toEqual([]);
  });

  it('puts root-level files into unorganized', () => {
    const result = groupFiles([
      F('05_fresnel.matgraph.json', 'Material'),
      F('06_custom.matgraph.json', 'Material'),
    ]);
    expect(result.projects).toEqual([]);
    expect(result.unorganized).toEqual([
      F('05_fresnel.matgraph.json', 'Material'),
      F('06_custom.matgraph.json', 'Material'),
    ]);
  });

  it('folder with no Material → unorganized (e.g., legacy graphs/functions/)', () => {
    const result = groupFiles([
      F('functions/blend_normals.matgraph.json', 'MaterialFunction'),
    ]);
    expect(result.projects).toEqual([]);
    expect(result.unorganized).toEqual([
      F('functions/blend_normals.matgraph.json', 'MaterialFunction'),
    ]);
  });

  it('folder with two Materials → unorganized', () => {
    const result = groupFiles([
      F('ambiguous/a.matgraph.json', 'Material'),
      F('ambiguous/b.matgraph.json', 'Material'),
      F('ambiguous/helper.matgraph.json', 'MaterialFunction'),
    ]);
    expect(result.projects).toEqual([]);
    expect(result.unorganized).toEqual([
      F('ambiguous/a.matgraph.json', 'Material'),
      F('ambiguous/b.matgraph.json', 'Material'),
      F('ambiguous/helper.matgraph.json', 'MaterialFunction'),
    ]);
  });

  it('folder with Unknown-typed file → unorganized (cannot validate)', () => {
    const result = groupFiles([
      F('mystery/something.matgraph.json', 'Unknown'),
      F('mystery/m.matgraph.json', 'Material'),
    ]);
    expect(result.projects).toEqual([]);
    expect(result.unorganized).toEqual([
      F('mystery/something.matgraph.json', 'Unknown'),
      F('mystery/m.matgraph.json', 'Material'),
    ]);
  });

  it('projects sorted alphabetically by folder name', () => {
    const result = groupFiles([
      F('zeta/z.matgraph.json', 'Material'),
      F('alpha/a.matgraph.json', 'Material'),
      F('beta/b.matgraph.json', 'Material'),
    ]);
    expect(result.projects.map(p => p.folder)).toEqual(['alpha', 'beta', 'zeta']);
    expect(result.unorganized).toEqual([]);
  });

  it('mfs within a project sorted alphabetically', () => {
    const result = groupFiles([
      F('p/main.matgraph.json', 'Material'),
      F('p/z_helper.matgraph.json', 'MaterialFunction'),
      F('p/a_helper.matgraph.json', 'MaterialFunction'),
    ]);
    expect(result.projects[0].mfs.map(e => e.path)).toEqual([
      'p/a_helper.matgraph.json',
      'p/z_helper.matgraph.json',
    ]);
  });

  it('deeply nested paths use only first segment as folder', () => {
    const result = groupFiles([
      F('proj/sub/deep.matgraph.json', 'Material'),
    ]);
    expect(result.unorganized).toEqual([F('proj/sub/deep.matgraph.json', 'Material')]);
    expect(result.projects).toEqual([]);
  });

  it('empty input returns empty projects + unorganized', () => {
    expect(groupFiles([])).toEqual({ projects: [], unorganized: [] });
  });

  it('folder with one Material and no MFs is a valid project', () => {
    const result = groupFiles([F('solo/main.matgraph.json', 'Material')]);
    expect(result.projects).toEqual([{
      folder: 'solo',
      material: F('solo/main.matgraph.json', 'Material'),
      mfs: [],
    }]);
    expect(result.unorganized).toEqual([]);
  });
});

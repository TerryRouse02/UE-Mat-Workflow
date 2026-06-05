import { describe, it, expect } from 'vitest';
import { groupFiles, type FileEntry } from '../web/src/groupFiles';

const F = (path: string, type: FileEntry['type'] = 'Material'): FileEntry => ({ path, type });

describe('groupFiles', () => {
  it('treats any sub-folder as a project showing all its files', () => {
    const result = groupFiles([
      F('obsidian/obsidian.matgraph.json', 'Material'),
      F('obsidian/fresnel_lib.matgraph.json', 'MaterialFunction'),
    ]);
    expect(result.projects).toEqual([
      {
        folder: 'obsidian',
        files: [
          F('obsidian/obsidian.matgraph.json', 'Material'),
          F('obsidian/fresnel_lib.matgraph.json', 'MaterialFunction'),
        ],
      },
    ]);
    expect(result.unorganized).toEqual([]);
  });

  it('puts only root-level files (no folder) into unorganized', () => {
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

  it('a folder with only MaterialFunctions is still a project', () => {
    const result = groupFiles([
      F('functions/blend_normals.matgraph.json', 'MaterialFunction'),
    ]);
    expect(result.projects).toEqual([
      { folder: 'functions', files: [F('functions/blend_normals.matgraph.json', 'MaterialFunction')] },
    ]);
    expect(result.unorganized).toEqual([]);
  });

  it('a folder with two Materials is still a single project (no constraint)', () => {
    const result = groupFiles([
      F('ambiguous/a.matgraph.json', 'Material'),
      F('ambiguous/b.matgraph.json', 'Material'),
      F('ambiguous/helper.matgraph.json', 'MaterialFunction'),
    ]);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].folder).toBe('ambiguous');
    // Both materials sort before the MF; all three files are shown.
    expect(result.projects[0].files.map(f => f.path)).toEqual([
      'ambiguous/a.matgraph.json',
      'ambiguous/b.matgraph.json',
      'ambiguous/helper.matgraph.json',
    ]);
    expect(result.unorganized).toEqual([]);
  });

  it('a folder with an Unknown-typed file is still a project (file shown)', () => {
    const result = groupFiles([
      F('mystery/something.matgraph.json', 'Unknown'),
      F('mystery/m.matgraph.json', 'Material'),
    ]);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].folder).toBe('mystery');
    expect(result.projects[0].files.map(f => f.path)).toEqual([
      'mystery/m.matgraph.json',       // Material sorts first
      'mystery/something.matgraph.json',
    ]);
    expect(result.unorganized).toEqual([]);
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

  it('within a project, Materials come first then everything else alphabetically', () => {
    const result = groupFiles([
      F('p/z_helper.matgraph.json', 'MaterialFunction'),
      F('p/main.matgraph.json', 'Material'),
      F('p/a_helper.matgraph.json', 'MaterialFunction'),
    ]);
    expect(result.projects[0].files.map(e => e.path)).toEqual([
      'p/main.matgraph.json',
      'p/a_helper.matgraph.json',
      'p/z_helper.matgraph.json',
    ]);
  });

  it('nested files group under their first path segment', () => {
    const result = groupFiles([
      F('proj/sub/deep.matgraph.json', 'Material'),
      F('proj/top.matgraph.json', 'Material'),
    ]);
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].folder).toBe('proj');
    expect(result.projects[0].files.map(f => f.path)).toEqual([
      'proj/sub/deep.matgraph.json',
      'proj/top.matgraph.json',
    ]);
    expect(result.unorganized).toEqual([]);
  });

  it('empty input returns empty projects + unorganized', () => {
    expect(groupFiles([])).toEqual({ projects: [], unorganized: [], crawledProjects: [] });
  });

  it('a folder with one Material and no MFs is a valid project', () => {
    const result = groupFiles([F('solo/main.matgraph.json', 'Material')]);
    expect(result.projects).toEqual([{
      folder: 'solo',
      files: [F('solo/main.matgraph.json', 'Material')],
    }]);
    expect(result.unorganized).toEqual([]);
  });

  it('a _project/Foo/Foo.matgraph.json entry groups as crawled / separate from agent projects', () => {
    const crawledEntry: FileEntry = {
      path: '_project/Foo/Foo.matgraph.json',
      type: 'Material',
      origin: 'crawled',
    };
    const agentEntry: FileEntry = {
      path: 'obsidian/obsidian.matgraph.json',
      type: 'Material',
      origin: 'agent',
    };
    const result = groupFiles([crawledEntry, agentEntry]);
    // crawled entry must NOT appear in agent projects
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].folder).toBe('obsidian');
    expect(result.projects[0].files).toHaveLength(1);
    // crawled entry must appear in crawledProjects
    expect(result.crawledProjects).toHaveLength(1);
    expect(result.crawledProjects[0].folder).toBe('Foo');
    expect(result.crawledProjects[0].files[0].path).toBe('_project/Foo/Foo.matgraph.json');
  });

  it('crawled entries with no agent entries still populate crawledProjects only', () => {
    const e: FileEntry = { path: '_project/Rock/Rock.matgraph.json', type: 'Material', origin: 'crawled' };
    const result = groupFiles([e]);
    expect(result.projects).toHaveLength(0);
    expect(result.crawledProjects).toHaveLength(1);
    expect(result.crawledProjects[0].folder).toBe('Rock');
  });
});

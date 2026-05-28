export interface FileEntry {
  path: string;
  type: 'Material' | 'MaterialFunction' | 'Unknown';
}

export interface Project {
  folder: string;
  material: FileEntry;
  mfs: FileEntry[];
}

export interface GroupResult {
  projects: Project[];
  unorganized: FileEntry[];
}

export function groupFiles(entries: FileEntry[]): GroupResult {
  const byFolder = new Map<string, FileEntry[]>();
  const rootLevel: FileEntry[] = [];

  for (const e of entries) {
    const segments = e.path.split('/');
    if (segments.length === 1) {
      rootLevel.push(e);
    } else {
      const folder = segments[0];
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder)!.push(e);
    }
  }

  const projects: Project[] = [];
  const unorganized: FileEntry[] = [...rootLevel];

  const folderNames = [...byFolder.keys()].sort();
  for (const folder of folderNames) {
    const contents = byFolder.get(folder)!;
    const materials = contents.filter(e => e.type === 'Material');
    const mfs = contents.filter(e => e.type === 'MaterialFunction').sort((a, b) => a.path.localeCompare(b.path));
    const unknowns = contents.filter(e => e.type === 'Unknown');

    const hasNesting = contents.some(e => e.path.split('/').length > 2);
    if (materials.length === 1 && unknowns.length === 0 && !hasNesting) {
      projects.push({ folder, material: materials[0], mfs });
    } else {
      unorganized.push(...contents);
    }
  }

  return { projects, unorganized };
}

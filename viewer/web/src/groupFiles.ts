import type { FileEntry } from './protocol';
export type { FileEntry };

export interface Project {
  folder: string;
  files: FileEntry[];
}

export interface GroupResult {
  projects: Project[];
  unorganized: FileEntry[];
}

// Grouping rule (deliberately simple): any sub-folder under graphs/ is ONE
// project, and every file inside it is shown — no constraints on material count,
// file types, or nesting. Only files sitting directly at the graphs/ root (no
// folder) land in "unorganized". Drop a folder in, it's a project.
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
  for (const folder of [...byFolder.keys()].sort()) {
    // Materials first (the main graph you click), then everything else, each
    // group alphabetical by path.
    const files = byFolder.get(folder)!.slice().sort((a, b) => {
      const am = a.type === 'Material' ? 0 : 1;
      const bm = b.type === 'Material' ? 0 : 1;
      return am - bm || a.path.localeCompare(b.path);
    });
    projects.push({ folder, files });
  }

  return { projects, unorganized: rootLevel };
}

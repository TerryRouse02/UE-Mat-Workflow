import type { FileEntry } from './protocol';
export type { FileEntry };

export interface Project {
  folder: string;
  files: FileEntry[];
}

export interface GroupResult {
  projects: Project[];
  unorganized: FileEntry[];
  /** Crawled project-material entries, separated from agent projects. Each
   *  folder is the material subfolder under `_project/` (e.g. "Foo" for
   *  `_project/Foo/Foo.matgraph.json`). */
  crawledProjects: Project[];
}

// Grouping rule (deliberately simple): any sub-folder under graphs/ is ONE
// project, and every file inside it is shown — no constraints on material count,
// file types, or nesting. Only files sitting directly at the graphs/ root (no
// folder) land in "unorganized". Drop a folder in, it's a project.
//
// Entries with origin==='crawled' are separated into crawledProjects so the
// FileList can render them under their own "專案母材質（爬取）" section.
export function groupFiles(entries: FileEntry[]): GroupResult {
  const byFolder = new Map<string, FileEntry[]>();
  const crawledBySubfolder = new Map<string, FileEntry[]>();
  const rootLevel: FileEntry[] = [];

  for (const e of entries) {
    if (e.origin === 'crawled') {
      // e.path is like '_project/Foo/Foo.matgraph.json'; the display folder
      // is the segment after '_project/' (index 1).
      const segments = e.path.split('/');
      const subfolder = segments.length >= 2 ? segments[1] : segments[0];
      if (!crawledBySubfolder.has(subfolder)) crawledBySubfolder.set(subfolder, []);
      crawledBySubfolder.get(subfolder)!.push(e);
      continue;
    }
    const segments = e.path.split('/');
    if (segments.length === 1) {
      rootLevel.push(e);
    } else {
      const folder = segments[0];
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder)!.push(e);
    }
  }

  const sortFiles = (files: FileEntry[]) =>
    files.slice().sort((a, b) => {
      const am = a.type === 'Material' ? 0 : 1;
      const bm = b.type === 'Material' ? 0 : 1;
      return am - bm || a.path.localeCompare(b.path);
    });

  const projects: Project[] = [];
  for (const folder of [...byFolder.keys()].sort()) {
    // Materials first (the main graph you click), then everything else, each
    // group alphabetical by path.
    projects.push({ folder, files: sortFiles(byFolder.get(folder)!) });
  }

  const crawledProjects: Project[] = [];
  for (const subfolder of [...crawledBySubfolder.keys()].sort()) {
    crawledProjects.push({ folder: subfolder, files: sortFiles(crawledBySubfolder.get(subfolder)!) });
  }

  return { projects, unorganized: rootLevel, crawledProjects };
}

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';

// Lives here (not in http-server) so both the import endpoint AND the
// project-materials importer can use it without an import cycle.

export function isInside(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(r + sep);
}

// Wire paths are always POSIX-style ('/'). On Windows path.relative() returns
// backslash separators, which the client's path.split('/') logic can't segment:
// every file collapses to one segment and lands under "Unorganized". Normalize
// at this boundary so all path consumers (grouping, base names, breadcrumbs)
// stay platform-neutral.
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

// Turn a user-supplied name into a filesystem-safe slug used as BOTH the project
// folder and the file base name (folder-per-project convention). Every char
// outside [A-Za-z0-9_-] collapses to '_', so no '/', '\' or '.' survives — the
// result cannot escape graphs/ even before the isInside guard. Empty/garbage
// input falls back to 'imported'.
export function slugifyGraphName(raw: unknown): string {
  const s = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  return s || 'imported';
}

// Write a graph object to <graphsRoot>/<folderRel>/<baseName>.matgraph.json
// (UTF-8 without BOM, trailing newline — matches authored files). `folderRel`
// may contain nested segments (e.g. "_project/M_Rock"). Re-asserts the resolved
// path stays under graphsRoot before touching disk. Returns the POSIX path
// relative to graphsRoot. Throws on an escaping path or a write failure.
export async function writeGraph(
  graphsRoot: string,
  folderRel: string,
  baseName: string,
  graph: unknown,
): Promise<string> {
  const folder = join(graphsRoot, folderRel);
  const filePath = join(folder, `${baseName}.matgraph.json`);
  if (!isInside(graphsRoot, filePath)) {
    throw new Error('resolved path escapes graphs root');
  }
  await mkdir(folder, { recursive: true });
  await writeFile(filePath, JSON.stringify(graph, null, 2) + '\n', 'utf-8');
  return toPosixPath(relative(graphsRoot, filePath));
}

import { readdir, readFile, rm } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { parseUET3D } from '../web/src/export/ueImport.js';
import type { ExportMeta } from '../web/src/export/export-meta-types.js';
import { slugifyGraphName, writeGraph } from './graph-write.js';

export interface ProjectMatResult {
  imported: string[];   // material base-names written under graphs/_project/
  warnings: string[];
}

// Folder under graphs/ that holds crawled project materials. Gitignored
// (graphs/** rule), auto-watched, and the inferred `origin: 'crawled'` prefix.
export const PROJECT_DIR = '_project';

// Post-process for the `projectmat` crawl: the (Windows/Codex) commandlet has
// written one UE T3D dump per /Game UMaterial into `stagingDir`. Convert each via
// the shared T3D->matgraph parser (the same one clipboard "import" uses) and write
// it as an openable graph under graphs/_project/<name>/<name>.matgraph.json, then
// delete the staged file. Never throws for a single bad material — collects it as
// a warning so one broken asset can't abort the whole crawl.
export async function importProjectMaterials(opts: {
  stagingDir: string;
  graphsRoot: string;
  exportMeta: ExportMeta;
}): Promise<ProjectMatResult> {
  const { stagingDir, graphsRoot, exportMeta } = opts;
  const imported: string[] = [];
  const warnings: string[] = [];

  let entries: string[];
  try {
    entries = (await readdir(stagingDir)).filter(f => extname(f).toLowerCase() === '.t3d');
  } catch {
    return { imported, warnings: [`project-materials staging dir not found: ${stagingDir}`] };
  }

  for (const file of entries) {
    const full = join(stagingDir, file);
    const name = slugifyGraphName(basename(file, extname(file)));
    try {
      const text = await readFile(full, 'utf-8');
      const { graph, warnings: w } = parseUET3D(text, exportMeta, { name });
      await writeGraph(graphsRoot, join(PROJECT_DIR, name), name, graph);
      imported.push(name);
      for (const msg of w) warnings.push(`${name}: ${msg}`);
      await rm(full).catch(() => { /* best-effort cleanup */ });
    } catch (e) {
      warnings.push(`${name}: ${(e as Error).message}`);
    }
  }

  return { imported, warnings };
}

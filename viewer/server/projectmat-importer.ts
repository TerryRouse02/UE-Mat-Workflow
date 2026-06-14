import { readdir, readFile, rm } from 'node:fs/promises';
import { join, basename, extname, resolve } from 'node:path';
import { parseUET3D } from '../web/src/export/ueImport.js';
import type { ExportMeta } from '../web/src/export/export-meta-types.js';
import type { MatGraph } from './types.js';
import type { WorkMfIndex } from './workmf-index.js';
import { resolveMfcOutputConnections } from './mf-resolver.js';
import { slugifyGraphName, writeGraph } from './graph-write.js';

export interface ProjectMatResult {
  imported: string[];   // graph base-names written under graphs/_project/ (Material or MaterialFunction)
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
  // MF indexes for resolving MaterialFunctionCall OUTPUT pin names (phase 2). Without
  // them only /Engine + already-written sibling MFs resolve; placeholders otherwise stay.
  workMfIndex?: WorkMfIndex | null;
  engineMfIndex?: WorkMfIndex | null;
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

  // Phase 1: parse + write every staged dump first, so ALL sibling MaterialFunctions are
  // on disk before phase 2 resolves MFC output pin names against them.
  const written: { name: string; graph: MatGraph }[] = [];
  for (const file of entries) {
    const full = join(stagingDir, file);
    const name = slugifyGraphName(basename(file, extname(file)));
    try {
      const text = await readFile(full, 'utf-8');
      // parseUET3D tags the graph as Material or MaterialFunction (via its
      // FunctionInput/Output nodes); both are kept and the Files panel separates
      // them into the 工作 區's 母材質 / 函式 groups by that type.
      const { graph, warnings: w } = parseUET3D(text, exportMeta, { name });
      await writeGraph(graphsRoot, join(PROJECT_DIR, name), name, graph);
      imported.push(name);
      written.push({ name, graph });
      for (const msg of w) warnings.push(`${name}: ${msg}`);
      await rm(full).catch(() => { /* best-effort cleanup */ });
    } catch (e) {
      warnings.push(`${name}: ${(e as Error).message}`);
    }
  }

  // Phase 2: parseUET3D can only emit positional placeholders for MaterialFunctionCall
  // OUTPUT pins (the real names aren't in the T3D). Now that every sibling MF is on disk,
  // resolve each MFC's real ordered output names and rewrite those connection pins — so
  // multi-output (or non-"Result") MFs wire correctly and round-trip to UE instead of
  // breaking / collapsing to output 0. Re-write only the graphs that actually changed.
  for (const { name, graph } of written) {
    try {
      const graphDir = resolve(graphsRoot, PROJECT_DIR, name);
      const { rewrites, warnings: resolveWarnings } = await resolveMfcOutputConnections(graph, graphDir, {
        workMfIndex: opts.workMfIndex,
        engineMfIndex: opts.engineMfIndex,
      });
      // Surface non-throwing resolution misses (MF not indexed / no sibling) — those
      // leave placeholder pins, and an operator needs to know which MFC stayed broken.
      for (const w of resolveWarnings) warnings.push(`${name}: ${w}`);
      if (rewrites > 0) await writeGraph(graphsRoot, join(PROJECT_DIR, name), name, graph);
    } catch (e) {
      warnings.push(`${name}: MFC output pin resolve failed: ${(e as Error).message}`);
    }
  }

  return { imported, warnings };
}

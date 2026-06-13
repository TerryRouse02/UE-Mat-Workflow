import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { loadGraph } from './graph-loader.js';
import { materialStructureWarnings } from './schema.js';
import { resolveMaterialFunctions } from './mf-resolver.js';
import { loadWorkMfIndex } from './workmf-index.js';
import { isInside } from './graph-write.js';

export interface BuildSnapshotOptions {
  /** Absolute path to the repo root (contains graphs/ and agent-pack/). */
  repoRoot: string;
  /** The graph name, e.g. "stress_common/stress_common" (no .matgraph.json extension). */
  name: string;
  /**
   * Absolute path to web/dist. Defaults to <repoRoot>/viewer/web/dist.
   * Pass a custom value in tests to point at a pre-built dist or a minimal stub.
   */
  distDir?: string;
  /**
   * Absolute path to the work-MF index JSON.
   * Defaults to <repoRoot>/agent-pack/workmf-index.json.
   * Pass a custom value in tests to inject a controlled sentinel file.
   */
  workMfIndexPath?: string;
}

/**
 * Core snapshot builder — loads the graph, resolves MF pins, collects sub-graph
 * files, inlines the web bundle, and returns the complete HTML string.
 *
 * This function is exported for unit testing. The CLI `main()` below wraps it
 * to handle argv parsing and file writing.
 *
 * NOTE: workmf-index.json data affects `derivedPins` (pin signatures for /Game/
 * MFC nodes) and `warnings`, but the /Game/ asset-path keys from the index are
 * NEVER included in `files` (the collect loop skips any MF reference starting
 * with '/').  The derivedPins values are { inputs, outputs } pin-shape objects
 * keyed by node-id in the exported graph — they contain no asset-path strings.
 */
export async function buildSnapshot(opts: BuildSnapshotOptions): Promise<string> {
  const { repoRoot, name } = opts;
  const distDir = opts.distDir ?? resolve(repoRoot, 'viewer/web/dist');
  const workMfIndexPath = opts.workMfIndexPath ?? resolve(repoRoot, 'agent-pack', 'workmf-index.json');

  const graphsRoot = resolve(repoRoot, 'graphs');
  const matgraphPath = resolve(graphsRoot, `${name}.matgraph.json`);

  const loaded = await loadGraph(matgraphPath);
  if (!loaded.graph) {
    throw new Error(`failed to load ${matgraphPath}: ${loaded.errors.join('; ')}`);
  }
  // Resolve MF references relative to the material file's own directory
  // (project-folder convention), matching the resolver's recursive behavior.
  // Work-project MFs (UE asset paths) get their pins from the local work-MF index.
  const { index: workMfIndex, warnings: indexWarnings } = await loadWorkMfIndex(workMfIndexPath);
  const resolved = await resolveMaterialFunctions(loaded.graph, dirname(matgraphPath), new Set(), { workMfIndex });

  // Collect all referenced MFs recursively
  const allFiles: Record<string, unknown> = { [`${name}.matgraph.json`]: loaded.graph };
  async function collect(g: typeof loaded.graph, currentRelPath: string) {
    if (!g) return;
    const currentDir = currentRelPath.includes('/') ? currentRelPath.slice(0, currentRelPath.lastIndexOf('/') + 1) : '';
    for (const node of g.nodes) {
      if (node.type !== 'MaterialFunctionCall') continue;
      const rel = (node.params?.MaterialFunction as string | undefined) ?? '';
      if (!rel) continue;
      // UE asset paths (/Game work MFs, /Engine built-ins) have no local sub-graph
      // file to inline; their pins come from the work-MF index, not from disk.
      if (rel.startsWith('/')) continue;
      const cleaned = (currentDir + rel.replace(/^\.\//, '')).replace(/\/\.\//g, '/');
      if (allFiles[cleaned]) continue;
      const sub = await loadGraph(resolve(graphsRoot, cleaned));
      if (sub.graph) { allFiles[cleaned] = sub.graph; await collect(sub.graph, cleaned); }
    }
  }
  await collect(loaded.graph, `${name}.matgraph.json`);

  const webIndexHtml = await readFile(resolve(distDir, 'index.html'), 'utf-8');
  const inlined = await inlineAssets(webIndexHtml, distDir);

  const dataInject = `<script>window.__UE_MAT_EXPORT__ = ${JSON.stringify({
    entry: `${name}.matgraph.json`,
    files: allFiles,
    derivedPins: resolved.derivedPins,
    warnings: [...materialStructureWarnings(loaded.graph), ...indexWarnings, ...resolved.warnings],
  })};</script>`;
  return inlined.replace('</body>', `${dataInject}</body>`);
}

export async function runHtmlExportCli() {
  const fullArgs = process.argv.slice(2);
  if (fullArgs[0] !== 'export' || !fullArgs[1]) {
    console.error('Usage: ue-mat-viewer export <name> [--out <path>]');
    process.exit(1);
  }
  const name = fullArgs[1];
  const outIdx = fullArgs.indexOf('--out');
  const outPath = outIdx >= 0 ? fullArgs[outIdx + 1] : `./${name}.html`;

  const repoRoot = process.cwd();
  const graphsRoot = resolve(repoRoot, 'graphs');
  const matgraphPath = resolve(graphsRoot, `${name}.matgraph.json`);
  // Reject traversal escapes: <name> is argv and must stay within graphs/.
  if (!isInside(graphsRoot, matgraphPath)) {
    console.error(`refusing to export: ${name} escapes graphs root`);
    process.exit(1);
  }

  const html = await buildSnapshot({ repoRoot, name });
  await writeFile(outPath, html);
  console.log(`exported to ${outPath}`);
}

async function inlineAssets(html: string, distDir: string): Promise<string> {
  let result = html;
  const scriptRe = /<script[^>]*src="([^"]+)"[^>]*><\/script>/g;
  const linkRe = /<link[^>]*href="([^"]+)"[^>]*\/?>/g;

  for (const match of Array.from(html.matchAll(scriptRe))) {
    const src = match[1].replace(/^\//, '');
    try {
      const js = await readFile(resolve(distDir, src), 'utf-8');
      // Use a replacer function to avoid interpreting $ metacharacters
      // in the inlined JS bundle (e.g. $& in regex .replace() calls would
      // re-insert the matched tag string, corrupting the output).
      const tag = match[0];
      const inlined = `<script type="module">${js}</script>`;
      result = result.replace(tag, () => inlined);
    } catch { /* ignore */ }
  }
  for (const match of Array.from(html.matchAll(linkRe))) {
    const href = match[1].replace(/^\//, '');
    if (!href.endsWith('.css')) continue;
    try {
      const css = await readFile(resolve(distDir, href), 'utf-8');
      const tag = match[0];
      const inlined = `<style>${css}</style>`;
      result = result.replace(tag, () => inlined);
    } catch { /* ignore */ }
  }
  return result;
}

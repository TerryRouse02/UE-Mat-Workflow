import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { loadGraph } from './graph-loader.js';
import { resolveMaterialFunctions } from './mf-resolver.js';
import { isInside } from './http-server.js';

async function main() {
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

  const loaded = await loadGraph(matgraphPath);
  if (!loaded.graph) {
    console.error(`failed to load ${matgraphPath}:`, loaded.errors);
    process.exit(1);
  }
  // Resolve MF references relative to the material file's own directory
  // (project-folder convention), matching the resolver's recursive behavior.
  const resolved = await resolveMaterialFunctions(loaded.graph, dirname(matgraphPath));

  // Collect all referenced MFs recursively
  const allFiles: Record<string, unknown> = { [`${name}.matgraph.json`]: loaded.graph };
  async function collect(g: typeof loaded.graph, currentRelPath: string) {
    if (!g) return;
    const currentDir = currentRelPath.includes('/') ? currentRelPath.slice(0, currentRelPath.lastIndexOf('/') + 1) : '';
    for (const node of g.nodes) {
      if (node.type !== 'MaterialFunctionCall') continue;
      const rel = (node.params?.MaterialFunction as string | undefined) ?? '';
      if (!rel) continue;
      const cleaned = (currentDir + rel.replace(/^\.\//, '')).replace(/\/\.\//g, '/');
      if (allFiles[cleaned]) continue;
      const sub = await loadGraph(resolve(graphsRoot, cleaned));
      if (sub.graph) { allFiles[cleaned] = sub.graph; await collect(sub.graph, cleaned); }
    }
  }
  await collect(loaded.graph, `${name}.matgraph.json`);

  const webIndexHtml = await readFile(resolve(repoRoot, 'viewer/web/dist/index.html'), 'utf-8');
  const inlined = await inlineAssets(webIndexHtml, resolve(repoRoot, 'viewer/web/dist'));

  const dataInject = `<script>window.__UE_MAT_EXPORT__ = ${JSON.stringify({
    entry: `${name}.matgraph.json`,
    files: allFiles,
    derivedPins: resolved.derivedPins,
    warnings: resolved.warnings,
  })};</script>`;
  const final = inlined.replace('</body>', `${dataInject}</body>`);

  await writeFile(outPath, final);
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
      result = result.replace(match[0], `<script type="module">${js}</script>`);
    } catch { /* ignore */ }
  }
  for (const match of Array.from(html.matchAll(linkRe))) {
    const href = match[1].replace(/^\//, '');
    if (!href.endsWith('.css')) continue;
    try {
      const css = await readFile(resolve(distDir, href), 'utf-8');
      result = result.replace(match[0], `<style>${css}</style>`);
    } catch { /* ignore */ }
  }
  return result;
}

main().catch((e) => { console.error(e); process.exit(1); });

import type { GraphPayload } from './protocol';

// Client-side "single HTML snapshot" — the browser counterpart to the server's
// CLI `ue-mat-viewer export`. Gathers the open material + its loaded local MF
// sub-graphs, inlines the served bundle (JS+CSS), injects the data as
// window.__UE_MAT_EXPORT__ (the same snapshot contract store.tsx reads), and
// downloads it. Only the loaded graphs are included — visit an MF to embed it.

function norm(p: string): string { return p.replace(/^\.\//, ''); }
function resolveRel(rel: string, basePath: string): string {
  const dir = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/') + 1) : '';
  return (dir + rel.replace(/^\.\//, '')).replace(/\/\.\//g, '/');
}

export async function exportHtmlSnapshot(
  entryPath: string,
  graphs: Record<string, GraphPayload>,
): Promise<{ ok: boolean; error?: string; count: number }> {
  const entry = graphs[entryPath] ?? graphs[norm(entryPath)];
  if (!entry) return { ok: false, error: '沒有開啟中的圖可匯出。', count: 0 };

  // Collect the entry + recursively-referenced local MF graphs that are loaded.
  const files: Record<string, unknown> = {};
  const seen = new Set<string>();
  const collect = (path: string) => {
    const key = norm(path);
    if (seen.has(key)) return;
    const gp = graphs[key] ?? graphs[path];
    if (!gp) return;
    seen.add(key);
    files[key] = gp.graph;
    for (const n of gp.graph.nodes) {
      if (n.type !== 'MaterialFunctionCall') continue;
      const rel = (n.params?.MaterialFunction as string | undefined) ?? '';
      if (!rel || rel.startsWith('/')) continue; // UE asset paths have no local file
      collect(resolveRel(rel, key));
    }
  };
  collect(entryPath);

  const inject = {
    entry: norm(entryPath),
    files,
    derivedPins: entry.derivedPins ?? {},
    warnings: entry.warnings ?? [],
  };

  // Fetch the served template, inline its hashed JS/CSS assets.
  let html: string;
  try {
    html = await (await fetch('/', { cache: 'no-store' })).text();
  } catch (e) {
    return { ok: false, error: '無法讀取頁面模板:' + (e as Error).message, count: 0 };
  }
  const assets = new Map<string, string>();
  for (const m of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
    const u = m[1];
    if (assets.has(u)) continue;
    try { assets.set(u, await (await fetch(u, { cache: 'no-store' })).text()); } catch { /* skip */ }
  }
  html = html.replace(/<script[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (full, src) =>
    assets.has(src) ? `<script type="module">${assets.get(src)}</script>` : full);
  html = html.replace(/<link[^>]*\bhref="([^"]+\.css)"[^>]*\/?>/g, (full, href) =>
    assets.has(href) ? `<style>${assets.get(href)}</style>` : full);

  // Escape '<' so any "</script>" inside the data can't close the tag.
  const json = JSON.stringify(inject).replace(/</g, '\\u003c');
  html = html.replace('</body>', `<script>window.__UE_MAT_EXPORT__ = ${json};</script></body>`);

  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (norm(entryPath).split('/').pop()?.replace(/\.matgraph\.json$/, '') || 'snapshot') + '.html';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return { ok: true, count: Object.keys(files).length };
}

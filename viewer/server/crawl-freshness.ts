import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { CrawlFreshness } from './crawl-types.js';

export const freshnessPath = (repoRoot: string) =>
  resolve(repoRoot, 'agent-pack', 'crawl-freshness.json');

export async function loadFreshness(repoRoot: string): Promise<CrawlFreshness> {
  try {
    return JSON.parse(await readFile(freshnessPath(repoRoot), 'utf-8')) as CrawlFreshness;
  } catch {
    return {};
  }
}

export async function recordFreshness(
  repoRoot: string,
  kind: keyof CrawlFreshness,
  nowIso: string,
): Promise<void> {
  const cur = await loadFreshness(repoRoot);
  cur[kind] = nowIso;
  const p = freshnessPath(repoRoot);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(cur, null, 2) + '\n', 'utf-8');
}

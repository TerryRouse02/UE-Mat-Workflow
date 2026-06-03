// Runtime loader for the agent-pack data (node DB, export metadata, engine-MF
// index). In live mode we fetch these from the local server's /api/agent-pack
// endpoint so a web-triggered crawl shows up WITHOUT a rebuild; in snapshot/
// offline mode we use the build-time-baked copies. The bundle shape is identical
// either way, so dbContext exposes the same value to every consumer.

import { bakedBundles, type VersionBundle } from './dbRegistry';
import { bakedEngineMf, engineMfFrom, type EngineMfIndex } from './engineMfRegistry';
import type { NodeDB } from '../../server/db-types';
import type { ExportMeta } from './export/export-meta-types';
import { latestOf } from './versionUtil';

export interface RegistryData {
  bundles: Map<string, VersionBundle>;
  engineMf: Map<string, EngineMfIndex>;
  versions: string[];
}

export function bakedRegistry(): RegistryData {
  const bundles = bakedBundles();
  return { bundles, engineMf: bakedEngineMf(), versions: [...bundles.keys()].sort() };
}

async function getJson<T>(file: string): Promise<T> {
  const r = await fetch(`/api/agent-pack/${file}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`GET ${file} -> ${r.status}`);
  return r.json() as Promise<T>;
}

// Re-fetch the committed agent-pack data from the local server. The set of
// versions is taken from the baked manifest (the web only knows the versions it
// was built with). Any file that fails to fetch falls back to its baked copy, so
// a partial/absent server never blanks the UI.
export async function fetchRegistry(): Promise<RegistryData> {
  const baked = bakedRegistry();
  const bundles = new Map<string, VersionBundle>();
  const engineMf = new Map(baked.engineMf);
  for (const v of baked.versions) {
    try {
      const [db, exportMeta] = await Promise.all([
        getJson<NodeDB>(`nodes-ue${v}.json`),
        getJson<ExportMeta>(`nodes-ue${v}.export.json`),
      ]);
      bundles.set(v, { ueVersion: v, db, exportMeta });
    } catch {
      const b = baked.bundles.get(v);
      if (b) bundles.set(v, b);
    }
    try {
      engineMf.set(v, await getJson<EngineMfIndex>(`enginemf-index-ue${v}.json`));
    } catch {
      // keep the baked engine-MF index for this version
    }
  }
  return { bundles, engineMf, versions: [...bundles.keys()].sort() };
}

export function resolveBundle(reg: RegistryData, version: string | undefined): VersionBundle | null {
  return version ? reg.bundles.get(version) ?? null : null;
}

export function latestBundleOf(reg: RegistryData): VersionBundle | null {
  const latest = latestOf(reg.versions);
  return latest ? reg.bundles.get(latest) ?? null : null;
}

export function resolveEngineMf(reg: RegistryData, version: string | undefined): EngineMfIndex | null {
  return engineMfFrom(reg.engineMf, version);
}

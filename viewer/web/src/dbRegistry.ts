// Multi-version node-DB registry.
//
// Every UE version ships as a PAIR of files in agent-pack/:
//   nodes-ue<ver>.json         — the authoring DB (the AI's vocabulary)
//   nodes-ue<ver>.export.json  — the matching "Export to UE" metadata
// Both files declare their own `ueVersion`, and we pair them by that field
// (not by filename) so the mapping is robust to naming. They are bundled at
// build time, so the single-file HTML export stays self-contained.
//
// To add a UE version: generate both files via the UE commandlet
// (tools/node-t3d-metadata) and drop them into agent-pack/. No code change
// here — the glob picks them up on the next build.
import type { NodeDB } from '../../server/db-types';
import type { ExportMeta } from './export/export-meta-types';
import { latestOf } from './versionUtil';

export interface VersionBundle {
  ueVersion: string;
  db: NodeDB;
  exportMeta: ExportMeta;
}

// `nodes-ue*.json` matches BOTH the authoring DBs and the *.export.json files;
// we split them apart below by their path.
const modules = import.meta.glob('../../../agent-pack/nodes-ue*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const dbs = new Map<string, NodeDB>();
const metas = new Map<string, ExportMeta>();
for (const [path, mod] of Object.entries(modules)) {
  if (path.includes('.export.json')) {
    const m = mod as ExportMeta;
    if (m?.ueVersion) metas.set(m.ueVersion, m);
  } else {
    const d = mod as NodeDB;
    if (d?.ueVersion) dbs.set(d.ueVersion, d);
  }
}

const registry = new Map<string, VersionBundle>();
for (const [ueVersion, db] of dbs) {
  const exportMeta = metas.get(ueVersion);
  if (exportMeta) registry.set(ueVersion, { ueVersion, db, exportMeta });
}

export const SUPPORTED_VERSIONS: string[] = [...registry.keys()].sort();
const LATEST = latestOf(SUPPORTED_VERSIONS);

// The build-time-baked bundles, used as the snapshot/offline source and as the
// per-file fallback when a runtime fetch fails. (Runtime fetch lives in
// agentPackClient.ts so a crawl can refresh the data without a rebuild.)
export function bakedBundles(): Map<string, VersionBundle> {
  return registry;
}

// The bundle whose ueVersion matches `ueVersion`, or null if that version has
// no DB pair on disk (i.e. it is unsupported).
export function resolveVersion(ueVersion: string | undefined): VersionBundle | null {
  if (!ueVersion) return null;
  return registry.get(ueVersion) ?? null;
}

// The highest available version's bundle — used as a best-effort fallback for
// rendering an unsupported graph and for the reference node library.
export function latestBundle(): VersionBundle | null {
  return LATEST ? registry.get(LATEST) ?? null : null;
}

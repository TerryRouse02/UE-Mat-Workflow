import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { bakedRegistry, fetchRegistry, fetchWorkMf, resolveBundle, latestBundleOf, resolveEngineMf, type RegistryData } from './agentPackClient';
import type { NodeDB } from '../../server/db-types';
import type { ExportMeta } from './export/export-meta-types';
import type { EngineMfIndex } from './engineMfRegistry';
import type { WorkMfIndex } from '../../server/workmf-types';

interface DbValue {
  version: string | undefined;   // the active graph's ueVersion (undefined if none open)
  supported: boolean;            // is `version` backed by a DB pair?
  db: NodeDB;                    // always usable: active version's DB, else latest
  exportMeta: ExportMeta;        // always usable: active version's metadata, else latest
  engineMf: EngineMfIndex | null;// active version's engine-MF index (best-effort)
  workMf: WorkMfIndex | null;    // the user's own project MFs (live mode only; never bundled)
  supportedVersions: string[];
}

const DbC = createContext<DbValue | null>(null);

// Derives the active node DB + export metadata + engine-MF index from the open
// graph's `ueVersion`. The data comes from the build-time bundle in snapshot/
// offline mode, or is fetched from the local server in live mode so a crawl
// refreshes it without a rebuild (re-fetch is keyed on `metadataVersion`).
export function DbProvider({ children }: { children: React.ReactNode }) {
  const { state } = useStore();
  const current = state.breadcrumb[state.breadcrumb.length - 1];
  const version = current ? state.graphs[current]?.graph.ueVersion : undefined;

  // Start from the build-time-baked data so snapshot/offline render instantly (no
  // flash) and live mode has data on the first paint; live mode then overrides it
  // with a fetch, and re-fetches when metadataVersion bumps after a crawl.
  const [registry, setRegistry] = useState<RegistryData>(() => bakedRegistry());

  useEffect(() => {
    if (state.connection !== 'live') return; // snapshot/offline keep the baked data
    let cancelled = false;
    fetchRegistry()
      .then((r) => { if (!cancelled) setRegistry(r); })
      .catch(() => { /* server unreachable mid-session — keep the current data */ });
    return () => { cancelled = true; };
  }, [state.connection, state.metadataVersion]);

  // The work-MF index is server-only (the user's own /Game MFs) — never baked, never
  // bundled. So it loads only in live mode, and re-loads after a WorkMF crawl
  // (workMfVersion bump). It starts null and is never fetched in snapshot/offline, so
  // an exported HTML never shows project asset paths. A transient reconnect keeps the
  // last value (no flicker) — same posture as the agent-pack fetch above.
  const [workMf, setWorkMf] = useState<WorkMfIndex | null>(null);
  useEffect(() => {
    if (state.connection !== 'live') return;
    let cancelled = false;
    fetchWorkMf()
      .then((w) => { if (!cancelled) setWorkMf(w); })
      .catch(() => { /* server unreachable mid-session — keep current */ });
    return () => { cancelled = true; };
  }, [state.connection, state.workMfVersion]);

  const value = useMemo<DbValue | null>(() => {
    const active = resolveBundle(registry, version);
    const bundle = active ?? latestBundleOf(registry);
    if (!bundle) return null; // no DB at all (empty agent-pack) — hold the gate
    return {
      version,
      // No graph open is not "unsupported"; an open graph with no DB pair is.
      supported: !!active || version === undefined,
      db: bundle.db,
      exportMeta: bundle.exportMeta,
      engineMf: resolveEngineMf(registry, version),
      workMf,
      supportedVersions: registry.versions,
    };
  }, [registry, version, workMf]);

  // Hold the gate only when there is genuinely no bundle to show — preserves the
  // non-null db/exportMeta contract; with baked init this is effectively never hit.
  if (!value) return <div className="db-loading">Loading node metadata…</div>;
  return <DbC.Provider value={value}>{children}</DbC.Provider>;
}

export function useDb(): DbValue {
  const c = useContext(DbC);
  if (!c) throw new Error('useDb outside DbProvider');
  return c;
}

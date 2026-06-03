import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useStore } from './store';
import { bakedRegistry, fetchRegistry, resolveBundle, latestBundleOf, resolveEngineMf, type RegistryData } from './agentPackClient';
import type { NodeDB } from '../../server/db-types';
import type { ExportMeta } from './export/export-meta-types';
import type { EngineMfIndex } from './engineMfRegistry';

interface DbValue {
  version: string | undefined;   // the active graph's ueVersion (undefined if none open)
  supported: boolean;            // is `version` backed by a DB pair?
  db: NodeDB;                    // always usable: active version's DB, else latest
  exportMeta: ExportMeta;        // always usable: active version's metadata, else latest
  engineMf: EngineMfIndex | null;// active version's engine-MF index (best-effort)
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

  const [registry, setRegistry] = useState<RegistryData | null>(null);

  useEffect(() => {
    if (state.connection === 'snapshot') { setRegistry(bakedRegistry()); return; }
    let cancelled = false;
    fetchRegistry()
      .then((r) => { if (!cancelled) setRegistry(r); })
      .catch(() => { if (!cancelled) setRegistry(bakedRegistry()); });
    return () => { cancelled = true; };
  }, [state.connection, state.metadataVersion]);

  const value = useMemo<DbValue | null>(() => {
    if (!registry) return null;
    const active = resolveBundle(registry, version);
    const bundle = active ?? latestBundleOf(registry);
    return {
      version,
      // No graph open is not "unsupported"; an open graph with no DB pair is.
      supported: !!active || version === undefined,
      db: bundle?.db as NodeDB,
      exportMeta: bundle?.exportMeta as ExportMeta,
      engineMf: resolveEngineMf(registry, version),
      supportedVersions: registry.versions,
    };
  }, [registry, version]);

  // Loading gate: hold children until the first load resolves so db/exportMeta
  // stay non-null for every consumer (App, NodeLibrary, Inspector, Header).
  if (!value) return <div className="db-loading">Loading node metadata…</div>;
  return <DbC.Provider value={value}>{children}</DbC.Provider>;
}

export function useDb(): DbValue {
  const c = useContext(DbC);
  if (!c) throw new Error('useDb outside DbProvider');
  return c;
}

import React, { createContext, useContext, useMemo } from 'react';
import { useStore } from './store';
import { resolveVersion, latestBundle, SUPPORTED_VERSIONS } from './dbRegistry';
import type { NodeDB } from '../../server/db-types';
import type { ExportMeta } from './export/export-meta-types';

interface DbValue {
  version: string | undefined;   // the active graph's ueVersion (undefined if none open)
  supported: boolean;            // is `version` backed by a DB pair on disk?
  db: NodeDB;                    // always usable: active version's DB, else latest
  exportMeta: ExportMeta;        // always usable: active version's metadata, else latest
  supportedVersions: string[];
}

const DbC = createContext<DbValue | null>(null);

// Derives the active node DB + export metadata from the currently-open graph's
// `ueVersion`. Falls back to the latest available version so the UI never goes
// blank, while `supported` lets the canvas warn and block export for a version
// we don't actually ship a DB for.
export function DbProvider({ children }: { children: React.ReactNode }) {
  const { state } = useStore();
  const current = state.breadcrumb[state.breadcrumb.length - 1];
  const version = current ? state.graphs[current]?.graph.ueVersion : undefined;

  const value = useMemo<DbValue>(() => {
    const active = resolveVersion(version);
    const bundle = active ?? latestBundle();
    return {
      version,
      // No graph open is not "unsupported"; an open graph with no DB pair is.
      supported: !!active || version === undefined,
      db: bundle?.db as NodeDB,
      exportMeta: bundle?.exportMeta as ExportMeta,
      supportedVersions: SUPPORTED_VERSIONS,
    };
  }, [version]);

  return <DbC.Provider value={value}>{children}</DbC.Provider>;
}

export function useDb(): DbValue {
  const c = useContext(DbC);
  if (!c) throw new Error('useDb outside DbProvider');
  return c;
}

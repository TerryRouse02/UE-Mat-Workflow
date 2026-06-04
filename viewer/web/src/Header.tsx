import { useEffect, useState } from 'react';
import { useStore } from './store';
import { formatSyncAgo } from './syncStatus';
import { graphToUET3D } from './export/ueT3D';
import { ImportModal } from './ImportModal';
import { useDb } from './dbContext';
import type { MatGraph, DerivedPins } from './protocol';
import type { ToastItem } from './Toast';
import './header.css';

export interface HeaderProps {
  graph?: MatGraph;
  derivedPins?: Record<string, DerivedPins>;
  positions: Record<string, { x: number; y: number }>;
  pushToast: (t: Omit<ToastItem, 'id'>) => void;
}

function WatchPill() {
  const { state } = useStore();
  const [, force] = useState(0);
  useEffect(() => { const id = setInterval(() => force(n => n + 1), 1000); return () => clearInterval(id); }, []);
  if (state.connection === 'snapshot') return <span className="watch-pill snap"><span className="watch-dot" /> snapshot</span>;
  if (state.connection === 'reconnecting') return <span className="watch-pill warn"><span className="watch-dot" /> reconnecting…</span>;
  const ago = state.lastUpdate ? formatSyncAgo(Date.now() - state.lastUpdate) : '';
  return <span className="watch-pill"><span className="watch-dot live" /> watching · synced {ago}</span>;
}

export function Header({ graph, derivedPins, positions, pushToast }: HeaderProps) {
  const { state, popBreadcrumb, open } = useStore();
  const { exportMeta, supported } = useDb();
  const [importOpen, setImportOpen] = useState(false);
  // Import writes to disk via the server; a static export snapshot has no server.
  const canImport = state.connection !== 'snapshot';

  const doExport = async () => {
    if (!graph || !derivedPins || !supported) return;
    // The MF content root (where local MFs live in UE, for auto-link asset paths) is
    // set in the Config tab and persisted in localStorage. Read it fresh at export time.
    const mfRoot = (localStorage.getItem('ue-mf-root') || localStorage.getItem('ue-workmf-root') || '/Game').trim() || '/Game';
    const { text, warnings } = graphToUET3D(graph, positions, exportMeta, derivedPins, { mfContentRoot: mfRoot });
    const count = text ? (text.match(/^Begin Object Class=\/Script\/UnrealEd\.MaterialGraphNode/gm)?.length ?? 0) : 0;
    try {
      await navigator.clipboard.writeText(text);
      const message = graph.type === 'MaterialFunction'
        ? `Copied ${count} nodes. Create a Material Function "${graph.name}" under ${mfRoot} and paste here.`
        : `Copied ${count} nodes — paste into UE's Material Editor.`;
      pushToast({ variant: warnings.length ? 'warning' : 'success', title: 'Exported to UE', message, detail: warnings });
    } catch {
      pushToast({ variant: 'error', title: 'Clipboard blocked', message: 'Copy manually from the console.', detail: warnings });
      // eslint-disable-next-line no-console
      console.log(text);
    }
  };

  const niceName = (p: string) => p.replace(/^functions\//, '').replace('.matgraph.json', '');

  return (
    <header className="hdr">
      <div className="hdr-left">
        <div className="brand"><span className="brand-mark">▦</span><span className="brand-name">UE·MAT</span><span className="brand-sub">workflow</span></div>
        <div className="crumb">
          {state.breadcrumb.map((p, i) => (
            <span key={i} className="crumb-seg">
              {i > 0 && <span className="crumb-sep">▸</span>}
              <button className={i === state.breadcrumb.length - 1 ? 'crumb-cur' : 'crumb-link'} onClick={() => popBreadcrumb(i)}>{niceName(p)}</button>
            </span>
          ))}
        </div>
      </div>
      <div className="hdr-right">
        <WatchPill />
        <button className="btn-export" onClick={doExport} disabled={!graph || !supported}
          title={graph && !supported ? `UE ${state.graphs[state.breadcrumb[state.breadcrumb.length - 1]]?.graph.ueVersion ?? ''} not supported — export disabled` : undefined}>導出到 UE</button>
        <button className="btn-import" onClick={() => setImportOpen(true)} disabled={!canImport}
          title={canImport ? 'Paste a UE material selection to import' : 'Import needs the live viewer server'}>導入</button>
      </div>
      {importOpen && (
        <ImportModal exportMeta={exportMeta} open={open} pushToast={pushToast} onClose={() => setImportOpen(false)} />
      )}
    </header>
  );
}

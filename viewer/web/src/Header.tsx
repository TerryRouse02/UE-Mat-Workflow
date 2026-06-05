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

// Live / reconnecting / snapshot, with a freshness read-out when live.
function ConnChip() {
  const { state } = useStore();
  const [, force] = useState(0);
  useEffect(() => { const id = setInterval(() => force(n => n + 1), 1000); return () => clearInterval(id); }, []);
  if (state.connection === 'snapshot') return <span className="conn snapshot"><span className="dot" /> 快照</span>;
  if (state.connection === 'reconnecting') return <span className="conn reconnecting"><span className="dot" /> 連線中…</span>;
  const ago = state.lastUpdate ? formatSyncAgo(Date.now() - state.lastUpdate) : '';
  return <span className="conn live"><span className="dot" /> Live · 已同步 {ago}</span>;
}

export function Header({ graph, derivedPins, positions, pushToast }: HeaderProps) {
  const { state, popBreadcrumb, open } = useStore();
  const { exportMeta, supported, version } = useDb();
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
    <header className="chrome">
      <div className="logo">
        <span className="mark">M</span>
        <span className="t">UE·MAT<span className="sub">workflow</span></span>
        {version && <span className={`ver ${!supported ? 'warn' : ''}`} title={supported ? `Node DB: UE ${version}` : `UE ${version} — no DB shipped`}>UE {version}</span>}
      </div>
      <nav className="bcrumb">
        {state.breadcrumb.map((p, i) => {
          const last = i === state.breadcrumb.length - 1;
          return (
            <span key={i} className="seg">
              {i > 0 && <span className="sep">›</span>}
              {last
                ? <span className="cur">{niceName(p)}</span>
                : <button onClick={() => popBreadcrumb(i)}>{niceName(p)}</button>}
            </span>
          );
        })}
      </nav>
      <div className="spacer" />
      {/* Command palette is a follow-up; the affordance is shown for chrome balance. */}
      <button className="searchbtn" title="命令面板（即將推出）" type="button">
        <span>⌕</span><span className="stext">搜尋節點與指令</span><kbd>⌘K</kbd>
      </button>
      <ConnChip />
      <button className="btn" onClick={() => setImportOpen(true)} disabled={!canImport}
        title={canImport ? 'Paste a UE material selection to import' : 'Import needs the live viewer server'}>導入</button>
      <button className="btn primary" onClick={doExport} disabled={!graph || !supported}
        title={graph && !supported ? `UE ${version ?? ''} not supported — export disabled` : undefined}>導出到 UE</button>
      {importOpen && (
        <ImportModal exportMeta={exportMeta} open={open} pushToast={pushToast} onClose={() => setImportOpen(false)} />
      )}
    </header>
  );
}

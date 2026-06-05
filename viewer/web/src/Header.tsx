import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { formatSyncAgo } from './syncStatus';
import { graphToUET3D } from './export/ueT3D';
import { exportHtmlSnapshot } from './exportSnapshot';
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
  onOpenPalette: () => void;
  onGoConfig: () => void;
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

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal" style={{ width: 'min(420px,92vw)' }} onClick={e => e.stopPropagation()}>
        <div className="modal-head"><span className="mt">鍵盤快捷鍵</span></div>
        <div className="modal-body">
          <div className="kbd-row"><span>開啟命令面板</span><span><kbd>⌘</kbd> <kbd>K</kbd></span></div>
          <div className="kbd-row"><span>命令面板:上 / 下移動</span><span><kbd>↑</kbd> <kbd>↓</kbd></span></div>
          <div className="kbd-row"><span>命令面板:開啟所選</span><span><kbd>Enter</kbd></span></div>
          <div className="kbd-row"><span>關閉面板 / 對話框</span><span><kbd>Esc</kbd></span></div>
        </div>
        <div className="modal-foot"><button className="btn sm" onClick={onClose}>關閉</button></div>
      </div>
    </div>
  );
}

export function Header({ graph, derivedPins, positions, pushToast, onOpenPalette, onGoConfig }: HeaderProps) {
  const { state, popBreadcrumb, open } = useStore();
  const { exportMeta, supported, version } = useDb();
  const [importOpen, setImportOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  // Import writes to disk via the server; a static export snapshot has no server.
  const canImport = state.connection !== 'snapshot';
  // The HTML snapshot fetches the served bundle — only possible against a live server.
  const entryPath = state.breadcrumb[0];
  const canSnapshot = state.connection === 'live' && !!entryPath && !!state.graphs[entryPath];

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => { if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMenuOpen(false); };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onEsc); };
  }, [menuOpen]);

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

  const doSnapshot = async () => {
    setMenuOpen(false);
    const r = await exportHtmlSnapshot(entryPath, state.graphs);
    if (r.ok) pushToast({ variant: 'success', title: '已匯出 HTML 快照', message: `包含 ${r.count} 個圖檔,已開始下載。` });
    else pushToast({ variant: 'error', title: '匯出失敗', message: r.error ?? '' });
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
              {last ? <span className="cur">{niceName(p)}</span> : <button onClick={() => popBreadcrumb(i)}>{niceName(p)}</button>}
            </span>
          );
        })}
      </nav>
      <div className="spacer" />
      <button className="searchbtn" title="命令面板" type="button" onClick={onOpenPalette}>
        <span>⌕</span><span className="stext">搜尋節點與指令</span><kbd>⌘K</kbd>
      </button>
      <ConnChip />
      <button className="btn" onClick={() => setImportOpen(true)} disabled={!canImport}
        title={canImport ? 'Paste a UE material selection to import' : 'Import needs the live viewer server'}>導入</button>
      <button className="btn primary" onClick={doExport} disabled={!graph || !supported}
        title={graph && !supported ? `UE ${version ?? ''} not supported — export disabled` : undefined}>導出到 UE</button>
      <button className="iconbtn" title="設定 / 爬取" onClick={onGoConfig} aria-label="設定 / 爬取">⚙</button>
      <div className="more-wrap" ref={moreRef}>
        <button className={`iconbtn ${menuOpen ? 'on' : ''}`} title="更多" onClick={() => setMenuOpen(o => !o)} aria-label="更多">⋯</button>
        {menuOpen && (
          <div className="menu">
            <div className="menu-label">匯出</div>
            <button className="menu-item" onClick={doSnapshot} disabled={!canSnapshot}
              title={canSnapshot ? undefined : '需要連線中的本機 server,且有開啟的圖'}>
              <span className="mi-ico">⤓</span> 匯出單一 HTML 快照
            </button>
            <div className="menu-div" />
            <button className="menu-item" onClick={() => { setMenuOpen(false); setShortcutsOpen(true); }}>
              <span className="mi-ico">⌨</span> 鍵盤快捷鍵 <span className="mi-hint">?</span>
            </button>
          </div>
        )}
      </div>
      {importOpen && <ImportModal exportMeta={exportMeta} open={open} pushToast={pushToast} onClose={() => setImportOpen(false)} />}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
    </header>
  );
}

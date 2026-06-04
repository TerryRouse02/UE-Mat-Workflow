import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { formatSyncAgo } from './syncStatus';
import { hasMaterialFunctionCall } from './graphInfo';
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

// Web-triggered crawl: runs the local UE metadata crawl from the browser. Only
// shown with a live server; enabled only when the local env probe is ready.
function CrawlControl({ pushToast }: { pushToast: (t: Omit<ToastItem, 'id'>) => void }) {
  const { state, startCrawl } = useStore();
  const [open, setOpen] = useState(false);
  const [workmfRoot, setWorkmfRoot] = useState(() => localStorage.getItem('ue-workmf-root') || '/Game');
  const { env, crawl, connection } = state;
  const live = connection === 'live';
  const ready = live && !!env?.ready;
  const running = crawl.status === 'running';

  // Toast on completion so the user gets feedback even with the popover closed.
  const prev = useRef(crawl.status);
  useEffect(() => {
    if (prev.current === 'running' && crawl.status !== 'running') {
      if (crawl.status === 'success') pushToast({ variant: 'success', title: '元資料已更新', message: `${crawl.kind} 爬取完成，已即時刷新。` });
      else if (crawl.status === 'error') pushToast({ variant: 'error', title: '爬取失敗', message: crawl.logs.at(-1) ?? `exit ${crawl.exitCode}`, detail: crawl.logs.slice(-8) });
    }
    prev.current = crawl.status;
  }, [crawl.status, crawl.kind, crawl.exitCode, crawl.logs, pushToast]);

  // Snapshot/offline has no server to crawl with — hide the control entirely.
  if (connection === 'snapshot') return null;

  const failing = env ? Object.entries(env.checks).filter(([, c]) => !c.ok).map(([k, c]) => `${k}: ${c.detail}`) : [];
  const title = ready ? '爬取本機 UE 元資料' : live ? `環境未就緒：\n${failing.join('\n') || '檢查中…'}` : '需要本機 viewer server';

  return (
    <div className="export-group">
      <button className="btn-import" disabled={!ready && !running} onClick={() => setOpen(o => !o)} title={title}>
        {running ? '爬取中…' : '爬取'}
      </button>
      {open && (
        <div className="mfroot-popover" style={{ minWidth: 280 }}>
          {ready && !running && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label>爬取本機 UE 元資料 <span className="hint-txt">在這台 Windows + UE 機器上執行</span></label>
              <button onClick={() => startCrawl('export')}>重爬節點匯出 (nodes-ue5.7.export.json)</button>
              <button onClick={() => startCrawl('enginemf')}>重爬引擎 MF (enginemf-index)</button>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, borderTop: '1px solid var(--line, #2a2a2a)', paddingTop: 6 }}>
                <button onClick={() => startCrawl('workmf', workmfRoot.trim() || '/Game')}>重爬專案 MF (workmf-index)</button>
                <label className="hint-txt">Content Root（專案內要爬的資料夾，逗號分隔多個）</label>
                <input value={workmfRoot} onChange={e => { setWorkmfRoot(e.target.value); localStorage.setItem('ue-workmf-root', e.target.value); }} placeholder="/Game" />
                <span className="hint-txt" style={{ wordBreak: 'break-all' }}>
                  專案：{env?.projectPath || '（讀 local.config.json）'}
                </span>
              </div>
            </div>
          )}
          {!ready && !running && (
            <div className="hint-txt" style={{ whiteSpace: 'pre-wrap' }}>{live ? `環境未就緒：\n${failing.join('\n')}` : '需要本機 viewer server'}</div>
          )}
          {running && <div className="hint-txt">{crawl.kind} 執行中…（編輯器啟動需數分鐘）</div>}
          {crawl.logs.length > 0 && (
            <pre style={{ maxHeight: 160, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap', marginTop: 6 }}>{crawl.logs.slice(-12).join('\n')}</pre>
          )}
        </div>
      )}
    </div>
  );
}

export function Header({ graph, derivedPins, positions, pushToast }: HeaderProps) {
  const { state, popBreadcrumb, open } = useStore();
  const { exportMeta, supported } = useDb();
  const [mfRoot, setMfRoot] = useState(() => localStorage.getItem('ue-mf-root') || '/Game/');
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const usesMF = hasMaterialFunctionCall(graph);
  // Import writes to disk via the server; a static export snapshot has no server.
  const canImport = state.connection !== 'snapshot';

  const doExport = async () => {
    if (!graph || !derivedPins || !supported) return;
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
        <CrawlControl pushToast={pushToast} />
        <div className="export-group">
          <button className="btn-export" onClick={doExport} disabled={!graph || !supported}
            title={graph && !supported ? `UE ${state.graphs[state.breadcrumb[state.breadcrumb.length - 1]]?.graph.ueVersion ?? ''} not supported — export disabled` : undefined}>導出到 UE</button>
          <button className={`btn-mfroot ${usesMF ? 'hint' : ''}`} title="MF content root" onClick={() => setPopoverOpen(o => !o)}>⚙</button>
          {popoverOpen && (
            <div className="mfroot-popover">
              <label>MF content root <span className="hint-txt">where your MaterialFunctions live in UE</span></label>
              <input value={mfRoot} onChange={e => { setMfRoot(e.target.value); localStorage.setItem('ue-mf-root', e.target.value); }} />
            </div>
          )}
        </div>
        <button className="btn-import" onClick={() => setImportOpen(true)} disabled={!canImport}
          title={canImport ? 'Paste a UE material selection to import' : 'Import needs the live viewer server'}>導入</button>
      </div>
      {importOpen && (
        <ImportModal exportMeta={exportMeta} open={open} pushToast={pushToast} onClose={() => setImportOpen(false)} />
      )}
    </header>
  );
}

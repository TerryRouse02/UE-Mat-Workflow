import { useEffect, useState, useRef, useCallback } from 'react';
import { StoreProvider, useStore } from './store';
import { Chrome } from './Chrome';
import { Banner } from './Banner';
import { Sidebar } from './Sidebar';
import { Graph } from './Graph';
import { Inspector } from './Inspector';
import { ToastStack, type ToastItem } from './Toast';
import { ImportModal } from './ImportModal';
import { BigGraphConfirm } from './BigGraphConfirm';
import { CommandPalette } from './CommandPalette';
import { DbProvider, useDb } from './dbContext';
import { shouldConfirmOpen } from './largeGraphGate';
import { graphToUET3D } from './export/ueT3D';
import type { FileEntry } from './protocol';

export type AppTab = 'files' | 'nodes' | 'config';

function srcToKind(src: string): 'workmf' | 'projectmat' | 'enginemf' | 'export' {
  if (src === 'workmf') return 'workmf';
  if (src === 'projectmat') return 'projectmat';
  if (src === 'enginemf') return 'enginemf';
  return 'export';
}

function Body() {
  const { state, open, enterMF, startCrawl } = useStore();
  const { db, exportMeta, supported } = useDb();

  // ─── Lifted cross-cutting state ────────────────────────────────────────────
  const [tab, setTab] = useState<AppTab>('files');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirmFile, setConfirmFile] = useState<FileEntry | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // Two independent crawl scopes (separate UE content roots):
  //  • mfRoot  — "爬取專案 MF" (workmf) AND read by T3D export (mfContentRoot).
  //  • matRoot — "爬取專案母材質" (projectmat). Kept apart so crawling base
  //    materials never pulls in the MF folder, and vice-versa.
  const [mfRoot, setMfRootState] = useState<string>(
    () => (localStorage.getItem('ue-mf-root') || localStorage.getItem('ue-workmf-root') || '/Game').trim() || '/Game'
  );
  const setMfRoot = (v: string) => {
    localStorage.setItem('ue-mf-root', v);
    setMfRootState(v);
  };
  const [matRoot, setMatRootState] = useState<string>(
    () => (localStorage.getItem('ue-mat-root') || '/Game').trim() || '/Game'
  );
  const setMatRoot = (v: string) => {
    localStorage.setItem('ue-mat-root', v);
    setMatRootState(v);
  };

  // Banner dismiss state — reset when engineMismatch reappears
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const engineMismatch = !!db && !supported;
  useEffect(() => { if (engineMismatch) setBannerDismissed(false); }, [engineMismatch]);

  // ─── Per-graph state ────────────────────────────────────────────────────────
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  // focusReq is tagged with path so a stale request never fires on a different graph.
  const [focusReq, setFocusReq] = useState<{ id: string; nonce: number; path: string } | null>(null);

  useEffect(() => {
    if (!state.currentPath && state.files.length > 0) {
      if (!shouldConfirmOpen(state.files[0].nodeCount)) open(state.files[0].path);
    }
  }, [state.files, state.currentPath, open]);

  const current = state.breadcrumb[state.breadcrumb.length - 1];
  const payload = current ? state.graphs[current] : undefined;

  const focusNode = useCallback((id: string) => {
    if (current) setFocusReq(prev => ({ id, nonce: (prev?.nonce ?? 0) + 1, path: current }));
  }, [current]);

  const pushToast = useCallback((t: Omit<ToastItem, 'id'>) =>
    setToasts(ts => [...ts, { id: Date.now() + Math.random(), ...t }]), []);
  const closeToast = (id: number) => setToasts(ts => ts.filter(t => t.id !== id));

  // Reset per-graph view state on navigation.
  useEffect(() => { setSelectedNodeId(null); setFocusReq(null); }, [current]);

  // Hot-reload notice
  const prevPayloadRef = useRef(payload);
  const prevCurrentRef = useRef(current);
  useEffect(() => {
    const samePath = prevCurrentRef.current === current;
    if (samePath && prevPayloadRef.current && payload && prevPayloadRef.current !== payload && state.connection === 'live') {
      pushToast({ variant: 'info', title: 'Graph updated', message: `${current} reloaded from disk.` });
    }
    prevPayloadRef.current = payload;
    prevCurrentRef.current = current;
  }, [payload, current, state.connection, pushToast]);

  // Crawl completion toast
  const prevCrawlRef = useRef(state.crawl.status);
  useEffect(() => {
    const s = state.crawl;
    if (prevCrawlRef.current === 'running' && s.status !== 'running') {
      if (s.status === 'success') pushToast({ variant: 'success', title: '元資料已更新', message: `${s.kind} 爬取完成，已即時刷新。` });
      else if (s.status === 'error') pushToast({ variant: 'error', title: '爬取失敗', message: s.logs.at(-1) ?? `exit ${s.exitCode}`, detail: s.logs.slice(-8) });
    }
    prevCrawlRef.current = s.status;
  }, [state.crawl, pushToast]);

  // ─── Export ─────────────────────────────────────────────────────────────────
  const doExport = useCallback(async () => {
    if (!payload?.graph || !payload?.derivedPins || !supported) return;
    const { text, warnings } = graphToUET3D(payload.graph, positions, exportMeta, payload.derivedPins, { mfContentRoot: mfRoot });
    const count = text ? (text.match(/^Begin Object Class=\/Script\/UnrealEd\.MaterialGraphNode/gm)?.length ?? 0) : 0;
    try {
      await navigator.clipboard.writeText(text);
      const message = payload.graph.type === 'MaterialFunction'
        ? `Copied ${count} nodes. Create a Material Function "${payload.graph.name}" under ${mfRoot} and paste here.`
        : `Copied ${count} nodes — paste into UE's Material Editor.`;
      pushToast({ variant: warnings.length ? 'warning' : 'success', title: 'Exported to UE', message, detail: warnings });
    } catch {
      pushToast({ variant: 'error', title: 'Clipboard blocked', message: 'Copy manually from the console.', detail: warnings });
      // eslint-disable-next-line no-console
      console.log(text);
    }
  }, [payload, supported, exportMeta, positions, mfRoot, pushToast]);

  // ─── Command handler ─────────────────────────────────────────────────────────
  const handleCmd = useCallback((id: string) => {
    switch (id) {
      case 'config':    setTab('config'); break;
      case 'crawlMat':  void startCrawl('projectmat', matRoot.trim() || '/Game'); break;
      case 't3dIn':     setImportOpen(true); break;
      case 't3dOut':    void doExport(); break;
      case 'snapshot':  pushToast({ variant: 'info', title: '快照匯出需 CLI', message: '請使用 ue-mat-viewer export <name>' }); break;
      default: break;
    }
  }, [setTab, startCrawl, matRoot, doExport, pushToast]);

  // ─── Keyboard shortcuts ──────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(o => !o);
      }
      if (e.key === 'Escape') {
        setConfirmFile(null);
        setPaletteOpen(false);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const errs = current ? (state.errors[current] ?? []) : [];
  const warns = payload?.warnings ?? [];

  // Body grid left-panel width. Config is widest — it carries two content-root
  // inputs, the env checklist, and the crawl buttons; wider still while a crawl
  // runs so the live log has room.
  const leftW = tab === 'config' && state.crawl.status === 'running' ? 560
    : tab === 'config' ? 384
    : 290;

  return (
    <div className="app">
      <Chrome
        graph={payload?.graph}
        onPalette={() => setPaletteOpen(true)}
        onImport={() => setImportOpen(true)}
        onExport={doExport}
        onSettings={() => setTab('config')}
      />
      <Banner
        conn={state.connection}
        engineMismatch={engineMismatch}
        dismissed={bannerDismissed}
        onDismiss={() => setBannerDismissed(true)}
      />
      <div className="body" style={{ '--left': leftW + 'px' } as React.CSSProperties}>
        <div className="panel left">
          <Sidebar
            tab={tab}
            setTab={setTab}
            onGotoConfig={() => setTab('config')}
            onLargeGraph={setConfirmFile}
            mfRoot={mfRoot}
            setMfRoot={setMfRoot}
            matRoot={matRoot}
            setMatRoot={setMatRoot}
          />
        </div>
        <main className="canvas-wrap">
          {payload && (
            <div className="canvas-topbar">
              <div className="ct-left"><span className="ct-title">{payload.graph.name}</span></div>
              <div className="ct-right">
                {(errs.length + warns.length) > 0 && (
                  <span className="ct-warn" title={[...errs, ...warns].join('\n')}>
                    ! {errs.length} error{errs.length !== 1 ? 's' : ''} · {warns.length} warning{warns.length !== 1 ? 's' : ''}
                  </span>
                )}
                <span className={`ct-ver mono ${!supported ? 'warn' : ''}`}
                  title={supported ? `Node DB: UE ${payload.graph.ueVersion}` : `UE ${payload.graph.ueVersion} — no DB shipped`}>
                  UE {payload.graph.ueVersion}
                </span>
                <span className="ct-count mono">{payload.graph.nodes.length} nodes · {payload.graph.connections.length} links</span>
              </div>
            </div>
          )}
          {payload
            ? <Graph key={current} payload={payload} basePath={current!} db={db} onEnterMF={enterMF} onSelectNode={setSelectedNodeId} onPositions={setPositions} focus={focusReq && focusReq.path === current ? focusReq : null} />
            : <div className="canvas-empty">Select a graph from the left.</div>}
        </main>
        <Inspector
          graph={payload?.graph}
          selectedNodeId={selectedNodeId}
          derivedPins={payload?.derivedPins}
          errors={errs}
          onFocusNode={focusNode}
          nodeProvenance={payload?.nodeProvenance}
          onRecrawlNode={(src) => {
            const k = srcToKind(src);
            const root = k === 'workmf' ? mfRoot : k === 'projectmat' ? matRoot : undefined;
            void startCrawl(k, root);
          }}
        />
      </div>

      {importOpen && (
        <ImportModal exportMeta={exportMeta} open={open} pushToast={pushToast} onClose={() => setImportOpen(false)} />
      )}
      {confirmFile && (
        <BigGraphConfirm
          file={{
            path: confirmFile.path,
            name: confirmFile.path.split('/').pop()?.replace(/\.matgraph\.json$/, '') ?? confirmFile.path,
            nodeCount: confirmFile.nodeCount ?? 0,
          }}
          onCancel={() => setConfirmFile(null)}
          onConfirm={() => { open(confirmFile.path); setConfirmFile(null); }}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onJump={focusNode}
          onCmd={handleCmd}
          nodes={payload?.graph.nodes ?? []}
          db={db}
          connection={state.connection}
          envReady={!!state.env?.ready}
        />
      )}

      <ToastStack toasts={toasts} onClose={closeToast} />
    </div>
  );
}

export function App() {
  return (
    <StoreProvider>
      <DbProvider><Body /></DbProvider>
    </StoreProvider>
  );
}

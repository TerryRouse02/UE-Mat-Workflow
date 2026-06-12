import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
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
import { Icon } from './Icon';
import { DbProvider, useDb } from './dbContext';
import { shouldConfirmOpen } from './largeGraphGate';
import { graphToUET3D } from './export/ueT3D';
import { Login } from './Login';
import { buildDiffPayload } from './diff';
import type { FileEntry, GraphPayload } from './protocol';

export type AppTab = 'files' | 'nodes' | 'config' | 'agent';

/**
 * Team-mode gate: until /api/auth/status answers, show a tiny splash; an
 * unauthenticated team session gets the Login screen instead of the app.
 * Snapshot + local mode pass straight through.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { state } = useStore();
  if (state.connection !== 'snapshot') {
    if (state.auth === null) return <div className="auth-splash">連線中…</div>;
    if (state.auth.mode === 'team' && !state.auth.authed) return <Login />;
  }
  return <>{children}</>;
}

function srcToKind(src: string): 'workmf' | 'projectmat' | 'enginemf' | 'export' {
  if (src === 'workmf') return 'workmf';
  if (src === 'projectmat') return 'projectmat';
  if (src === 'enginemf') return 'enginemf';
  return 'export';
}

function Body() {
  const { state, open, enterMF, startCrawl, selectNode } = useStore();
  const { db, exportMeta, supported } = useDb();

  // ─── Lifted cross-cutting state ────────────────────────────────────────────
  const [tab, setTab] = useState<AppTab>('files');
  const gotoConfig = () => setTab('config');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirmFile, setConfirmFile] = useState<FileEntry | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  // Collapse either side panel to give the canvas more room.
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  // Agent-tab chat width, user-draggable via the panel edge. Deliberately NOT
  // persisted — a session-local preference only.
  // Per-tab user-dragged widths (undefined = the tab's adaptive default).
  // Deliberately NOT persisted — session-local preferences only, like before.
  const [leftWidths, setLeftWidths] = useState<Partial<Record<AppTab, number>>>({});
  const [rightW, setRightW] = useState(320);
  const [resizing, setResizing] = useState(false);
  const dragHoriz = useCallback((e: React.MouseEvent, start: number, apply: (w: number) => void, dir: 1 | -1, min: number, max: number) => {
    e.preventDefault();
    const startX = e.clientX;
    const move = (ev: MouseEvent) =>
      apply(Math.max(min, Math.min(max, start + dir * (ev.clientX - startX))));
    const up = () => {
      setResizing(false);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    setResizing(true);
  }, []);
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
  // Selection lives in the store so the agent chat can attach it as context.
  const selectedNodeId = state.selectedNodeId;
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

  // ─── Compare view (graph diff) ──────────────────────────────────────────────
  // base = the open graph at the moment compare started; other = the fetched
  // target. Cleared on navigation; recomputed live when the open graph reloads.
  const [diffTarget, setDiffTarget] = useState<{ basePath: string; otherPath: string; other: GraphPayload } | null>(null);
  const startCompare = useCallback(async (otherPath: string) => {
    if (!current || otherPath === current) return;
    try {
      const r = await fetch(`/api/graph?path=${encodeURIComponent(otherPath)}`, { cache: 'no-store' });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error || `HTTP ${r.status}`);
      }
      const data = (await r.json()) as { path: string; payload: GraphPayload };
      setDiffTarget({ basePath: current, otherPath, other: data.payload });
    } catch (e) {
      pushToast({ variant: 'error', title: '無法載入比較對象', message: (e as Error).message });
    }
  }, [current, pushToast]);
  const diffData = useMemo(() => {
    if (!diffTarget || !payload || diffTarget.basePath !== current) return null;
    return buildDiffPayload(payload, diffTarget.other);
  }, [diffTarget, payload, current]);

  // Reset per-graph view state on navigation.
  useEffect(() => { selectNode(null); setFocusReq(null); setDiffTarget(null); }, [current, selectNode]);

  // 問 AI / post-import explain: a fresh agentAsk switches to the Agent tab;
  // AgentChat itself consumes the text (nonce-tracked there too).
  const consumedAskNonce = useRef(0);
  useEffect(() => {
    const ask = state.agentAsk;
    if (!ask || ask.nonce === consumedAskNonce.current) return;
    consumedAskNonce.current = ask.nonce;
    if (Date.now() - ask.ts > 15_000) return;
    if (state.connection !== 'snapshot') setTab('agent');
  }, [state.agentAsk, state.connection]);

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

  // Agent-requested clipboard export (export_to_clipboard tool): runs the same
  // doExport as the header button, but only once the requested graph is the
  // open one AND its nodes have rendered (T3D needs the dagre positions).
  // nonce-consumed + 30s freshness so a stale request never re-fires later.
  const consumedExportNonce = useRef(0);
  useEffect(() => {
    const req = state.agentExportReq;
    if (!req || req.nonce === consumedExportNonce.current) return;
    if (Date.now() - req.ts > 30_000) { consumedExportNonce.current = req.nonce; return; }
    if (req.path !== current || !payload?.graph || Object.keys(positions).length === 0) return;
    consumedExportNonce.current = req.nonce;
    void doExport();
  }, [state.agentExportReq, current, payload, positions, doExport]);

  // ─── Command handler ─────────────────────────────────────────────────────────
  const handleCmd = useCallback((id: string) => {
    switch (id) {
      case 'config':    setTab('config'); break;
      case 'crawlMat':  void startCrawl('projectmat', matRoot.trim() || '/Game'); break;
      case 't3dIn':     setImportOpen(true); break;
      case 't3dOut':    void doExport(); break;
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
        setImportOpen(false);
        setDiffTarget(null);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const errs = current ? (state.errors[current] ?? []) : [];
  const warns = payload?.warnings ?? [];

  // Agent diff highlight: only for the graph it targeted, and only while fresh —
  // a stale entry must not re-pulse when the user reopens the file minutes later.
  const hl = state.agentHighlight;
  const agentHl = hl && hl.path === current && Date.now() - hl.ts < 15_000
    ? { ids: hl.ids, nonce: hl.nonce }
    : null;

  // Body grid left-panel width. Config is widest — it carries two content-root
  // inputs, the env checklist, and the crawl buttons; wider still while a crawl
  // runs so the live log has room. Agent gets extra room for chat bubbles,
  // tool-step cards, and diff blocks.
  // Adaptive defaults per tab; a user drag on that tab overrides them.
  const defaultLeftW = tab === 'config' && state.crawl.status === 'running' ? 560
    : tab === 'config' ? 384
    : tab === 'agent' ? 430
    : 290;
  const leftW = leftWidths[tab] ?? defaultLeftW;
  const startLeftResize = (e: React.MouseEvent) =>
    dragHoriz(e, leftW, w => setLeftWidths(m => ({ ...m, [tab]: w })), 1, 220, 800);
  const startRightResize = (e: React.MouseEvent) =>
    dragHoriz(e, rightW, w => setRightW(w), -1, 240, 640);

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
      <div className={'body' + (resizing ? ' resizing' : '')} style={{ '--left': (leftCollapsed ? 0 : leftW) + 'px', '--right': (rightCollapsed ? 0 : rightW) + 'px' } as React.CSSProperties}>
        <div className="panel left">
          <Sidebar
            tab={tab}
            setTab={setTab}
            onGotoConfig={gotoConfig}
            onLargeGraph={setConfirmFile}
            onCompare={state.connection === 'live' && current ? (p) => void startCompare(p) : undefined}
            mfRoot={mfRoot}
            setMfRoot={setMfRoot}
            matRoot={matRoot}
            setMatRoot={setMatRoot}
          />
          {!leftCollapsed && (
            <div
              className={'panel-resizer' + (resizing ? ' active' : '')}
              title="拖曳調整側欄寬度"
              onMouseDown={startLeftResize}
            />
          )}
        </div>
        <main className="canvas-wrap">
          <button
            className="panel-toggle left"
            title={leftCollapsed ? '展開側欄' : '收合側欄'}
            onClick={() => setLeftCollapsed(c => !c)}
          >
            <Icon name="caret" size={13} style={{ transform: leftCollapsed ? 'none' : 'rotate(180deg)' }} />
          </button>
          <button
            className="panel-toggle right"
            title={rightCollapsed ? '展開檢視器' : '收合檢視器'}
            onClick={() => setRightCollapsed(c => !c)}
          >
            <Icon name="caret" size={13} style={{ transform: rightCollapsed ? 'rotate(180deg)' : 'none' }} />
          </button>
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
          {payload && diffData && diffTarget && (
            <div className="diff-banner">
              <span className="db-title">
                比較中：<b>{diffTarget.basePath.replace(/\.matgraph\.json$/, '')}</b>
                <span className="db-arrow">→</span>
                <b>{diffTarget.otherPath.replace(/\.matgraph\.json$/, '')}</b>
              </span>
              <span className="db-stats">
                <span className="db-chip added">+{diffData.diff.summary.added.length} 節點</span>
                <span className="db-chip removed">−{diffData.diff.summary.removed.length} 節點</span>
                <span className="db-chip changed">~{diffData.diff.summary.changed.length} 修改</span>
                <span className="db-chip conn">連線 +{diffData.diff.summary.connAdded}/−{diffData.diff.summary.connRemoved}</span>
              </span>
              <button className="db-close" onClick={() => setDiffTarget(null)} title="結束比較（Esc）">結束比較</button>
            </div>
          )}
          {payload
            ? <Graph
                key={diffData ? `${current}<>${diffTarget!.otherPath}` : current}
                payload={diffData ? diffData.payload : payload}
                basePath={current!} db={db} onEnterMF={enterMF} onSelectNode={selectNode} onPositions={setPositions}
                focus={!diffData && focusReq && focusReq.path === current ? focusReq : null}
                agentHighlight={diffData ? null : agentHl}
                diff={diffData ? diffData.diff : null}
              />
            : <div className="canvas-empty">Select a graph from the left.</div>}
        </main>
        <div className="panel right-wrap">
          {!rightCollapsed && (
            <div
              className={'panel-resizer left-edge' + (resizing ? ' active' : '')}
              title="拖曳調整檢視器寬度"
              onMouseDown={startRightResize}
            />
          )}
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
      <AuthGate>
        <DbProvider><Body /></DbProvider>
      </AuthGate>
    </StoreProvider>
  );
}

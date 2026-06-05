import { useEffect, useState, useRef, useCallback, type CSSProperties } from 'react';
import { StoreProvider, useStore } from './store';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { Graph } from './Graph';
import { Inspector } from './Inspector';
import { ToastStack, type ToastItem } from './Toast';
import { DbProvider, useDb } from './dbContext';
import { shouldConfirmOpen } from './largeGraphGate';
import { pinColor } from './theme/colors';

// Canvas type legend — the edge/pin colours, mirrored from theme/colors.ts so the
// graph's wire colours have a key. Kept short (representative types, not exhaustive).
const LEGEND: { label: string; type: string }[] = [
  { label: 'Float', type: 'float' },
  { label: 'Vec2', type: 'float2' },
  { label: 'Vec3', type: 'float3' },
  { label: 'Vec4', type: 'float4' },
  { label: 'Texture', type: 'texture' },
  { label: 'Bool', type: 'bool' },
  { label: 'Attr', type: 'materialattributes' },
];
function CanvasLegend() {
  return (
    <div className="legend">
      {LEGEND.map(l => (
        <span className="lg" key={l.type}><i style={{ background: pinColor(l.type) }} />{l.label}</span>
      ))}
    </div>
  );
}

function Body() {
  const { state, open, enterMF } = useStore();
  const { db, supported, version } = useDb();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  // A debug-panel issue click asks the canvas to centre + highlight a node. focusReq is
  // tagged with `path` (the graph it was issued from) so a stale request can never fire on
  // a different graph that happens to share a node id — see the guarded `focus` prop below.
  // The nonce is a monotonic counter (not a timestamp) so repeat clicks always re-fire and
  // two clicks can never collide on one value. (`focusNode` is defined after `current`.)
  const [focusReq, setFocusReq] = useState<{ id: string; nonce: number; path: string } | null>(null);

  useEffect(() => {
    if (!state.currentPath && state.files.length > 0) {
      // Skip startup auto-open for large graphs to avoid freezing the UI.
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

  // Reset per-graph view state on navigation. Clearing focusReq here is hygiene; the real
  // guard against a stale focus firing on the next graph is the path check on the `focus`
  // prop below (the child's mount effect runs BEFORE this parent effect, so this reset
  // alone cannot prevent the cross-graph misfire — the path tag can).
  useEffect(() => { setSelectedNodeId(null); setFocusReq(null); }, [current]);

  // Hot-reload notice: only when the SAME path's payload object changes while
  // live (a real disk reload) — not when `current` changes from navigation.
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

  // Crawl completion toast. Lives here (always mounted) rather than in the Config
  // tab so the user still gets feedback after switching tabs while a crawl runs.
  const prevCrawlRef = useRef(state.crawl.status);
  useEffect(() => {
    const s = state.crawl;
    if (prevCrawlRef.current === 'running' && s.status !== 'running') {
      if (s.status === 'success') pushToast({ variant: 'success', title: '元資料已更新', message: `${s.kind} 爬取完成，已即時刷新。` });
      else if (s.status === 'error') pushToast({ variant: 'error', title: '爬取失敗', message: s.logs.at(-1) ?? `exit ${s.exitCode}`, detail: s.logs.slice(-8) });
    }
    prevCrawlRef.current = s.status;
  }, [state.crawl, pushToast]);

  const errs = current ? (state.errors[current] ?? []) : [];
  const warns = payload?.warnings ?? [];
  // While a crawl streams its log, widen the left panel so the runlog is readable.
  const bodyStyle = state.crawl.status === 'running' ? ({ '--left': '344px' } as CSSProperties) : undefined;

  return (
    <div className="app">
      <Header graph={payload?.graph} derivedPins={payload?.derivedPins} positions={positions} pushToast={pushToast} />
      {payload && !supported && (
        <div className="banner warn" role="alert">
          <span className="ico">⚠</span>
          <span>
            UE version <b>{version}</b> isn't supported — no node DB ships for it.
            Rendering with the latest available DB ({db?.ueVersion}); export is disabled.
            Add <code>nodes-ue{version}.json</code> + <code>.export.json</code> to <code>agent-pack/</code> to support it.
          </span>
        </div>
      )}
      <div className="body" style={bodyStyle}>
        <aside className="panel left"><Sidebar /></aside>
        <main className="canvas-wrap">
          {payload ? (
            <>
              <div className="canvas-info">
                <b>{payload.graph.nodes.length}</b> nodes · <b>{payload.graph.connections.length}</b> links
                {(errs.length + warns.length) > 0 && (
                  <span title={[...errs, ...warns].join('\n')} style={{ color: 'var(--warn)' }}>
                    {' '}· {errs.length + warns.length} issue{errs.length + warns.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <CanvasLegend />
              <Graph key={current} payload={payload} basePath={current!} db={db} onEnterMF={enterMF} onSelectNode={setSelectedNodeId} onPositions={setPositions} focus={focusReq && focusReq.path === current ? focusReq : null} />
            </>
          ) : (
            <div className="canvas-empty">Select a graph from the left.</div>
          )}
        </main>
        <aside className="panel right">
          <Inspector graph={payload?.graph} selectedNodeId={selectedNodeId} derivedPins={payload?.derivedPins} errors={errs} onFocusNode={focusNode} />
        </aside>
      </div>
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

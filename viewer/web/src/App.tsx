import { useEffect, useState, useRef, useCallback } from 'react';
import { StoreProvider, useStore } from './store';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { Graph } from './Graph';
import { Inspector } from './Inspector';
import { ToastStack, type ToastItem } from './Toast';
import { DbProvider, useDb } from './dbContext';

function Body() {
  const { state, open, enterMF } = useStore();
  const { db, supported, version } = useDb();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});

  useEffect(() => {
    if (!state.currentPath && state.files.length > 0) open(state.files[0].path);
  }, [state.files, state.currentPath, open]);

  const current = state.breadcrumb[state.breadcrumb.length - 1];
  const payload = current ? state.graphs[current] : undefined;

  const pushToast = useCallback((t: Omit<ToastItem, 'id'>) =>
    setToasts(ts => [...ts, { id: Date.now() + Math.random(), ...t }]), []);
  const closeToast = (id: number) => setToasts(ts => ts.filter(t => t.id !== id));

  useEffect(() => { setSelectedNodeId(null); }, [current]);

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

  const errs = current ? (state.errors[current] ?? []) : [];
  const warns = payload?.warnings ?? [];

  return (
    <div className="app">
      <Header graph={payload?.graph} derivedPins={payload?.derivedPins} positions={positions} pushToast={pushToast} />
      <div className="body">
        <aside className="sidebar-wrap"><Sidebar /></aside>
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
                  title={supported ? `Node DB: UE ${payload.graph.ueVersion}` : `UE ${payload.graph.ueVersion} — no DB shipped`}>UE {payload.graph.ueVersion}</span>
                <span className="ct-count mono">{payload.graph.nodes.length} nodes · {payload.graph.connections.length} links</span>
              </div>
            </div>
          )}
          {payload && !supported && (
            <div className="canvas-banner" role="alert">
              ⚠ UE version <b>{version}</b> isn't supported — no node DB ships for it.
              Rendering with the latest available DB ({db?.ueVersion}); export is disabled.
              Add <code>nodes-ue{version}.json</code> + <code>.export.json</code> to <code>agent-pack/</code> to support it.
            </div>
          )}
          {payload
            ? <Graph key={current} payload={payload} basePath={current!} db={db} onEnterMF={enterMF} onSelectNode={setSelectedNodeId} onPositions={setPositions} />
            : <div className="canvas-empty">Select a graph from the left.</div>}
        </main>
        <Inspector graph={payload?.graph} selectedNodeId={selectedNodeId} derivedPins={payload?.derivedPins} />
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

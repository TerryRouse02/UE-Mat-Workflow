import { useEffect, useState, useRef } from 'react';
import { StoreProvider, useStore } from './store';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { Graph } from './Graph';
import { Inspector } from './Inspector';
import { ToastStack, type ToastItem } from './Toast';
import { DB } from './db';

function Body() {
  const { state, open, enterMF } = useStore();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});

  useEffect(() => {
    if (!state.currentPath && state.files.length > 0) open(state.files[0].path);
  }, [state.files, state.currentPath, open]);

  const current = state.breadcrumb[state.breadcrumb.length - 1];
  const payload = current ? state.graphs[current] : undefined;

  const pushToast = (t: Omit<ToastItem, 'id'>) =>
    setToasts(ts => [...ts, { id: Date.now() + Math.random(), ...t }]);
  const closeToast = (id: number) => setToasts(ts => ts.filter(t => t.id !== id));

  // Hot-reload notice: when the open graph's payload object changes while live.
  const prevPayloadRef = useRef(payload);
  useEffect(() => {
    if (prevPayloadRef.current && payload && prevPayloadRef.current !== payload && state.connection === 'live') {
      pushToast({ variant: 'info', title: 'Graph updated', message: `${current} reloaded from disk.` });
    }
    prevPayloadRef.current = payload;
  }, [payload, current, state.connection]);

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
                <span className="ct-count mono">{payload.graph.nodes.length} nodes · {payload.graph.connections.length} links</span>
              </div>
            </div>
          )}
          {payload
            ? <Graph payload={payload} basePath={current!} db={DB} onEnterMF={enterMF} onSelectNode={setSelectedNodeId} onPositions={setPositions} />
            : <div className="canvas-empty">Select a graph from the left.</div>}
        </main>
        <Inspector graph={payload?.graph} selectedNodeId={selectedNodeId} />
      </div>
      <ToastStack toasts={toasts} onClose={closeToast} />
    </div>
  );
}

export function App() { return <StoreProvider><Body /></StoreProvider>; }

import { useEffect } from 'react';
import { StoreProvider, useStore } from './store';
import { Breadcrumb } from './Breadcrumb';
import { FileList } from './FileList';
import { WarningPanel } from './WarningPanel';
import { Graph } from './Graph';
import { DB } from './db';

function Body() {
  const { state, open, enterMF } = useStore();

  useEffect(() => {
    if (!state.currentPath && state.files.length > 0) {
      open(state.files[0]);
    }
  }, [state.files, state.currentPath, open]);

  const current = state.breadcrumb[state.breadcrumb.length - 1];
  const payload = current ? state.graphs[current] : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#1a1a1a' }}>
      <Breadcrumb />
      <WarningPanel />
      <div style={{ flex: 1, display: 'flex' }}>
        <div style={{ width: 220 }}><FileList /></div>
        <div style={{ flex: 1 }}>
          {payload ? <Graph payload={payload} basePath={current} db={DB} onEnterMF={enterMF} /> :
            <div style={{ color: '#888', padding: 20 }}>Select a graph from the left.</div>}
        </div>
      </div>
    </div>
  );
}

export function App() {
  return <StoreProvider><Body /></StoreProvider>;
}

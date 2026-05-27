import React from 'react';
import { useStore } from './store';

export function Breadcrumb() {
  const { state, popBreadcrumb } = useStore();
  return (
    <div style={{ padding: '8px 12px', background: '#252525', color: '#ddd', display: 'flex', gap: 6 }}>
      {state.breadcrumb.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span style={{ color: '#666' }}>▸</span>}
          <span
            style={{ cursor: 'pointer', textDecoration: i === state.breadcrumb.length - 1 ? 'none' : 'underline' }}
            onClick={() => popBreadcrumb(i)}
          >{niceName(p)}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

function niceName(p: string) {
  return p.replace(/^functions\//, '').replace('.matgraph.json', '');
}

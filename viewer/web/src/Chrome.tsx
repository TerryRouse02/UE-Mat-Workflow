import { useState, useEffect } from 'react';
import { Icon } from './Icon';
import { useStore } from './store';
import type { MatGraph } from './protocol';
import './chrome.css';

export interface ChromeProps {
  /** The active graph — export button is disabled when absent. */
  graph?: MatGraph;
  onPalette(): void;
  onImport(): void;
  onExport(): void;
  onSettings(): void;
}

export function Chrome({ graph, onPalette, onImport, onExport, onSettings }: ChromeProps) {
  const { state, popBreadcrumb } = useStore();
  const conn = state.connection;

  const connInfo = conn === 'snapshot'
    ? ['offline', '離線快照'] as const
    : conn === 'reconnecting'
    ? ['offline', '重新連線中…'] as const
    : ['live', 'watching · 已同步'] as const;

  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    if (!moreOpen) return;
    const h = () => setMoreOpen(false);
    window.addEventListener('click', h);
    return () => window.removeEventListener('click', h);
  }, [moreOpen]);

  const niceName = (p: string) =>
    p.replace(/^functions\//, '').replace(/\.matgraph\.json$/, '');

  // Derived from dbContext via props: export is disabled when no graph or not supported
  const exportDisabled = !graph;

  return (
    <div className="chrome">
      <div className="logo">
        <span className="mark">M</span>
        <span className="t">UE·MAT workflow</span>
        <span className="ver">UE 5.7</span>
      </div>
      <span className="bcrumb">
        {state.breadcrumb.map((p, i) => (
          <span key={i}>
            {i > 0 && <span className="sep">›</span>}
            {i < state.breadcrumb.length - 1
              ? <button className="bc-seg" onClick={() => popBreadcrumb(i)}>{niceName(p)}</button>
              : <span className="bc-cur">{niceName(p)}</span>
            }
          </span>
        ))}
      </span>
      <span className="spacer" />
      <button className="searchbtn" onClick={onPalette}>
        <Icon name="search" size={14} /> 搜尋節點與指令 <kbd>⌘K</kbd>
      </button>
      <div className={'conn ' + connInfo[0]}>
        <span className="dot" /> {connInfo[1]}
      </div>
      {conn === 'live' && (
        <>
          <button className="btn" onClick={onImport}>
            <Icon name="clip" size={14} /> 導入
          </button>
          <button className="btn primary" onClick={onExport} disabled={exportDisabled}>
            <Icon name="upload" size={14} /> 導出到 UE
          </button>
        </>
      )}
      <button className="iconbtn" title="設定 / 爬取" onClick={onSettings} style={{ width: 32, height: 32 }}>
        <Icon name="settings" size={16} />
      </button>
      <div className="more-wrap" onClick={e => e.stopPropagation()}>
        <button className="iconbtn" title="更多" onClick={() => setMoreOpen(o => !o)} style={{ width: 32, height: 32 }}>
          <Icon name="more" size={16} />
        </button>
        {moreOpen && (
          <div className="menu">
            <div className="menu-label">分享 / 離線</div>
            <button
              className="menu-item"
              disabled
              title="需要 CLI：ue-mat-viewer export <name>"
              onClick={() => setMoreOpen(false)}
            >
              <Icon name="download" size={14} /> 匯出離線 HTML 快照
              <span className="mi-hint">需要 CLI</span>
            </button>
            <div className="menu-div" />
            <button className="menu-item" onClick={() => { setMoreOpen(false); onPalette(); }}>
              <Icon name="search" size={14} /> 指令面板 · 搜尋
              <span className="mi-hint">⌘K</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

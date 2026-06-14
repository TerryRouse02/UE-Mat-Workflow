import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const { state, popBreadcrumb, logout } = useStore();
  const conn = state.connection;
  // Team mode: show who is signed in + a logout control.
  const teamUser = conn !== 'snapshot' && state.auth?.mode === 'team' && state.auth.authed
    ? { name: state.auth.username ?? '?', role: state.auth.role ?? 'user' }
    : null;

  const connInfo = conn === 'snapshot'
    ? ['offline', t('chrome.connOfflineSnapshot')] as const
    : conn === 'reconnecting'
    ? ['offline', t('chrome.connReconnecting')] as const
    : ['live', t('chrome.connLive')] as const;

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
        <Icon name="search" size={14} /> {t('chrome.searchPlaceholder')} <kbd>⌘K</kbd>
      </button>
      <div className={'conn ' + connInfo[0]}>
        <span className="dot" /> {connInfo[1]}
      </div>
      {teamUser && (
        <div className="userchip" title={teamUser.role === 'admin' ? t('chrome.roleAdmin') : t('chrome.roleMember')}>
          <Icon name="chip" size={12} />
          <span className="uc-name">{teamUser.name}</span>
          <span className={'uc-role' + (teamUser.role === 'admin' ? ' admin' : '')}>
            {teamUser.role === 'admin' ? 'admin' : 'user'}
          </span>
          <button className="uc-out" title={t('chrome.logout')} onClick={() => void logout()}>{t('chrome.logout')}</button>
        </div>
      )}
      {conn === 'live' && (
        <>
          <button className="btn" onClick={onImport}>
            <Icon name="clip" size={14} /> {t('chrome.importBtn')}
          </button>
          <button className="btn primary" onClick={onExport} disabled={exportDisabled}>
            <Icon name="upload" size={14} /> {t('chrome.exportBtn')}
          </button>
        </>
      )}
      <button className="iconbtn" title={t('chrome.settingsTitle')} onClick={onSettings} style={{ width: 32, height: 32 }}>
        <Icon name="settings" size={16} />
      </button>
      <div className="more-wrap" onClick={e => e.stopPropagation()}>
        <button className="iconbtn" title={t('chrome.moreTitle')} onClick={() => setMoreOpen(o => !o)} style={{ width: 32, height: 32 }}>
          <Icon name="more" size={16} />
        </button>
        {moreOpen && (
          <div className="menu">
            <div className="menu-label">{t('chrome.menuLabelShare')}</div>
            <button
              className="menu-item"
              disabled={conn !== 'live' || !state.currentPath}
              title={state.currentPath ? t('chrome.exportHtmlTitle') : t('chrome.exportHtmlNoMat')}
              onClick={() => {
                setMoreOpen(false);
                const name = (state.currentPath ?? '').replace(/\.matgraph\.json$/, '');
                const a = document.createElement('a');
                a.href = `/api/export-html?name=${encodeURIComponent(name)}`;
                a.download = '';
                a.click();
              }}
            >
              <Icon name="download" size={14} /> {t('chrome.exportHtmlItem')}
              <span className="mi-hint">{state.currentPath ? '' : t('chrome.exportHtmlHint')}</span>
            </button>
            <div className="menu-div" />
            <button className="menu-item" onClick={() => { setMoreOpen(false); onPalette(); }}>
              <Icon name="search" size={14} /> {t('chrome.commandPaletteItem')}
              <span className="mi-hint">⌘K</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

import { useStore } from './store';
import { Icon } from './Icon';
import { FileList } from './FileList';
import { NodeLibrary } from './NodeLibrary';
import { ConfigPanel } from './ConfigPanel';
import { AgentChat } from './agent/AgentChat';
import type { FileEntry } from './protocol';
import './sidebar.css';
import './chrome.css';

export type SidebarTab = 'files' | 'nodes' | 'config' | 'agent';

export interface SidebarProps {
  tab: SidebarTab;
  setTab(t: SidebarTab): void;
  /** Navigates to the config tab (passed to FileList for "前往爬取" button, and agent guidance) */
  onGotoConfig(): void;
  /** Triggered when a large-graph file is clicked (passed to FileList) */
  onLargeGraph(file: FileEntry): void;
  /** MF content root (workmf crawl + export) — passed to ConfigPanel */
  mfRoot: string;
  setMfRoot(v: string): void;
  /** Base-material content root (projectmat crawl) — passed to ConfigPanel */
  matRoot: string;
  setMatRoot(v: string): void;
}

export function Sidebar({ tab, setTab, onGotoConfig, onLargeGraph, mfRoot, setMfRoot, matRoot, setMatRoot }: SidebarProps) {
  const { state } = useStore();
  const crawlStatus = state.crawl.status;
  const configCue: 'run' | 'err' | null =
    crawlStatus === 'running' ? 'run' : crawlStatus === 'error' ? 'err' : null;
  // Agent tab is hidden in snapshot mode (same as ConfigPanel behaviour).
  const isSnapshot = state.connection === 'snapshot';

  return (
    <div className="sidebar">
      <div className="lstabs">
        <div
          className={'lstab' + (tab === 'files' ? ' on' : '')}
          role="button"
          tabIndex={0}
          onClick={() => setTab('files')}
          onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setTab('files')}
        >
          <Icon name="material" size={14} /> Files
        </div>
        <div
          className={'lstab' + (tab === 'nodes' ? ' on' : '')}
          role="button"
          tabIndex={0}
          onClick={() => setTab('nodes')}
          onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setTab('nodes')}
        >
          <Icon name="hash" size={14} /> 節點
        </div>
        <div
          className={'lstab' + (tab === 'config' ? ' on' : '')}
          role="button"
          tabIndex={0}
          onClick={() => setTab('config')}
          onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setTab('config')}
        >
          <Icon name="settings" size={14} /> Config
          {configCue && <span className={'tdot ' + configCue} />}
        </div>
        {!isSnapshot && (
          <div
            className={'lstab' + (tab === 'agent' ? ' on' : '')}
            role="button"
            tabIndex={0}
            onClick={() => setTab('agent')}
            onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setTab('agent')}
          >
            <Icon name="chip" size={14} /> Agent
          </div>
        )}
      </div>
      <div className="sidebar-panel">
        {tab === 'files' && (
          <FileList onGotoConfig={onGotoConfig} onLargeGraph={onLargeGraph} />
        )}
        {tab === 'nodes' && <NodeLibrary />}
        {tab === 'config' && (
          <ConfigPanel mfRoot={mfRoot} setMfRoot={setMfRoot} matRoot={matRoot} setMatRoot={setMatRoot} />
        )}
        {tab === 'agent' && !isSnapshot && (
          <AgentChat onGotoConfig={onGotoConfig} />
        )}
      </div>
    </div>
  );
}

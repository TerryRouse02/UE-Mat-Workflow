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
  // Pulse while the agent streams; steady dot when a reply finished off-tab.
  const agentCue: 'run' | 'new' | null =
    state.agentActivity === 'busy' ? 'run' : state.agentActivity === 'unseen' ? 'new' : null;

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
            {agentCue && <span className={'tdot ' + agentCue} />}
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
        {/* AgentChat stays MOUNTED across tab switches (hidden, never unmounted):
            the pending crawl-report, an in-flight stream, and unsent input must
            survive the user watching crawl progress in the Config tab. */}
        {!isSnapshot && (
          <div className="agent-keepalive" style={{ display: tab === 'agent' ? 'flex' : 'none' }}>
            <AgentChat onGotoConfig={onGotoConfig} active={tab === 'agent'} />
          </div>
        )}
      </div>
    </div>
  );
}

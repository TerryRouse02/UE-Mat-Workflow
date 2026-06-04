import { useState } from 'react';
import { FileList } from './FileList';
import { NodeLibrary } from './NodeLibrary';
import { ConfigPanel } from './ConfigPanel';
import './sidebar.css';

type Tab = 'files' | 'nodes' | 'config';

export function Sidebar() {
  const [tab, setTab] = useState<Tab>('files');
  return (
    <div className="sidebar">
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab ${tab === 'files' ? 'active' : ''}`}
          onClick={() => setTab('files')}
        >Files</button>
        <button
          className={`sidebar-tab ${tab === 'nodes' ? 'active' : ''}`}
          onClick={() => setTab('nodes')}
        >Nodes</button>
        <button
          className={`sidebar-tab ${tab === 'config' ? 'active' : ''}`}
          onClick={() => setTab('config')}
        >Config</button>
      </div>
      <div className="sidebar-panel">
        {tab === 'files' ? <FileList /> : tab === 'nodes' ? <NodeLibrary /> : <ConfigPanel />}
      </div>
    </div>
  );
}

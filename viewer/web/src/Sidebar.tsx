import { useState } from 'react';
import { FileList } from './FileList';
import { NodeLibrary } from './NodeLibrary';
import './sidebar.css';

type Tab = 'files' | 'nodes';

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
      </div>
      <div className="sidebar-panel">
        {tab === 'files' ? <FileList /> : <NodeLibrary />}
      </div>
    </div>
  );
}

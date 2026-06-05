import { useStore } from './store';
import { FileList } from './FileList';
import { NodeLibrary } from './NodeLibrary';
import { ConfigPanel } from './ConfigPanel';
import type { Tab } from './CommandPalette';
import './sidebar.css';

export function Sidebar({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const { state } = useStore();

  // Status cue on the Config tab so a crawl's progress/outcome is visible from
  // any tab (the user may be browsing Files when an editor run finishes).
  const cfgDot = state.crawl.status === 'running' ? 'run'
    : state.crawl.status === 'error' ? 'err' : null;

  return (
    <>
      <div className="lstabs">
        <button className={`lstab ${tab === 'files' ? 'on' : ''}`} onClick={() => setTab('files')}>Files</button>
        <button className={`lstab ${tab === 'nodes' ? 'on' : ''}`} onClick={() => setTab('nodes')}>Nodes</button>
        <button className={`lstab ${tab === 'config' ? 'on' : ''}`} onClick={() => setTab('config')}>
          Config{cfgDot && <span className={`tdot ${cfgDot}`} />}
        </button>
      </div>
      {tab === 'files' ? <FileList onGoConfig={() => setTab('config')} />
        : tab === 'nodes' ? <div className="lib-wrap"><NodeLibrary /></div>
        : <ConfigPanel />}
    </>
  );
}

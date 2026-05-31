import { useState } from 'react';
import { useStore } from './store';
import { groupFiles, type Project, type FileEntry } from './groupFiles';

type SubTab = 'material' | 'function';

function fileClass(type: FileEntry['type']): string {
  if (type === 'Material') return 'material';
  if (type === 'MaterialFunction') return 'mf';
  return 'unknown';
}
function icon(type: FileEntry['type']): string {
  if (type === 'Material') return '◆';
  if (type === 'MaterialFunction') return 'ƒ';
  return '?';
}
function baseName(path: string): string {
  return path.split('/').pop()?.replace(/\.matgraph\.json$/, '') ?? path;
}
function inSubTab(type: FileEntry['type'], sub: SubTab): boolean {
  return sub === 'function' ? type === 'MaterialFunction' : type !== 'MaterialFunction';
}

function FileRow({ entry }: { entry: FileEntry }) {
  const { state, open } = useStore();
  const active = state.breadcrumb[0] === entry.path;
  const loaded = state.graphs[entry.path];
  const errored = (state.errors[entry.path]?.length ?? 0) > 0;
  const status: 'ok' | 'warn' | null = loaded
    ? ((loaded.warnings.length || errored) ? 'warn' : 'ok')
    : (errored ? 'warn' : null);
  const count = loaded ? loaded.graph.nodes.length : null;
  return (
    <button className={`tree-file ${fileClass(entry.type)} ${active ? 'active' : ''}`}
      onClick={() => open(entry.path)} title={entry.path}>
      <span className="tree-file-icon">{icon(entry.type)}</span>
      <span className="tree-file-name">{baseName(entry.path)}</span>
      {status && <span className={`st-dot st-${status}`} />}
      {count != null && <span className="tree-count">{count}</span>}
    </button>
  );
}

function ProjectFolder({ project }: { project: Project }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="tree-folder">
      <div className="tree-folder-header" onClick={() => setOpen(!open)}>
        {open ? '▼' : '▶'} {project.folder}/
      </div>
      {open && (
        <div className="tree-folder-children">
          {project.files.map(f => <FileRow key={f.path} entry={f} />)}
        </div>
      )}
    </div>
  );
}

function UnorganizedSection({ entries }: { entries: FileEntry[] }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <div className="tree-folder">
      <div className="tree-folder-header" onClick={() => setOpen(!open)}>
        {open ? '▼' : '▶'} Unorganized ({entries.length})
      </div>
      {open && (
        <div className="tree-folder-children">
          {entries.map(e => <FileRow key={e.path} entry={e} />)}
        </div>
      )}
    </div>
  );
}

export function FileList() {
  const { state } = useStore();
  const [query, setQuery] = useState('');
  const [sub, setSub] = useState<SubTab>('material');
  const q = query.trim().toLowerCase();
  const { projects, unorganized } = groupFiles(state.files);

  const matchFile = (e: FileEntry) =>
    inSubTab(e.type, sub) &&
    (!q || baseName(e.path).toLowerCase().includes(q) || e.path.toLowerCase().includes(q));

  const visibleProjects = projects
    .map(p => ({ ...p, files: p.files.filter(matchFile) }))
    .filter(p => p.files.length > 0);
  const visibleUnorg = unorganized.filter(matchFile);
  const nothing = state.files.length === 0;

  return (
    <div className="sb-files">
      <div className="sb-search">
        <span className="sb-search-ico">⌕</span>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search materials, functions…" />
        {query && <button className="sb-search-clr" onClick={() => setQuery('')}>×</button>}
      </div>
      <div className="sb-subtabs">
        <button className={`sb-subtab ${sub === 'material' ? 'on' : ''}`} onClick={() => setSub('material')}>Materials</button>
        <button className={`sb-subtab ${sub === 'function' ? 'on' : ''}`} onClick={() => setSub('function')}>Functions</button>
      </div>
      {visibleProjects.map(p => <ProjectFolder key={p.folder} project={p} />)}
      <UnorganizedSection entries={visibleUnorg} />
      {nothing && <div className="sb-empty">No graphs yet. AI writes to graphs/&lt;project&gt;/&lt;name&gt;.matgraph.json</div>}
      {!nothing && visibleProjects.length === 0 && visibleUnorg.length === 0 && <div className="sb-empty">No matches.</div>}
    </div>
  );
}

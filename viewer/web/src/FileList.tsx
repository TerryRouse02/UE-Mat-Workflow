import { useState } from 'react';
import { useStore } from './store';
import { groupFiles, type Project, type FileEntry } from './groupFiles';

function fileClass(type: FileEntry['type']): string {
  if (type === 'Material') return 'material';
  if (type === 'MaterialFunction') return 'mf';
  return 'unknown';
}

function icon(type: FileEntry['type']): string {
  if (type === 'Material') return '●';
  if (type === 'MaterialFunction') return '·';
  return '?';
}

function FileRow({ entry }: { entry: FileEntry }) {
  const { state, open } = useStore();
  const active = state.breadcrumb[0] === entry.path;
  const baseName = entry.path.split('/').pop()?.replace(/\.matgraph\.json$/, '') ?? entry.path;
  return (
    <div
      className={`tree-file ${fileClass(entry.type)} ${active ? 'active' : ''}`}
      onClick={() => open(entry.path)}
      title={entry.path}
    >
      <span className="tree-file-icon">{icon(entry.type)}</span> {baseName}
    </div>
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
          <FileRow entry={project.material} />
          {project.mfs.map(mf => <FileRow key={mf.path} entry={mf} />)}
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
  const { projects, unorganized } = groupFiles(state.files);
  return (
    <div>
      {projects.map(p => <ProjectFolder key={p.folder} project={p} />)}
      <UnorganizedSection entries={unorganized} />
      {projects.length === 0 && unorganized.length === 0 && (
        <div style={{ color: '#666', fontSize: 11 }}>No graphs yet. AI writes to graphs/&lt;project&gt;/&lt;name&gt;.matgraph.json</div>
      )}
    </div>
  );
}

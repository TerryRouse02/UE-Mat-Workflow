import { useState } from 'react';
import { useStore } from './store';
import { groupFiles, type FileEntry } from './groupFiles';
import { shouldConfirmOpen } from './largeGraphGate';
import { Icon } from './Icon';
import './files.css';

function baseName(path: string): string {
  return path.split('/').pop()?.replace(/\.matgraph\.json$/, '') ?? path;
}

interface FileRowProps {
  entry: FileEntry;
  onLargeGraph?(file: FileEntry): void;
}

function FileRow({ entry, onLargeGraph }: FileRowProps) {
  const { state, open } = useStore();
  const active = state.breadcrumb[0] === entry.path;
  const loaded = state.graphs[entry.path];
  const errored = (state.errors[entry.path]?.length ?? 0) > 0;
  const status: 'ok' | 'warn' | null = loaded
    ? ((loaded.warnings.length || errored) ? 'warn' : 'ok')
    : (errored ? 'warn' : null);
  const count = loaded ? loaded.graph.nodes.length : null;
  const displayCount = count ?? entry.nodeCount ?? null;
  const isCrawled = entry.origin === 'crawled';
  const isBig = shouldConfirmOpen(entry.nodeCount);

  const handleActivate = () => {
    if (isBig) {
      if (onLargeGraph) {
        onLargeGraph(entry);
      } else {
        const ok = window.confirm(
          `此圖表包含 ${entry.nodeCount} 個節點，載入可能需要較長時間。確定要開啟嗎？`,
        );
        if (!ok) return;
        open(entry.path);
      }
    } else {
      open(entry.path);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleActivate();
    }
  };

  const rowClass = ['frow', active ? 'sel' : '', isCrawled ? 'ro' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={rowClass}
      role="button"
      tabIndex={0}
      onClick={handleActivate}
      onKeyDown={handleKeyDown}
      title={entry.path}
    >
      <span className="tico">
        <Icon name={entry.type === 'MaterialFunction' ? 'func' : 'material'} size={15} />
      </span>
      <span className="nm">{baseName(entry.path)}</span>
      <span className="meta">
        {isBig && <span className="bigmark" title="大型圖">300+</span>}
        {displayCount != null && <span className="nc">{displayCount}</span>}
        {status && <span className={'sdot ' + status} title={status} />}
      </span>
    </div>
  );
}

interface GroupProps {
  title: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

function Group({ title, count, children, defaultOpen = true }: GroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="grp">
      <div
        className={'grp-head' + (open ? '' : ' collapsed')}
        role="button"
        tabIndex={0}
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setOpen(o => !o)}
      >
        <Icon name="caret" size={13} className="caret" />
        <span className="gt">{title}</span>
        <span className="gc">{count}</span>
      </div>
      {open && children}
    </div>
  );
}

export interface FileListProps {
  /** Navigates to the config tab (for "前往爬取" empty-state CTA). */
  onGotoConfig?(): void;
  /** Called when a large-graph entry is clicked, instead of window.confirm. */
  onLargeGraph?(file: FileEntry): void;
}

export function FileList({ onGotoConfig, onLargeGraph }: FileListProps = {}) {
  const { state } = useStore();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const { projects, unorganized, crawledProjects } = groupFiles(state.files);

  const matchFile = (e: FileEntry) =>
    !q || baseName(e.path).toLowerCase().includes(q) || e.path.toLowerCase().includes(q);

  // --- Agent-authored section (Materials + unorganized) ---
  const visibleProjects = projects
    .map(p => ({ ...p, files: p.files.filter(matchFile) }))
    .filter(p => p.files.length > 0);
  const visibleUnorg = unorganized.filter(matchFile);

  // Total agent-authored count (all types, pre-filter for badge)
  const agentTotal = projects.reduce((a, p) => a + p.files.length, 0) + unorganized.length;

  // --- Crawled section ---
  const visibleCrawled = crawledProjects
    .map(p => ({ ...p, files: p.files.filter(matchFile) }))
    .filter(p => p.files.length > 0);

  // --- Material Functions (from agent projects, flat list) ---
  const allAgentFiles = [
    ...projects.flatMap(p => p.files),
    ...unorganized,
  ];
  const visibleFunctions = allAgentFiles.filter(
    e => e.type === 'MaterialFunction' && matchFile(e),
  );

  return (
    <div className="files">
      <div className="files-search">
        <Icon name="search" size={14} />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="篩選材質…"
        />
      </div>

      {/* Section 1 — Agent-authored */}
      <div className="sec-label">
        代理產出 · Agent-authored
        <span className="badge">{agentTotal}</span>
      </div>
      {visibleProjects.map(p => (
        <Group key={p.folder} title={p.folder} count={p.files.length}>
          {p.files.map(f => (
            <FileRow key={f.path} entry={f} onLargeGraph={onLargeGraph} />
          ))}
        </Group>
      ))}
      {/* Unorganized files shown as a flat group if any */}
      {visibleUnorg.length > 0 && (
        <Group title="未分類" count={visibleUnorg.length} defaultOpen={false}>
          {visibleUnorg.map(f => (
            <FileRow key={f.path} entry={f} onLargeGraph={onLargeGraph} />
          ))}
        </Group>
      )}

      {/* Section 2 — Crawled project materials */}
      <div className="sec-crawled" style={{ marginTop: 6, paddingTop: 4 }}>
        <div className="sec-label" style={{ color: 'var(--accent)' }}>
          <Icon name="eye" size={13} />
          專案母材質（爬取）
          <span className="badge" style={{ borderColor: 'var(--accent-dim)', color: 'var(--accent)' }}>
            爬取 · 唯讀
          </span>
        </div>
        {crawledProjects.length === 0 ? (
          <div className="empty-crawl">
            <div className="eci">
              <Icon name="eye" size={17} />
            </div>
            <div className="ect">尚未爬取專案母材質</div>
            <div className="ecd">
              這個區段是「重爬專案母材質」的輸出。執行一次爬取後，你 /Game
              專案裡的母材質就會以唯讀鏡像出現在這裡。
            </div>
            <button
              className="btn sm primary"
              style={{ justifyContent: 'center' }}
              onClick={onGotoConfig}
            >
              <Icon name="refresh" size={13} /> 前往爬取
            </button>
          </div>
        ) : (
          visibleCrawled.map(p => (
            <Group key={p.folder} title={p.folder} count={p.files.length}>
              {p.files.map(f => (
                <FileRow key={f.path} entry={f} onLargeGraph={onLargeGraph} />
              ))}
            </Group>
          ))
        )}
      </div>

      {/* Section 3 — Material Functions flat list */}
      <div className="sec-label" style={{ marginTop: 8 }}>
        Material Functions
        <span className="badge">{visibleFunctions.length}</span>
      </div>
      {visibleFunctions.map(f => (
        <FileRow key={f.path} entry={f} onLargeGraph={onLargeGraph} />
      ))}
    </div>
  );
}

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

type TypeFilter = 'all' | 'material' | 'function';

const TYPE_SEGMENTS: { key: TypeFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'material', label: '材質' },
  { key: 'function', label: '函式' },
];

export function FileList({ onGotoConfig, onLargeGraph }: FileListProps = {}) {
  const { state } = useStore();
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const q = query.trim().toLowerCase();
  const { projects, unorganized, crawledProjects } = groupFiles(state.files);

  const matchQuery = (e: FileEntry) =>
    !q || baseName(e.path).toLowerCase().includes(q) || e.path.toLowerCase().includes(q);
  const matchType = (e: FileEntry) =>
    typeFilter === 'all' ? true
      : typeFilter === 'material' ? e.type === 'Material'
        : e.type === 'MaterialFunction';
  const matchFile = (e: FileEntry) => matchQuery(e) && matchType(e);

  // --- 專案 (agent-authored: project folders + unorganized) ---
  const visibleProjects = projects
    .map(p => ({ ...p, files: p.files.filter(matchFile) }))
    .filter(p => p.files.length > 0);
  const visibleUnorg = unorganized.filter(matchFile);
  const projectShown =
    visibleProjects.reduce((a, p) => a + p.files.length, 0) + visibleUnorg.length;

  // --- 工作 (crawled from the UE project) — kept separate by type: 母材質 vs 函式 ---
  const allCrawled = crawledProjects.flatMap(p => p.files);
  const crawledMats = allCrawled.filter(e => e.type === 'Material' && matchFile(e));
  const crawledFns = allCrawled.filter(e => e.type === 'MaterialFunction' && matchFile(e));

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

      {/* Type filter — 全部 / 材質 / 函式 */}
      <div className="ftypes">
        {TYPE_SEGMENTS.map(s => (
          <button
            key={s.key}
            className={'ftype' + (typeFilter === s.key ? ' on' : '')}
            onClick={() => setTypeFilter(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* 專案 · Project — what the agent authors for this project */}
      <div className="sec-label">
        專案 · Project
        <span className="badge">{projectShown}</span>
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

      {/* 工作 · Work — base materials crawled from the UE project (read-only) */}
      <div className="sec-crawled" style={{ marginTop: 6, paddingTop: 4 }}>
        <div className="sec-label" style={{ color: 'var(--accent)' }}>
          <Icon name="eye" size={13} />
          工作 · Work
          <span className="badge" style={{ borderColor: 'var(--accent-dim)', color: 'var(--accent)' }}>
            爬取 · 唯讀
          </span>
        </div>
        {crawledProjects.length === 0 ? (
          <div className="empty-crawl">
            <div className="eci">
              <Icon name="eye" size={17} />
            </div>
            <div className="ect">尚未爬取</div>
            <div className="ecd">
              這個區段是「爬取專案 MF / 母材質」的輸出。設定對應的 Content Route 後執行一次爬取，
              該目錄下的母材質與 MF 就會以唯讀鏡像出現在這裡（母材質、函式分開列出）。
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
          <>
            {crawledMats.length > 0 && (
              <Group title="母材質 Materials" count={crawledMats.length}>
                {crawledMats.map(f => (
                  <FileRow key={f.path} entry={f} onLargeGraph={onLargeGraph} />
                ))}
              </Group>
            )}
            {crawledFns.length > 0 && (
              <Group title="函式 Functions" count={crawledFns.length}>
                {crawledFns.map(f => (
                  <FileRow key={f.path} entry={f} onLargeGraph={onLargeGraph} />
                ))}
              </Group>
            )}
          </>
        )}
      </div>
    </div>
  );
}

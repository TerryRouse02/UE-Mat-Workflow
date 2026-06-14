import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  /** Live mode: start a compare of this file against the open graph. */
  onCompare?(path: string): void;
}

/** users/<name>/<proj> → 「<name> 的工作區 / <proj>」 (personal dirs). */
function groupTitle(folder: string, t: (key: string, opts?: Record<string, string>) => string): string {
  const m = folder.match(/^users\/([^/]+)(?:\/(.+))?$/);
  if (!m) return folder;
  return m[2]
    ? t('fileList.workspaceWithProject', { name: m[1], project: m[2] })
    : t('fileList.workspace', { name: m[1] });
}

function FileRow({ entry, onLargeGraph, onCompare }: FileRowProps) {
  const { t } = useTranslation();
  const { state, open } = useStore();
  const active = state.breadcrumb[0] === entry.path;
  const [menuOpen, setMenuOpen] = useState(false);
  const live = state.connection === 'live';

  // Human file management: thin client over POST /api/files; the server-side
  // watcher refreshes every client's list, so no local state to fix up.
  const fileOp = async (op: 'rename' | 'duplicate' | 'delete') => {
    setMenuOpen(false);
    let to: string | undefined;
    if (op !== 'delete') {
      const suggested = op === 'duplicate'
        ? entry.path.replace(/\.matgraph\.json$/, '-copy.matgraph.json')
        : entry.path;
      const input = window.prompt(op === 'rename' ? t('fileList.promptRename') : t('fileList.promptDuplicate'), suggested);
      if (!input || input === entry.path) return;
      to = input.trim();
    } else if (!window.confirm(t('fileList.confirmDelete', { path: entry.path }))) {
      return;
    }
    try {
      const r = await fetch('/api/files', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, path: entry.path, ...(to ? { to } : {}) }),
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        window.alert(t('fileList.opFailed', { detail: e.error || `HTTP ${r.status}` }));
      }
    } catch (e) {
      window.alert(t('fileList.opFailed', { detail: (e as Error).message }));
    }
  };
  const loaded = state.graphs[entry.path];
  const errored = (state.errors[entry.path]?.length ?? 0) > 0;
  // Opened files use their live status (most current); unopened files fall back to
  // the server's pre-scanned health so every file shows a dot from the start.
  // error (red) = load/validate failure, warn (yellow) = warnings, ok (green) = clean.
  const status: 'ok' | 'warn' | 'error' | null = errored
    ? 'error'
    : loaded
      ? (loaded.warnings.length ? 'warn' : 'ok')
      : (entry.health ?? null);
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
          t('fileList.confirmLargeGraph', { count: entry.nodeCount }),
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
      {entry.preview && (
        <span
          className="fswatch"
          title={t('fileList.previewTitle')}
          style={{ background: `rgb(${entry.preview.map(c => Math.round(c * 255)).join(',')})` }}
        />
      )}
      <span className="meta">
        {isBig && <span className="bigmark" title={t('fileList.largeGraph')}>300+</span>}
        {displayCount != null && <span className="nc">{displayCount}</span>}
        {status && <span className={'sdot ' + status} title={status} />}
        {live && (!isCrawled || (onCompare && !active)) && (
          <span className="fops" onClick={e => e.stopPropagation()}>
            <button
              className="fops-btn"
              title={t('fileList.fileOps')}
              onClick={() => setMenuOpen(o => !o)}
              onKeyDown={e => e.stopPropagation()}
            >
              <Icon name="more" size={12} />
            </button>
            {menuOpen && (
              <span className="fops-menu" onMouseLeave={() => setMenuOpen(false)}>
                {onCompare && !active && (
                  <button onClick={() => { setMenuOpen(false); onCompare(entry.path); }}>{t('fileList.compareWithCurrent')}</button>
                )}
                {!isCrawled && <button onClick={() => void fileOp('rename')}>{t('fileList.renameMove')}</button>}
                {!isCrawled && <button onClick={() => void fileOp('duplicate')}>{t('fileList.duplicate')}</button>}
                {!isCrawled && <button className="danger" onClick={() => void fileOp('delete')}>{t('fileList.delete')}</button>}
              </span>
            )}
          </span>
        )}
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
  /** Live mode: start a compare of a file against the open graph. */
  onCompare?(path: string): void;
}

type TypeFilter = 'all' | 'material' | 'function';

const TYPE_SEGMENTS: { key: TypeFilter; labelKey: string }[] = [
  { key: 'all', labelKey: 'fileList.typeAll' },
  { key: 'material', labelKey: 'fileList.typeMaterial' },
  { key: 'function', labelKey: 'fileList.typeFunction' },
];

export function FileList({ onGotoConfig, onLargeGraph, onCompare }: FileListProps = {}) {
  const { t } = useTranslation();
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
          placeholder={t('fileList.searchPlaceholder')}
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
            {t(s.labelKey)}
          </button>
        ))}
      </div>

      {/* 專案 · Project — what the agent authors for this project */}
      <div className="sec-label">
        {t('fileList.sectionProject')}
        <span className="badge">{projectShown}</span>
      </div>
      {visibleProjects.map(p => (
        <Group key={p.folder} title={groupTitle(p.folder, t)} count={p.files.length}>
          {p.files.map(f => (
            <FileRow key={f.path} entry={f} onLargeGraph={onLargeGraph} onCompare={onCompare} />
          ))}
        </Group>
      ))}
      {/* Unorganized files shown as a flat group if any */}
      {visibleUnorg.length > 0 && (
        <Group title={t('fileList.unorganized')} count={visibleUnorg.length} defaultOpen={false}>
          {visibleUnorg.map(f => (
            <FileRow key={f.path} entry={f} onLargeGraph={onLargeGraph} onCompare={onCompare} />
          ))}
        </Group>
      )}

      {/* 工作 · Work — base materials crawled from the UE project (read-only) */}
      <div className="sec-crawled" style={{ marginTop: 6, paddingTop: 4 }}>
        <div className="sec-label" style={{ color: 'var(--accent)' }}>
          <Icon name="eye" size={13} />
          {t('fileList.sectionWork')}
          <span className="badge" style={{ borderColor: 'var(--accent-dim)', color: 'var(--accent)' }}>
            {t('fileList.badgeCrawledReadonly')}
          </span>
        </div>
        {crawledProjects.length === 0 ? (
          <div className="empty-crawl">
            <div className="eci">
              <Icon name="eye" size={17} />
            </div>
            <div className="ect">{t('fileList.emptyCrawlTitle')}</div>
            <div className="ecd">
              {t('fileList.emptyCrawlDesc')}
            </div>
            <button
              className="btn sm primary"
              style={{ justifyContent: 'center' }}
              onClick={onGotoConfig}
            >
              <Icon name="refresh" size={13} /> {t('fileList.gotoCrawl')}
            </button>
          </div>
        ) : (
          <>
            {crawledMats.length > 0 && (
              <Group title={t('fileList.groupBaseMaterials')} count={crawledMats.length}>
                {crawledMats.map(f => (
                  <FileRow key={f.path} entry={f} onLargeGraph={onLargeGraph} onCompare={onCompare} />
                ))}
              </Group>
            )}
            {crawledFns.length > 0 && (
              <Group title={t('fileList.groupFunctions')} count={crawledFns.length}>
                {crawledFns.map(f => (
                  <FileRow key={f.path} entry={f} onLargeGraph={onLargeGraph} onCompare={onCompare} />
                ))}
              </Group>
            )}
          </>
        )}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { useStore } from './store';
import { groupFiles, type FileEntry } from './groupFiles';
import { shouldConfirmOpen } from './largeGraphGate';

function icon(type: FileEntry['type']): string {
  if (type === 'Material') return '◆';
  if (type === 'MaterialFunction') return 'ƒ';
  return '?';
}
function rowClass(type: FileEntry['type']): string {
  if (type === 'Material') return 'material';
  if (type === 'MaterialFunction') return 'mf';
  return 'unknown';
}
function baseName(path: string): string {
  return path.split('/').pop()?.replace(/\.matgraph\.json$/, '') ?? path;
}
const isFn = (e: FileEntry) => e.type === 'MaterialFunction';

function FileRow({ entry, ro }: { entry: FileEntry; ro?: boolean }) {
  const { state, open } = useStore();
  const active = state.breadcrumb[0] === entry.path;
  const loaded = state.graphs[entry.path];
  const errored = (state.errors[entry.path]?.length ?? 0) > 0;
  const status: 'ok' | 'warn' | null = loaded
    ? ((loaded.warnings.length || errored) ? 'warn' : 'ok')
    : (errored ? 'warn' : null);
  const count = loaded ? loaded.graph.nodes.length : null;
  // Prefer the loaded node count (live); fall back to the server-reported nodeCount.
  const displayCount = count ?? entry.nodeCount ?? null;
  const big = shouldConfirmOpen(entry.nodeCount);
  const handleClick = () => {
    if (shouldConfirmOpen(entry.nodeCount)) {
      const ok = window.confirm(
        `此圖表包含 ${entry.nodeCount} 個節點，載入可能需要較長時間。確定要開啟嗎？`,
      );
      if (!ok) return;
    }
    open(entry.path);
  };
  return (
    <button className={`frow ${rowClass(entry.type)} ${active ? 'sel' : ''} ${ro ? 'ro' : ''}`}
      onClick={handleClick} title={entry.path}>
      <span className="tico">{icon(entry.type)}</span>
      <span className="nm">{baseName(entry.path)}</span>
      <span className="meta">
        {big && <span className="bigmark">300+</span>}
        {status && <span className={`sdot ${status}`} />}
        {displayCount != null && <span className="nc">{displayCount}</span>}
      </span>
    </button>
  );
}

function Grp({ folder, files, ro }: { folder: string; files: FileEntry[]; ro?: boolean }) {
  const [open, setOpen] = useState(true);
  if (files.length === 0) return null;
  return (
    <div className="grp">
      <div className={`grp-head ${open ? '' : 'collapsed'}`} onClick={() => setOpen(o => !o)}>
        <span className="caret">▾</span>
        <span className="gt">{folder}</span>
        <span className="gc">{files.length}</span>
      </div>
      {open && files.map(f => <FileRow key={f.path} entry={f} ro={ro} />)}
    </div>
  );
}

export function FileList({ onGoConfig }: { onGoConfig?: () => void }) {
  const { state } = useStore();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const { projects, unorganized, crawledProjects } = groupFiles(state.files);

  const match = (e: FileEntry) =>
    !q || baseName(e.path).toLowerCase().includes(q) || e.path.toLowerCase().includes(q);

  // Agent materials grouped by project; agent functions pulled into one flat section.
  const matProjects = projects
    .map(p => ({ folder: p.folder, files: p.files.filter(f => !isFn(f) && match(f)) }))
    .filter(p => p.files.length > 0);
  const unorgMaterials = unorganized.filter(f => !isFn(f) && match(f));
  const functions = [...projects.flatMap(p => p.files), ...unorganized].filter(f => isFn(f) && match(f))
    .sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)));
  const crawled = crawledProjects
    .map(p => ({ folder: p.folder, files: p.files.filter(match) }))
    .filter(p => p.files.length > 0);

  const nothing = state.files.length === 0;
  const noMatch = !nothing && matProjects.length === 0 && unorgMaterials.length === 0 && functions.length === 0 && crawled.length === 0;

  return (
    <div className="files">
      <div className="files-search">
        <span>⌕</span>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜尋材質、函式…" spellCheck={false} />
        {query && <span className="clr" onClick={() => setQuery('')}>×</span>}
      </div>

      <div className="sec-label">代理產出 · Agent-authored</div>
      {matProjects.map(p => <Grp key={p.folder} folder={p.folder} files={p.files} />)}
      {unorgMaterials.length > 0 && <Grp folder="（未分類）" files={unorgMaterials} />}
      {matProjects.length === 0 && unorgMaterials.length === 0 && !nothing && (
        <div className="sb-empty">此分類沒有符合的材質。</div>
      )}

      <div className="sec-label">專案母材質（爬取）<span className="badge">爬取 · 唯讀</span></div>
      {crawled.length > 0 ? (
        <div className="sec-crawled">
          {crawled.map(p => <Grp key={p.folder} folder={p.folder} files={p.files} ro />)}
        </div>
      ) : (
        <div className="empty-crawl">
          <div className="eci">◆</div>
          <div className="ect">尚未爬取專案母材質</div>
          <div className="ecd">這個區段是「重爬專案母材質」的輸出。執行一次爬取後，你 /Game 專案裡的母材質就會以唯讀鏡像出現在這裡。</div>
          <button className="btn sm primary" onClick={onGoConfig}>前往爬取</button>
        </div>
      )}

      {functions.length > 0 && (
        <>
          <div className="sec-label">Material Functions</div>
          {functions.map(f => <FileRow key={f.path} entry={f} />)}
        </>
      )}

      {nothing && <div className="sb-empty">尚無圖檔。AI 會寫入 graphs/&lt;project&gt;/&lt;name&gt;.matgraph.json</div>}
      {noMatch && <div className="sb-empty">沒有符合「{query}」的結果。</div>}
    </div>
  );
}

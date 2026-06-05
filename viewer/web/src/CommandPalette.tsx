import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import { useDb } from './dbContext';
import { shouldConfirmOpen } from './largeGraphGate';

export type Tab = 'files' | 'nodes' | 'config';

interface Item { id: string; group: string; label: string; hint?: string; ico: string; run: () => void; }

function baseName(p: string): string {
  return p.split('/').pop()?.replace(/\.matgraph\.json$/, '') ?? p;
}

// ⌘K / Ctrl-K palette: fuzzy search over commands + files + node types, with
// arrow-key navigation. Pure client; mirrors the mockup's command palette.
export function CommandPalette({ open, onClose, setTab }: { open: boolean; onClose: () => void; setTab: (t: Tab) => void }) {
  const { state, open: openFile } = useStore();
  const { db } = useDb();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) { setQ(''); setSel(0); const id = setTimeout(() => inputRef.current?.focus(), 0); return () => clearTimeout(id); }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [
      { id: 'go-files', group: '指令', label: '前往 Files', ico: '▤', run: () => setTab('files') },
      { id: 'go-nodes', group: '指令', label: '前往 Nodes', ico: '◆', run: () => setTab('nodes') },
      { id: 'go-config', group: '指令', label: '前往 Config / 爬取', ico: '⚙', run: () => setTab('config') },
    ];
    for (const f of state.files) {
      out.push({
        id: 'file:' + f.path, group: '檔案', label: baseName(f.path),
        hint: f.type === 'MaterialFunction' ? 'Function' : f.type, ico: f.type === 'MaterialFunction' ? 'ƒ' : '◆',
        run: () => {
          if (shouldConfirmOpen(f.nodeCount) && !window.confirm(`此圖表包含 ${f.nodeCount} 個節點,載入可能較久。確定開啟?`)) return;
          openFile(f.path);
        },
      });
    }
    for (const name of Object.keys(db.nodes)) {
      out.push({ id: 'node:' + name, group: '節點', label: name, hint: db.nodes[name].category, ico: '◇', run: () => setTab('nodes') });
    }
    return out;
  }, [state.files, db, setTab, openFile]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s ? items.filter(i => i.label.toLowerCase().includes(s) || i.group.toLowerCase().includes(s)) : items;
    return list.slice(0, 60);
  }, [items, q]);

  useEffect(() => { setSel(0); }, [q]);
  useEffect(() => {
    const el = listRef.current?.querySelector('.cmdk-item.on');
    el?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;
  const groups = [...new Set(filtered.map(i => i.group))];
  const run = (i: Item) => { i.run(); onClose(); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(s + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = filtered[sel]; if (it) run(it); }
  };

  let idx = -1;
  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal cmdk" onClick={e => e.stopPropagation()} onKeyDown={onKey}>
        <div className="cmdk-input">
          <span>⌕</span>
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} placeholder="搜尋檔案、節點、指令…" spellCheck={false} />
          <kbd>Esc</kbd>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {filtered.length === 0 && <div className="cmdk-empty">沒有符合「{q}」的結果。</div>}
          {groups.map(g => (
            <div key={g}>
              <div className="cmdk-group">{g}</div>
              {filtered.filter(i => i.group === g).map(i => {
                idx++; const myIdx = idx;
                return (
                  <div key={i.id} className={`cmdk-item ${myIdx === sel ? 'on' : ''}`}
                    onMouseEnter={() => setSel(myIdx)} onClick={() => run(i)}>
                    <span className="ci">{i.ico}</span>
                    <span className="cl">{i.label}</span>
                    {i.hint && <span className="ck">{i.hint}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

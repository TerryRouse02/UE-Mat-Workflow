import { useMemo, useState } from 'react';
import { DB } from './db';
import type { NodeDef, PinDef, ParamDef } from '../../server/db-types';

interface NodeEntry {
  name: string;
  def: NodeDef;
}

function groupByCategory(entries: NodeEntry[]): Record<string, NodeEntry[]> {
  const out: Record<string, NodeEntry[]> = {};
  for (const e of entries) {
    const cat = e.def.category || 'Uncategorized';
    if (!out[cat]) out[cat] = [];
    out[cat].push(e);
  }
  for (const cat of Object.keys(out)) {
    out[cat].sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

function PinList({ title, pins }: { title: string; pins: PinDef[] }) {
  if (!pins || pins.length === 0) return null;
  return (
    <div className="lib-node-detail-section">
      <div className="lib-node-detail-section-title">{title}</div>
      {pins.map(p => (
        <div key={p.name} className="lib-node-detail-pin">
          {p.name} : {p.type}{p.required ? ' *' : ''}
        </div>
      ))}
    </div>
  );
}

function ParamList({ params }: { params?: ParamDef[] }) {
  if (!params || params.length === 0) return null;
  return (
    <div className="lib-node-detail-section">
      <div className="lib-node-detail-section-title">Params</div>
      {params.map(p => (
        <div key={p.name} className="lib-node-detail-pin">
          {p.name} : {p.type}
          {p.default !== undefined ? ` = ${JSON.stringify(p.default)}` : ''}
          {p.required ? ' *' : ''}
          {p.when ? ` (${p.when})` : ''}
        </div>
      ))}
    </div>
  );
}

function NodeDetail({ def }: { def: NodeDef }) {
  return (
    <div className="lib-node-detail">
      {def.description && <div className="lib-node-detail-desc">{def.description}</div>}
      <div>
        {def.verified && <span className="lib-badge verified">verified</span>}
        {def.dynamicPins && <span className="lib-badge dynamic">dynamic</span>}
        {def.deprecated && <span className="lib-badge deprecated">deprecated</span>}
      </div>
      <PinList title="Inputs" pins={def.inputs} />
      <PinList title="Outputs" pins={def.outputs} />
      <ParamList params={def.params} />
      {def.dynamicPins && def.pinInfo && (
        <div className="lib-node-detail-section">
          <div className="lib-node-detail-section-title">Pin rule</div>
          <div style={{ fontStyle: 'italic', color: 'var(--fg-dim)' }}>{def.pinInfo}</div>
        </div>
      )}
    </div>
  );
}

function CategoryBlock({
  category, entries, expandedAll, expanded, onToggle, openNode, setOpenNode,
}: {
  category: string;
  entries: NodeEntry[];
  expandedAll: boolean;
  expanded: boolean;
  onToggle: () => void;
  openNode: string | null;
  setOpenNode: (name: string | null) => void;
}) {
  const showChildren = expandedAll || expanded;
  return (
    <div className="lib-cat">
      <div className="lib-cat-header" onClick={onToggle}>
        {showChildren ? '▼' : '▶'} {category} ({entries.length})
      </div>
      {showChildren && (
        <div className="lib-cat-children">
          {entries.map(e => (
            <div key={e.name}>
              <div
                className="lib-node"
                onClick={() => setOpenNode(openNode === e.name ? null : e.name)}
              >{e.name}</div>
              {openNode === e.name && <NodeDetail def={e.def} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function NodeLibrary() {
  const [query, setQuery] = useState('');
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const [openNode, setOpenNode] = useState<string | null>(null);
  const [cat, setCat] = useState<string>('All');

  const allEntries: NodeEntry[] = useMemo(
    () => Object.entries(DB.nodes).map(([name, def]) => ({ name, def })),
    []
  );

  const q = query.trim().toLowerCase();
  const filtered = q
    ? allEntries.filter(e =>
        e.name.toLowerCase().includes(q) ||
        (e.def.description || '').toLowerCase().includes(q)
      )
    : allEntries;

  const allCats = useMemo(
    () => ['All', ...Array.from(new Set(allEntries.map(e => e.def.category || 'Uncategorized'))).sort()],
    [allEntries]
  );

  const catFiltered = cat === 'All' ? filtered : filtered.filter(e => (e.def.category || 'Uncategorized') === cat);
  const grouped = useMemo(() => groupByCategory(catFiltered), [catFiltered]);
  const categories = Object.keys(grouped).sort();
  const expandAll = q.length > 0;

  return (
    <div>
      <input
        className="lib-search"
        type="text"
        placeholder="Search nodes (name + description)"
        value={query}
        onChange={e => setQuery(e.target.value)}
      />
      <div className="sb-cats">
        {allCats.map(c => (
          <button key={c} className={`sb-cat ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c}</button>
        ))}
      </div>
      {categories.length === 0 && (
        <div style={{ color: 'var(--fg-faint)', fontSize: 11, padding: 8 }}>No matches for "{query}"</div>
      )}
      {categories.map(cat => (
        <CategoryBlock
          key={cat}
          category={cat}
          entries={grouped[cat]}
          expandedAll={expandAll}
          expanded={expandedCats.has(cat)}
          onToggle={() => {
            const s = new Set(expandedCats);
            if (s.has(cat)) s.delete(cat); else s.add(cat);
            setExpandedCats(s);
          }}
          openNode={openNode}
          setOpenNode={setOpenNode}
        />
      ))}
    </div>
  );
}

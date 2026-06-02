import { useMemo, useState } from 'react';
import { useDb } from './dbContext';
import { engineMfFor, type EngineMfEntry } from './engineMfRegistry';
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
        {def.verified
          ? <span className="lib-badge verified">verified</span>
          : <span className="lib-badge provisional">provisional</span>}
        {def.dynamicPins && <span className="lib-badge dynamic">dynamic</span>}
        {def.deprecated && <span className="lib-badge deprecated">deprecated</span>}
      </div>
      {!def.verified && (
        <div className="lib-prov-note">
          Auto-discovered: pin <em>names</em> are reflected from UE, but <em>types</em> are
          placeholders (<code>Float1|2|3|4</code>) until hand-checked.
        </div>
      )}
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
              >
                {e.name}
                {!e.def.verified && (
                  <span className="lib-prov-dot" title="Provisional: pin names reflected, types placeholder">●</span>
                )}
              </div>
              {openNode === e.name && <NodeDetail def={e.def} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Official engine Material Function browser ----

function mfDisplayName(e: EngineMfEntry): string {
  if (e.displayName) return e.displayName;
  const obj = e.assetPath.split('.').pop() ?? e.assetPath;
  return obj.split('/').pop() ?? e.assetPath;
}

// Group key = the folder right under /Engine/Functions (Engine_MaterialFunctions02, …),
// or the package's leading segment for plugin-provided MFs.
function mfGroup(e: EngineMfEntry): string {
  const m = e.assetPath.match(/^\/Engine\/Functions\/([^/]+)/);
  if (m) return m[1];
  const segs = (e.category || e.assetPath).split('/').filter(Boolean);
  return segs[1] || segs[0] || 'Other';
}

function MfPinList({ title, pins }: { title: string; pins: EngineMfEntry['inputs'] }) {
  if (!pins || pins.length === 0) return null;
  return (
    <div className="lib-node-detail-section">
      <div className="lib-node-detail-section-title">{title}</div>
      {pins.map((p, i) => (
        <div key={`${p.name}-${i}`} className="lib-node-detail-pin">{p.name} : {p.type}</div>
      ))}
    </div>
  );
}

function MfBrowser({ version, query }: { version: string | undefined; query: string }) {
  const index = engineMfFor(version);
  const [open, setOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [openMf, setOpenMf] = useState<string | null>(null);

  const all = useMemo(() => (index ? Object.values(index.functions) : []), [index]);
  const q = query.trim().toLowerCase();
  const matched = q
    ? all.filter(e => mfDisplayName(e).toLowerCase().includes(q) || e.assetPath.toLowerCase().includes(q))
    : all;

  const grouped = useMemo(() => {
    const out: Record<string, EngineMfEntry[]> = {};
    for (const e of matched) (out[mfGroup(e)] ??= []).push(e);
    for (const g of Object.keys(out)) out[g].sort((a, b) => mfDisplayName(a).localeCompare(mfDisplayName(b)));
    return out;
  }, [matched]);
  const groupNames = Object.keys(grouped).sort();

  if (!index) return null;
  const showRoot = open || q.length > 0;        // a search auto-opens the section

  return (
    <div className="lib-cat lib-mf-root">
      <div className="lib-cat-header" onClick={() => setOpen(o => !o)}>
        {showRoot ? '▼' : '▶'} ƒ Official Material Functions ({matched.length}{q ? `/${all.length}` : ''})
      </div>
      {showRoot && (
        <div className="lib-cat-children">
          {groupNames.length === 0 && (
            <div className="lib-prov-note">No official MF matches "{query}".</div>
          )}
          {groupNames.map(g => {
            const showG = q.length > 0 || openGroups.has(g);
            return (
              <div key={g} className="lib-cat">
                <div
                  className="lib-cat-header"
                  onClick={() => setOpenGroups(s => { const n = new Set(s); n.has(g) ? n.delete(g) : n.add(g); return n; })}
                >{showG ? '▼' : '▶'} {g} ({grouped[g].length})</div>
                {showG && (
                  <div className="lib-cat-children">
                    {grouped[g].map(e => (
                      <div key={e.assetPath}>
                        <div className="lib-node" onClick={() => setOpenMf(openMf === e.assetPath ? null : e.assetPath)}>
                          ƒ {mfDisplayName(e)}
                        </div>
                        {openMf === e.assetPath && (
                          <div className="lib-node-detail">
                            <div className="lib-node-detail-desc" style={{ wordBreak: 'break-all' }}>{e.assetPath}</div>
                            <MfPinList title="Inputs" pins={e.inputs} />
                            <MfPinList title="Outputs" pins={e.outputs} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function NodeLibrary() {
  const { db, version } = useDb();
  const [query, setQuery] = useState('');
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const [openNode, setOpenNode] = useState<string | null>(null);
  const [cat, setCat] = useState<string>('All');
  const [showProvisional, setShowProvisional] = useState(false);

  const rawEntries: NodeEntry[] = useMemo(
    () => Object.entries(db.nodes).map(([name, def]) => ({ name, def })),
    [db]
  );
  // verified:false nodes were auto-discovered: pin names real, types placeholder. Hidden
  // by default so the palette shows the hand-verified set; the toggle brings them back
  // (clearly badged), and a search always looks across both.
  const provisionalCount = useMemo(() => rawEntries.filter(e => !e.def.verified).length, [rawEntries]);
  const allEntries = useMemo(
    () => (showProvisional ? rawEntries : rawEntries.filter(e => e.def.verified)),
    [rawEntries, showProvisional]
  );

  const q = query.trim().toLowerCase();
  // A search reaches across both verified and provisional nodes even when the latter
  // are hidden; an empty search respects the toggle.
  const filtered = q
    ? rawEntries.filter(e =>
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
      {provisionalCount > 0 && (
        <label className="lib-prov-toggle">
          <input type="checkbox" checked={showProvisional} onChange={e => setShowProvisional(e.target.checked)} />
          Show provisional nodes ({provisionalCount}) <span className="lib-prov-dot">●</span>
        </label>
      )}
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
      <MfBrowser version={version} query={query} />
    </div>
  );
}

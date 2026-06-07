import { useMemo, useState } from 'react';
import { useDb } from './dbContext';
import { type EngineMfEntry } from './engineMfRegistry';
import type { NodeDef } from '../../server/db-types';
import type { WorkMfEntry } from '../../server/workmf-types';
import { Icon } from './Icon';
import { mapPinTypeColor, mapCatColor } from './nodeLibraryConstants';
import './nodes.css';

// ---- Helper: display name for MF entries ------------------------------------

function engineMfName(e: EngineMfEntry): string {
  if (e.displayName) return e.displayName;
  const obj = e.assetPath.split('.').pop() ?? e.assetPath;
  return obj.split('/').pop() ?? e.assetPath;
}

function workMfName(e: WorkMfEntry): string {
  if (e.displayName) return e.displayName;
  const obj = e.assetPath.split('.').pop() ?? e.assetPath;
  return obj.split('/').pop() ?? e.assetPath;
}

function mfPath(assetPath: string): string {
  const pkg = assetPath.split('.')[0];
  const slash = pkg.lastIndexOf('/');
  return slash > 0 ? pkg.slice(0, slash) : '';
}

// ---- NTRowItem: unified shape for NodeTypeRow --------------------------------

interface NTRowItem {
  id: string;
  name: string;
  cat?: string;         // node type category key
  src: 'engine' | 'project';
  used: string;         // "—" because no data available
  // MF-specific
  isMF: boolean;
  path?: string;
  missing?: boolean;
  // signature
  ins: Array<{ l: string; t: string }>;
  outs: Array<{ l: string; t: string }>;
}

function nodeDefToNTRowItem(name: string, def: NodeDef): NTRowItem {
  return {
    id: name,
    name,
    cat: def.category,
    src: 'engine',
    used: '—',
    isMF: false,
    ins: (def.inputs || []).map(p => ({ l: p.name, t: p.type })),
    outs: (def.outputs || []).map(p => ({ l: p.name, t: p.type })),
  };
}

function engineMfToNTRowItem(e: EngineMfEntry): NTRowItem {
  return {
    id: e.assetPath,
    name: engineMfName(e),
    src: 'engine',
    used: '—',
    isMF: true,
    path: mfPath(e.assetPath),
    ins: (e.inputs || []).map(p => ({ l: p.name, t: p.type })),
    outs: (e.outputs || []).map(p => ({ l: p.name, t: p.type })),
  };
}

function workMfToNTRowItem(e: WorkMfEntry): NTRowItem {
  return {
    id: e.assetPath,
    name: workMfName(e),
    src: 'project',
    used: '—',
    isMF: true,
    missing: e.missing,
    path: mfPath(e.assetPath),
    ins: (e.inputs || []).map(p => ({ l: p.name, t: p.type })),
    outs: (e.outputs || []).map(p => ({ l: p.name, t: p.type })),
  };
}

// ---- SigCol -----------------------------------------------------------------

function SigCol({ title, pins }: { title: string; pins: Array<{ l: string; t: string }> }) {
  if (!pins || pins.length === 0) return null;
  return (
    <div className="sigcol">
      <div className="sub">{title}</div>
      {pins.map((p, i) => (
        <div className="sigrow" key={i}>
          <span className="sc" style={{ background: mapPinTypeColor(p.t) }} />
          <span className="sl">{p.l || '—'}</span>
          <span className="st">{p.t}</span>
        </div>
      ))}
    </div>
  );
}

// ---- NodeTypeRow ------------------------------------------------------------

function NodeTypeRow({
  item,
  open,
  onToggle,
}: {
  item: NTRowItem;
  open: boolean;
  onToggle: () => void;
}) {
  // The viewer is read-only (it can't inject into UE), but the one thing that IS
  // useful from here is grabbing the exact identifier to author with: the node
  // type name for a DB node, or the asset path for a Material Function.
  const [copied, setCopied] = useState(false);
  const copyText = item.isMF ? item.id : item.name;
  const copyLabel = item.isMF ? '複製資產路徑' : '複製型別名稱';
  const onCopy = () => {
    void navigator.clipboard.writeText(copyText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  // Dot colour: MF uses error/text-mute/accent; node type uses category colour.
  const dot: string = item.isMF
    ? item.missing
      ? 'var(--error)'
      : item.src === 'engine'
        ? 'var(--text-mute)'
        : 'var(--accent)'
    : mapCatColor(item.cat);

  // Dot shape: MF = circle, node type = 2px rounded square (matches .ndot2 default).
  const dotRadius = item.isMF ? '50%' : 2;

  return (
    <div className={'ntrow' + (open ? ' open' : '')}>
      <div className="nth" onClick={onToggle}>
        <span className="ndot2" style={{ background: dot, borderRadius: dotRadius }} />
        <span className="nname">
          {item.name}
          {item.missing && <span className="miss">missing</span>}
        </span>
        <span className="nsrc">{item.src === 'engine' ? 'Engine' : 'Project'}</span>
        <span className="nused">×{item.used}</span>
      </div>
      {open && (
        <div className="ntdetail">
          {item.isMF && item.path !== undefined && (
            <div className="sig">{item.path}/{item.name}</div>
          )}
          {!item.isMF && (
            <div className="sig">
              {item.cat ?? 'Uncategorized'} · {item.src === 'engine' ? '原生節點' : '專案節點'}
            </div>
          )}
          <SigCol title="輸入 Inputs" pins={item.ins} />
          <SigCol title="輸出 Outputs" pins={item.outs} />
          {/* Viewer is read-only; offer the useful read-only action instead of a
              dead "insert to canvas" button — copy the authoring identifier. */}
          <button
            className="btn sm"
            style={{ marginTop: 10, width: '100%', justifyContent: 'center' }}
            onClick={onCopy}
          >
            <Icon name={copied ? 'check' : 'clip'} size={12} /> {copied ? '已複製' : copyLabel}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- NodeLibrary (exported) -------------------------------------------------

export function NodeLibrary() {
  const { db, engineMf, workMf } = useDb();

  const [seg, setSeg] = useState<'types' | 'mf'>('types');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [showProvisional, setShowProvisional] = useState(false);

  // Build the types list from db.nodes.
  const rawTypeItems = useMemo<NTRowItem[]>(
    () => Object.entries(db.nodes).map(([name, def]) => nodeDefToNTRowItem(name, def)),
    [db]
  );
  const provisionalCount = useMemo(
    () => rawTypeItems.filter(item => !db.nodes[item.id]?.verified).length,
    [rawTypeItems, db]
  );
  const typeItems = useMemo(
    () => (showProvisional ? rawTypeItems : rawTypeItems.filter(item => db.nodes[item.id]?.verified)),
    [rawTypeItems, showProvisional, db]
  );

  // Build the MF list: engine MF + work MF merged.
  const engineMfItems = useMemo<NTRowItem[]>(
    () => (engineMf ? Object.values(engineMf.functions).map(e => engineMfToNTRowItem(e)) : []),
    [engineMf]
  );
  const workMfItems = useMemo<NTRowItem[]>(
    () => (workMf ? Object.values(workMf.functions).map(e => workMfToNTRowItem(e)) : []),
    [workMf]
  );
  const mfItems = useMemo<NTRowItem[]>(
    () => [...engineMfItems, ...workMfItems],
    [engineMfItems, workMfItems]
  );

  // Segment counts shown in the switcher.
  const typeCount = rawTypeItems.length;
  const mfCount = mfItems.length;

  // Filtered list for current segment.
  const activeList = seg === 'types' ? typeItems : mfItems;
  const filtered = useMemo<NTRowItem[]>(() => {
    const lq = q.trim().toLowerCase();
    if (!lq) return activeList;
    return activeList.filter(
      item =>
        item.name.toLowerCase().includes(lq) ||
        (item.path ?? '').toLowerCase().includes(lq) ||
        (item.cat ?? '').toLowerCase().includes(lq)
    );
  }, [activeList, q]);

  function handleSegChange(s: 'types' | 'mf') {
    setSeg(s);
    setOpenId(null);
  }

  return (
    <div className="ntab">
      {/* Search */}
      <div className="files-search" style={{ margin: '4px 6px 6px' }}>
        <Icon name="search" size={14} />
        <input
          placeholder={seg === 'types' ? '搜尋節點型別…' : '搜尋 Material Function…'}
          value={q}
          onChange={e => setQ(e.target.value)}
        />
      </div>

      {/* Segment switcher */}
      <div className="nt-seg">
        <button
          className={seg === 'types' ? 'on' : ''}
          onClick={() => handleSegChange('types')}
        >
          節點型別{' '}
          <span style={{ fontFamily: 'var(--font-mono)', opacity: 0.6 }}>{typeCount}</span>
        </button>
        <button
          className={seg === 'mf' ? 'on' : ''}
          onClick={() => handleSegChange('mf')}
        >
          Material Function{' '}
          <span style={{ fontFamily: 'var(--font-mono)', opacity: 0.6 }}>{mfCount}</span>
        </button>
      </div>

      {/* Static note */}
      <div className="note">
        <Icon name="branch" size={11} /> 由爬取刷新（節點型別 / 引擎 MF / 專案 MF）
      </div>

      {/* Provisional toggle — types segment only */}
      {seg === 'types' && provisionalCount > 0 && (
        <label className="prov-toggle">
          <input
            type="checkbox"
            checked={showProvisional}
            onChange={e => setShowProvisional(e.target.checked)}
          />
          顯示暫定節點 ({provisionalCount}) <span className="prov-dot">●</span>
        </label>
      )}

      {/* Row list */}
      <div style={{ padding: '0 4px' }}>
        {filtered.map(item => (
          <NodeTypeRow
            key={item.id}
            item={item}
            open={openId === item.id}
            onToggle={() => setOpenId(o => (o === item.id ? null : item.id))}
          />
        ))}
        {filtered.length === 0 && q && (
          <div className="empty">找不到符合「{q}」的項目。</div>
        )}
        {filtered.length === 0 && !q && seg === 'mf' && mfCount === 0 && (
          <div className="empty">尚無 Material Function 資料。請先執行爬取。</div>
        )}
      </div>
    </div>
  );
}

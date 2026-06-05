/* ===================== Nodes tab — type & MF-signature browser ============ */
function SigCol({ title, pins }) {
  if (!pins || !pins.length) return null;
  return (
    <div className="sigcol">
      <div className="sub">{title}</div>
      {pins.map((p, i) => (
        <div className="sigrow" key={i}>
          <span className="sc" style={{ background: PIN_TYPES[p.t].color }} />
          <span className="sl">{p.l || "—"}</span>
          <span className="st">{PIN_TYPES[p.t].label}</span>
        </div>
      ))}
    </div>
  );
}

function NodeTypeRow({ item, isMF, open, onToggle, onInsert }) {
  const cat = isMF ? null : CATEGORIES[item.cat];
  const dot = isMF ? (item.missing ? "var(--error)" : item.src === "engine" ? "var(--text-mute)" : "var(--accent)") : cat.color;
  return (
    <div className={"ntrow" + (open ? " open" : "")}>
      <div className="nth" onClick={onToggle}>
        <span className="ndot2" style={{ background: dot, borderRadius: isMF ? "50%" : 2 }} />
        <span className="nname">{item.name}{item.missing && <span className="miss">missing</span>}</span>
        <span className="nsrc">{item.src === "engine" ? "Engine" : "Project"}</span>
        <span className="nused">×{item.used}</span>
      </div>
      {open && (
        <div className="ntdetail">
          {isMF && <div className="sig">{item.path}/{item.name}</div>}
          {!isMF && <div className="sig">{cat.label} · {item.src === "engine" ? "原生節點" : "專案節點"}</div>}
          <SigCol title="輸入 Inputs" pins={item.ins} />
          <SigCol title="輸出 Outputs" pins={item.outs} />
          <button className="btn sm" style={{ marginTop: 10, width: "100%", justifyContent: "center" }}><Icon name="plus" size={12} /> 插入到畫布</button>
        </div>
      )}
    </div>
  );
}

function NodesPanel() {
  const [seg, setSeg] = React.useState("types");
  const [q, setQ] = React.useState("");
  const [open, setOpen] = React.useState(null);
  const list = seg === "types" ? NODE_TYPES : MF_SIGS;
  const filtered = list.filter(n => n.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="ntab">
      <div className="files-search" style={{ margin: "4px 6px 6px" }}>
        <Icon name="search" size={14} />
        <input placeholder={seg === "types" ? "搜尋節點型別…" : "搜尋 Material Function…"} value={q} onChange={e => setQ(e.target.value)} />
      </div>
      <div className="nt-seg">
        <button className={seg === "types" ? "on" : ""} onClick={() => { setSeg("types"); setOpen(null); }}>節點型別 <span style={{ fontFamily: "var(--font-mono)", opacity: .6 }}>{NODE_TYPES.length}</span></button>
        <button className={seg === "mf" ? "on" : ""} onClick={() => { setSeg("mf"); setOpen(null); }}>Material Function <span style={{ fontFamily: "var(--font-mono)", opacity: .6 }}>{MF_SIGS.length}</span></button>
      </div>
      <div className="note" style={{ padding: "0 10px 8px", display: "flex", alignItems: "center", gap: 6 }}>
        <Icon name="branch" size={11} /> 由爬取刷新（節點型別 / 引擎 MF / 專案 MF）
      </div>
      <div style={{ padding: "0 4px" }}>
        {filtered.map(n => (
          <NodeTypeRow key={n.id} item={n} isMF={seg === "mf"} open={open === n.id} onToggle={() => setOpen(o => o === n.id ? null : n.id)} />
        ))}
        {filtered.length === 0 && <div className="empty">找不到符合「{q}」的項目。</div>}
      </div>
    </div>
  );
}

Object.assign(window, { NodesPanel });

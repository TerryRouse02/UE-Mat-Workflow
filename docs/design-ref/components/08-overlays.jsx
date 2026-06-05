/* ===================== Overlays — confirm · ⌘K palette · toast ============ */

/* ---- large-graph (>300 nodes) confirm ---- */
function BigGraphConfirm({ file, onCancel, onConfirm }) {
  return (
    <div className="scrim" onMouseDown={onCancel}>
      <div className="modal" onMouseDown={e => e.stopPropagation()}>
        <div className="modal-head">
          <Icon name="warn" size={18} style={{ color: "var(--warn)" }} />
          <div className="mt">開啟大型圖？</div>
        </div>
        <div className="modal-body">
          <p style={{ margin: "0 0 16px", color: "var(--text-dim)" }}><b style={{ color: "var(--text)" }}>{file.name}</b> 是一張大型材質圖。一次渲染所有節點可能會讓瀏覽器短暫卡頓。</p>
          <div className="canvas-msg" style={{ position: "static" }}>
            <div className="stat" style={{ margin: 0 }}>
              <div className="s"><div className="v" style={{ color: "var(--warn)" }}>{file.nodes}</div><div className="l">節點</div></div>
              <div className="s"><div className="v">~{Math.round(file.nodes * 1.6)}</div><div className="l">連線</div></div>
              <div className="s"><div className="v">38 MB</div><div className="l">預估記憶體</div></div>
            </div>
          </div>
          <div className="note" style={{ marginTop: 14 }}>建議使用<b style={{ color: "var(--text-dim)" }}>漸進模式</b>，隨平移串流載入節點。</div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn" onClick={onConfirm}>漸進開啟</button>
          <button className="btn primary" onClick={onConfirm}>仍要開啟</button>
        </div>
      </div>
    </div>
  );
}

/* ---- ⌘K command palette ---- */
function NodeCmd({ item, i, sel, setSel, choose }) {
  const cat = CATEGORIES[item.node.cat];
  return (
    <div className={"cmdk-item" + (sel === i ? " on" : "")} onMouseEnter={() => setSel(i)} onClick={() => choose(item)}>
      <span className="ci"><span style={{ width: 9, height: 9, borderRadius: 2, background: cat.color, display: "inline-block" }} /></span>
      <span className="cl">{item.node.title}</span>
      <span className="cnodes">{cat.label}</span>
    </div>
  );
}

function CommandPalette({ onClose, onJump, onCmd }) {
  const [q, setQ] = React.useState("");
  const [sel, setSel] = React.useState(0);
  const inputRef = React.useRef(null);
  React.useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);

  const cmds = [
    { id: "config", label: "前往 Config／爬取面板", icon: "settings" },
    { id: "crawlMat", label: "重爬專案母材質", icon: "refresh" },
    { id: "t3dIn", label: "從剪貼簿匯入選取（T3D）", icon: "upload" },
    { id: "t3dOut", label: "匯出選取到剪貼簿（T3D）", icon: "download" },
    { id: "snapshot", label: "匯出離線 HTML 快照", icon: "layers" },
  ];
  const nodes = NODES.filter(n => n.title.toLowerCase().includes(q.toLowerCase()));
  const acts = cmds.filter(c => c.label.toLowerCase().includes(q.toLowerCase()));
  const flat = [...acts.map(a => ({ t: "a", ...a })), ...nodes.map(n => ({ t: "n", node: n }))];

  const choose = (item) => {
    if (!item) return;
    if (item.t === "a") { onCmd(item.id); onClose(); }
    else { onJump(item.node.id); onClose(); }
  };
  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => Math.min(flat.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); choose(flat[sel]); }
    else if (e.key === "Escape") onClose();
  };

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="modal cmdk" onMouseDown={e => e.stopPropagation()}>
        <div className="cmdk-input">
          <Icon name="search" size={18} style={{ color: "var(--text-mute)" }} />
          <input ref={inputRef} value={q} onChange={e => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey}
            placeholder="跳到節點，或執行指令…" />
          <kbd style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-mute)" }}>ESC</kbd>
        </div>
        <div className="cmdk-list">
          {acts.length > 0 && <div className="cmdk-group">指令 Commands</div>}
          {flat.map((item, i) => item.t === "a" ? (
            <div key={item.id} className={"cmdk-item" + (sel === i ? " on" : "")} onMouseEnter={() => setSel(i)} onClick={() => choose(item)}>
              <span className="ci"><Icon name={item.icon} size={15} /></span>
              <span className="cl">{item.label}</span>
              <span className="ck">⏎</span>
            </div>
          ) : (
            (i === acts.length) ? [
              <div key="gh" className="cmdk-group">節點 Nodes · {nodes.length}</div>,
              <NodeCmd key={item.node.id} item={item} i={i} sel={sel} setSel={setSel} choose={choose} />
            ] : <NodeCmd key={item.node.id} item={item} i={i} sel={sel} setSel={setSel} choose={choose} />
          ))}
          {flat.length === 0 && <div className="empty">找不到符合「{q}」的項目。</div>}
        </div>
      </div>
    </div>
  );
}

/* ---- app-wide completion toast ---- */
function Toast({ toast, onClose, onView }) {
  if (!toast) return null;
  return (
    <div className="toast-wrap">
      <div className={"toast " + (toast.ok ? "ok" : "err")}>
        <span className="ti"><Icon name={toast.ok ? "check" : "warn"} size={13} /></span>
        <div style={{ flex: 1 }}>
          <div className="tt">{toast.title}</div>
          <div className="td">{toast.detail}</div>
          {toast.action && <span className="tact" onClick={onView}>{toast.action} →</span>}
        </div>
        <button className="tx" onClick={onClose}><Icon name="x" size={14} /></button>
      </div>
    </div>
  );
}

Object.assign(window, { BigGraphConfirm, CommandPalette, Toast });

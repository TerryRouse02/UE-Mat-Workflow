/* ===================== Files panel + Inspector ===================== */
function relTime(iso) {
  if (!iso) return "never";
  const d = new Date(iso), now = new Date("2026-06-04T10:30:00");
  const h = Math.round((now - d) / 36e5);
  if (h < 1) return "剛剛";
  if (h < 24) return h + " 小時前";
  const days = Math.round(h / 24);
  return days + " 天前";
}
function fmtTime(iso) { return iso ? iso.replace("T", " ").slice(0, 16) : "—"; }

function FileRow({ f, sel, onPick, onBig }) {
  return (
    <div className={"frow" + (sel ? " sel" : "") + (f.ro ? " ro" : "")}
      onClick={() => f.big ? onBig(f) : onPick(f.id)}>
      <span className="tico"><Icon name={f.type === "function" ? "func" : "material"} size={15} /></span>
      <span className="nm">{f.name}</span>
      <span className="meta">
        {f.big && <span className="bigmark" title="大型圖">300+</span>}
        {f.usedBy != null && <span className="usedby">×{f.usedBy}</span>}
        <span className="nc">{f.nodes}</span>
        <span className={"sdot " + f.status} title={f.status} />
      </span>
    </div>
  );
}

function Group({ title, count, children, defaultOpen = true }) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <div className="grp">
      <div className={"grp-head" + (open ? "" : " collapsed")} onClick={() => setOpen(o => !o)}>
        <Icon name="caret" size={13} className="caret" />
        <span className="gt">{title}</span>
        <span className="gc">{count}</span>
      </div>
      {open && children}
    </div>
  );
}

function FilesPanel({ selFile, onPick, onBig, projMatCrawled, onGotoConfig }) {
  const [q, setQ] = React.useState("");
  const match = (n) => n.toLowerCase().includes(q.toLowerCase());
  const totalAgent = FILES.agent.reduce((a, g) => a + g.items.length, 0);
  const crawledCount = FILES.crawled.reduce((a, g) => a + g.items.length, 0);
  return (
    <div className="files">
      <div className="files-search">
        <Icon name="search" size={14} />
        <input placeholder="篩選材質…" value={q} onChange={e => setQ(e.target.value)} />
      </div>

      <div className="sec-label">代理產出 · Agent-authored<span className="badge">{totalAgent}</span></div>
      {FILES.agent.map(g => (
        <Group key={g.proj} title={g.proj} count={g.items.length}>
          {g.items.filter(i => match(i.name)).map(f => <FileRow key={f.id} f={f} sel={selFile === f.id} onPick={onPick} onBig={onBig} />)}
        </Group>
      ))}

      <div className="sec-crawled" style={{ marginTop: 6, paddingTop: 4 }}>
        <div className="sec-label" style={{ color: "var(--accent)" }}>
          <Icon name="eye" size={13} /> 專案母材質（爬取）
          <span className="badge" style={{ borderColor: "var(--accent-dim)", color: "var(--accent)" }}>爬取 · 唯讀</span>
        </div>
        {projMatCrawled
          ? FILES.crawled.map(g => (
              <Group key={g.proj} title={g.proj} count={g.items.length}>
                {g.items.filter(i => match(i.name)).map(f => <FileRow key={f.id} f={f} sel={selFile === f.id} onPick={onPick} onBig={onBig} />)}
              </Group>
            ))
          : (
            <div className="empty-crawl">
              <div className="eci"><Icon name="eye" size={17} /></div>
              <div className="ect">尚未爬取專案母材質</div>
              <div className="ecd">這個區段是「重爬專案母材質」的輸出。執行一次爬取後，你 /Game 專案裡的母材質就會以唯讀鏡像出現在這裡。</div>
              <button className="btn sm primary" style={{ justifyContent: "center" }} onClick={onGotoConfig}><Icon name="refresh" size={13} /> 前往爬取</button>
            </div>
          )}
      </div>

      <div className="sec-label" style={{ marginTop: 8 }}>Material Functions<span className="badge">{FILES.functions.length}</span></div>
      {FILES.functions.filter(i => match(i.name)).map(f => <FileRow key={f.id} f={f} sel={selFile === f.id} onPick={onPick} onBig={onBig} />)}
    </div>
  );
}

/* ---------------- Left sidebar with tabs ---------------- */
function LeftSidebar(props) {
  const { tab, setTab, crawl, configCue } = props;
  return (
    <div className="panel left">
      <div className="lstabs">
        <div className={"lstab" + (tab === "files" ? " on" : "")} onClick={() => setTab("files")}><Icon name="material" size={14} /> Files</div>
        <div className={"lstab" + (tab === "nodes" ? " on" : "")} onClick={() => setTab("nodes")}><Icon name="hash" size={14} /> Nodes</div>
        <div className={"lstab" + (tab === "config" ? " on" : "")} onClick={() => setTab("config")}>
          <Icon name="settings" size={14} /> Config
          {configCue && <span className={"tdot " + configCue} />}
        </div>
      </div>
      {tab === "files" && <FilesPanel selFile={props.selFile} onPick={props.onPick} onBig={props.onBig} projMatCrawled={props.projMatCrawled} onGotoConfig={() => setTab("config")} />}
      {tab === "nodes" && <NodesPanel />}
      {tab === "config" && <ConfigPanel {...props.config} />}
    </div>
  );
}

/* ---------------- Inspector ---------------- */
function PinList({ pins, label }) {
  if (!pins || !pins.length) return null;
  return (
    <div className="isec">
      <div className="lbl">{label}</div>
      <div className="pinlist">
        {pins.map(p => (
          <div className="pinrow" key={p.id}>
            <span className="pc" style={{ background: PIN_TYPES[p.type].color }} />
            <span className="pn">{p.label || "—"}</span>
            <span className="pt">{PIN_TYPES[p.type].label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function NodeInspector({ node, onRecrawl }) {
  const cat = CATEGORIES[node.cat];
  const meta = node.meta || {};
  return (
    <div className="insp">
      <div className="isec">
        <div className="node-title">
          <span className="swatch" style={{ background: cat.color }} />
          <div>
            <div className="nt">{node.title}</div>
            <div className="ntsub">{node.sub || cat.label}</div>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <div className="kv"><span className="k">類別</span><span className="v" style={{ color: cat.color }}>{cat.label}</span></div>
          <div className="kv"><span className="k">節點 ID</span><span className="v">{node.id}</span></div>
          {node.status && <div className="kv"><span className="k">狀態</span><span className="v" style={{ color: node.status === "error" ? "var(--error)" : "var(--warn)" }}>{node.status === "error" ? "錯誤" : "警告"}</span></div>}
        </div>
      </div>

      <PinList pins={node.ins} label="輸入 pin" />
      <PinList pins={node.outs} label="輸出 pin" />

      <div className="isec">
        <div className="lbl">參數 Parameters</div>
        {(node.params || []).map((p, i) => (
          <div key={i} style={{ marginBottom: p.code ? 9 : 0 }}>
            <div className="kv"><span className="k">{p.k}</span>{!p.code && <span className="v">{p.v}</span>}</div>
            {p.code && <div className="codeblock">{p.code}</div>}
          </div>
        ))}
      </div>

      {/* ---- extra feature: per-node crawl metadata ---- */}
      <div className="isec">
        <div className="lbl" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name="clock" size={12} /> 爬取 metadata
          <span className={"fresh fresh-" + (meta.freshness || "missing")} style={{ marginLeft: "auto" }}>
            {meta.freshness === "fresh" ? "● 新鮮" : meta.freshness === "stale" ? "▲ 過期" : "✕ 遺失"}
          </span>
        </div>
        <div className="metagrid">
          <span className="mk">來源資料集</span><span className="mv">{meta.dataset || "—"}</span>
          <span className="mk">上次爬取</span><span className="mv">{fmtTime(meta.crawledAt)}</span>
          <span className="mk">&nbsp;</span><span className="mv" style={{ color: "var(--text-mute)" }}>{relTime(meta.crawledAt)}</span>
          <span className="mk">指令成本</span><span className="mv">{meta.cost || 0} instr.</span>
        </div>
        {meta.freshness !== "fresh" && (
          <button className="btn sm" style={{ marginTop: 10, width: "100%", justifyContent: "center" }} onClick={onRecrawl}>
            <Icon name="refresh" size={13} /> 重爬來源
          </button>
        )}
      </div>

      <div className="isec" style={{ display: "flex", gap: 8 }}>
        <button className="btn sm" style={{ flex: 1, justifyContent: "center" }}><Icon name="clip" size={13} /> 複製為 T3D</button>
        <button className="btn sm" style={{ flex: 1, justifyContent: "center" }}><Icon name="hash" size={13} /> 查找使用</button>
      </div>
    </div>
  );
}

function HealthInspector({ onIssue }) {
  const errs = ISSUES.filter(i => i.sev === "error").length;
  const warns = ISSUES.filter(i => i.sev === "warn").length;
  return (
    <div className="insp">
      <div className="health-badge warn">
        <div className="ring" style={{ background: "rgba(224,166,78,.16)", color: "var(--warn)" }}>!</div>
        <div>
          <div className="ht">需要注意</div>
          <div className="hd">{errs} 個錯誤 · {warns} 個警告 · 已掃描 41 個節點</div>
        </div>
      </div>
      <div className="isec" style={{ paddingBottom: 4 }}>
        <div className="lbl">問題—點擊在畫布上定位</div>
      </div>
      <div>
        {ISSUES.map(is => (
          <div key={is.id} className={"issue " + is.sev} onClick={() => onIssue(is.node)}>
            <span className="ibar" />
            <div style={{ flex: 1 }}>
              <div className="it">{is.title}</div>
              <div className="id">{is.detail}</div>
              <div className="in">{NMAP[is.node] ? NMAP[is.node].title : is.node}</div>
            </div>
            <span className={"sevpill " + is.sev}>{is.sev}</span>
          </div>
        ))}
      </div>
      <div className="isec">
        <div className="note">每次匯入或爬取後都會跑一次健康檢查。匯出快照前請先解決錯誤。</div>
      </div>
    </div>
  );
}

function Inspector({ node, mode, setMode, onIssue, onRecrawl }) {
  return (
    <div className="panel right">
      <div className="panel-head">
        <span className="h">檢視器 Inspector</span>
        <span className="grow" />
        {node && <button className="iconbtn" title="對準節點"><Icon name="frame" size={15} /></button>}
      </div>
      <div className="insp-mode">
        <div className={"tab" + (mode === "node" ? " on" : "")} onClick={() => node && setMode("node")} style={{ opacity: node ? 1 : .5 }}>節點詳情</div>
        <div className={"tab" + (mode === "health" ? " on" : "")} onClick={() => setMode("health")}>圖健康度</div>
      </div>
      {mode === "node" && node
        ? <NodeInspector key={node.id} node={node} onRecrawl={onRecrawl} />
        : <HealthInspector onIssue={onIssue} />}
    </div>
  );
}

Object.assign(window, { FilesPanel, LeftSidebar, Inspector, relTime, fmtTime });

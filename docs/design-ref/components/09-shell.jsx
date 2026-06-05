/* ===================== App shell, chrome, meta-bar, mount ===================== */
const { useState, useEffect, useCallback, useRef } = React;

function Seg({ label, value, set, options }) {
  return (
    <>
      <span className="mb-label">{label}</span>
      <div className="seg">
        {options.map(([k, l]) => (
          <button key={k} className={value === k ? "on" : ""} onClick={() => set(k)}>{l}</button>
        ))}
      </div>
    </>
  );
}

function MetaBar({ s }) {
  return (
    <div className="metabar">
      <span className="mb-brand">Prototype · <b>UE Material Workflow</b></span>
      <Seg label="連線" value={s.conn} set={s.setConn} options={[["live", "Live"], ["reconnecting", "連線中"], ["snapshot", "快照"]]} />
      <Seg label="環境" value={s.envReady ? "1" : "0"} set={(v) => s.setEnvReady(v === "1")} options={[["1", "就緒"], ["0", "未就緒"]]} />
      <Seg label="引擎" value={s.engineMismatch ? "0" : "1"} set={(v) => s.setEngineMismatch(v === "0")} options={[["1", "5.7"], ["0", "5.4 不符"]]} />
      <Seg label="載入" value={s.loadError ? "0" : "1"} set={(v) => s.setLoadError(v === "0")} options={[["1", "正常"], ["0", "錯誤"]]} />
      <Seg label="下次爬取" value={s.outcome} set={s.setOutcome} options={[["ok", "成功"], ["fail", "失敗"]]} />
    </div>
  );
}

function Chrome({ conn, onPalette, onImport, onExport, onSnapshot, onSettings }) {
  const connInfo = conn === "snapshot" ? ["offline", "離線快照"] : conn === "reconnecting" ? ["recon", "重新連線中…"] : ["live", "watching · 已同步"];
  const [moreOpen, setMoreOpen] = React.useState(false);
  React.useEffect(() => {
    if (!moreOpen) return;
    const h = () => setMoreOpen(false);
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [moreOpen]);
  return (
    <div className="chrome">
      <div className="logo">
        <span className="mark">M</span>
        <span className="t">UE·MAT workflow</span>
        <span className="ver">UE 5.7</span>
      </div>
      <span className="bcrumb">Cliffside_Biome <span className="sep">›</span> <b>M_Rock_Cliff</b></span>
      <span className="spacer" />
      <button className="searchbtn" onClick={onPalette}>
        <Icon name="search" size={14} /> 搜尋節點與指令 <kbd>⌘K</kbd>
      </button>
      <div className={"conn " + (connInfo[0] === "live" ? "live" : "offline")}>
        <span className="dot" /> {connInfo[1]}
      </div>
      {conn === "live" && (
        <>
          <button className="btn" onClick={onImport}><Icon name="clip" size={14} /> 導入</button>
          <button className="btn primary" onClick={onExport}><Icon name="upload" size={14} /> 導出到 UE</button>
        </>
      )}
      <button className="iconbtn" title="設定 / 爬取" onClick={onSettings} style={{ width: 32, height: 32 }}><Icon name="settings" size={16} /></button>
      <div className="more-wrap" onClick={(e) => e.stopPropagation()}>
        <button className="iconbtn" title="更多" onClick={() => setMoreOpen(o => !o)} style={{ width: 32, height: 32 }}><Icon name="more" size={16} /></button>
        {moreOpen && (
          <div className="menu">
            <div className="menu-label">分享 / 離線</div>
            <button className="menu-item" onClick={() => { setMoreOpen(false); onSnapshot(); }}>
              <Icon name="download" size={14} /> 匯出離線 HTML 快照
              <span className="mi-hint">唯讀分享</span>
            </button>
            <div className="menu-div" />
            <button className="menu-item" onClick={() => { setMoreOpen(false); onPalette(); }}>
              <Icon name="search" size={14} /> 鍵盤快捷鍵
              <span className="mi-hint">⌘K</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Banner({ conn, engineMismatch, onDismiss, dismissed }) {
  if (engineMismatch && !dismissed)
    return (
      <div className="banner warn">
        <Icon name="warn" size={15} className="ico" />
        <span>此圖以 <b>UE 5.7</b> 產生，但 bridge 回報 <b>UE 5.4</b> — 部分節點型別可能顯示為 <i>Unknown</i>，pin 顏色為近似值。</span>
        <button className="btn sm" style={{ marginLeft: "auto" }}>切換引擎…</button>
        <button className="x" onClick={onDismiss}><Icon name="x" size={14} /></button>
      </div>
    );
  if (conn === "snapshot")
    return (
      <div className="banner info">
        <Icon name="layers" size={15} />
        <span>正在檢視<b>唯讀離線快照</b>（匯出於 2026-06-04 09:42）。爬取與剪貼簿功能已停用。</span>
      </div>
    );
  if (conn === "reconnecting")
    return (
      <div className="banner info">
        <Icon name="refresh" size={15} className="spin" />
        <span>正在連線本機 viewer server… <span style={{ color: "var(--text-mute)" }}>127.0.0.1:8788</span></span>
      </div>
    );
  return null;
}

function App() {
  const [tab, setTab] = useState("files");
  const [conn, setConn] = useState("live");
  const [envReady, setEnvReady] = useState(true);
  const [engineMismatch, setEngineMismatch] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [outcome, setOutcome] = useState("ok");

  const [selId, setSelId] = useState(null);
  const [mode, setMode] = useState("health");
  const [selFile, setSelFile] = useState("output");
  const [flashId, setFlashId] = useState(null);

  const [crawl, setCrawl] = useState({ phase: "idle", kind: null, lines: [] });
  const [elapsed, setElapsed] = useState(0);
  const [freshness, setFreshness] = useState({ ...INITIAL_FRESHNESS });
  const [justRan, setJustRan] = useState(null);
  const [projMatCrawled, setProjMatCrawled] = useState(false);
  const [mfRoot, setMfRoot] = useState("/Game");

  const [bigFile, setBigFile] = useState(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const timers = useRef([]);
  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; if (tickRef.current) clearInterval(tickRef.current); };
  const tickRef = useRef(null);
  const outcomeRef = useRef(outcome);
  useEffect(() => { outcomeRef.current = outcome; }, [outcome]);

  useEffect(() => { setBannerDismissed(false); }, [engineMismatch]);

  // ---- crawl engine ----
  const startCrawl = useCallback((kind) => {
    clearTimers();
    setTab("config");
    setJustRan(null);
    setCrawl({ phase: "running", kind, lines: [] });
    setElapsed(0);
    const t0 = Date.now();
    tickRef.current = setInterval(() => setElapsed(Date.now() - t0), 100);
    const seq = crawlLog(kind);
    let i = 0;
    const step = () => {
      setCrawl(c => ({ ...c, lines: seq.slice(0, i + 1) }));
      i++;
      if (i < seq.length) timers.current.push(setTimeout(step, 360 + Math.random() * 380));
      else timers.current.push(setTimeout(finish, 600));
    };
    const finish = () => {
      if (tickRef.current) clearInterval(tickRef.current);
      const fail = outcomeRef.current === "fail";
      if (fail) { setCrawl(c => ({ ...c, phase: "error" })); fireToast(kind, false); return; }
      setCrawl(c => ({ ...c, phase: "success" }));
      setFreshness(f => ({ ...f, [kind]: "2026-06-04T10:30:00" }));
      setJustRan(kind);
      if (kind === "projMat") setProjMatCrawled(true);
      fireToast(kind, true);
    };
    timers.current.push(setTimeout(step, 500));
  }, [tab]); // eslint-disable-line

  const fireToast = (kind, ok) => {
    const k = CRAWL_KINDS[kind];
    setToast(ok
      ? { ok: true, title: `${k.label}完成`, detail: k.refresh, action: kind === "projMat" ? "查看 Files" : (kind === "projMF" ? "查看 Nodes" : null), go: kind === "projMat" ? "files" : (kind === "projMF" ? "nodes" : null) }
      : { ok: false, title: `${k.label}失敗（exit ${CRAWL_ERROR.exit}）`, detail: "點擊查看診斷與修復建議", action: "查看 Config", go: "config" });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 7000);
  };
  const toastTimer = useRef(null);

  const stopCrawl = () => { clearTimers(); setCrawl({ phase: "idle", kind: null, lines: [] }); };
  const resetCrawl = (retryKind) => { clearTimers(); if (retryKind) startCrawl(retryKind); else setCrawl({ phase: "idle", kind: null, lines: [] }); };

  useEffect(() => () => clearTimers(), []);

  const selectNode = useCallback((id) => { setSelId(id); setMode(id ? "node" : "health"); }, []);
  const flash = useCallback((id) => { setSelId(id); setMode("node"); setFlashId(id); setTimeout(() => setFlashId(null), 1200); }, []);

  const onCmd = (id) => {
    if (id === "config") setTab("config");
    else if (id === "crawlMat") { if (conn === "live" && envReady) startCrawl("projMat"); else setTab("config"); }
    else if (id === "snapshot") setConn("snapshot");
    else if (id === "t3dIn" || id === "t3dOut") setToast({ ok: true, title: id === "t3dIn" ? "已從剪貼簿匯入" : "已複製 T3D 到剪貼簿", detail: "3 個節點 · MakeMaterialAttributes 連線已保留", action: null });
  };

  useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen(o => !o); }
      if (e.key === "Escape") { setBigFile(null); setPaletteOpen(false); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const node = selId ? NMAP[selId] : null;
  const configCue = crawl.phase === "running" ? "run" : crawl.phase === "error" ? "err" : null;
  const leftW = (tab === "config" && crawl.phase !== "idle") ? 520 : (tab === "config" ? 332 : 290);

  const metaState = { conn, setConn, envReady, setEnvReady, engineMismatch, setEngineMismatch, loadError, setLoadError, outcome, setOutcome };

  return (
    <div className="app">
      <MetaBar s={metaState} />
      <Chrome conn={conn}
        onPalette={() => setPaletteOpen(true)}
        onImport={() => onCmd("t3dIn")} onExport={() => onCmd("t3dOut")}
        onSnapshot={() => setConn("snapshot")} onSettings={() => setTab("config")} />
      <Banner conn={conn} engineMismatch={engineMismatch} dismissed={bannerDismissed} onDismiss={() => setBannerDismissed(true)} />

      <div className="body" style={{ "--left": leftW + "px" }}>
        <LeftSidebar
          tab={tab} setTab={setTab}
          crawl={crawl} configCue={configCue}
          selFile={selFile} onPick={(id) => setSelFile(id)} onBig={(f) => setBigFile(f)}
          projMatCrawled={projMatCrawled}
          config={{
            conn, envReady, crawl, elapsed, freshness, justRan, mfRoot, setMfRoot,
            onStart: startCrawl, onStop: stopCrawl, onReset: resetCrawl,
          }}
        />
        <Canvas selId={selId} onSelect={selectNode} flashId={flashId} fileError={loadError} />
        <Inspector node={node} mode={mode} setMode={setMode} onIssue={flash} onRecrawl={() => { setTab("config"); }} />
      </div>

      {bigFile && <BigGraphConfirm file={bigFile} onCancel={() => setBigFile(null)} onConfirm={() => { setSelFile(bigFile.id); setBigFile(null); }} />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onJump={flash} onCmd={onCmd} />}
      <Toast toast={toast} onClose={() => setToast(null)} onView={() => { if (toast && toast.go) setTab(toast.go); setToast(null); }} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);

/* ===================== Config tab — crawl operations ===================== */

function FreshBadge({ ts, justRan }) {
  if (justRan) return <span className="freshbadge now"><Icon name="check" size={10} /> 剛剛更新</span>;
  if (!ts) return <span className="freshbadge never">尚未爬取 · Never</span>;
  return <span className="freshbadge has"><Icon name="clock" size={10} /> {relTime(ts)} · {fmtTime(ts).slice(5)}</span>;
}

function PathsSection({ mfRoot, setMfRoot }) {
  return (
    <div className="cfg-sec">
      <div className="sech"><span className="secn">1</span><span className="sect">專案路徑</span><span className="secd">很少變動</span></div>
      <div className="field">
        <label>.uproject 路徑</label>
        <div className="inp"><Icon name="folder" size={13} style={{ color: "var(--text-mute)" }} /><input defaultValue={PROJECT_PATHS.uproject} spellCheck="false" /></div>
      </div>
      <div className="field">
        <label>UE 引擎根目錄 <span style={{ color: "var(--text-mute)" }}>Engine root</span></label>
        <div className="inp"><Icon name="chip" size={13} style={{ color: "var(--text-mute)" }} /><input defaultValue={PROJECT_PATHS.engineRoot} spellCheck="false" /></div>
      </div>
      <button className="btn sm" style={{ marginTop: 2 }}><Icon name="check" size={13} /> 儲存設定</button>
    </div>
  );
}

function EnvSection({ envReady }) {
  const checks = envChecks(envReady);
  const allOk = checks.every(c => c.ok);
  return (
    <div className="cfg-sec">
      <div className="sech"><span className="secn">2</span><span className="sect">環境檢查</span><span className="secd">爬取的前置條件</span></div>
      <div className={"envbanner " + (allOk ? "ready" : "notready")}>
        <Icon name={allOk ? "check" : "warn"} size={15} />
        {allOk
          ? <span>環境就緒，可以爬取</span>
          : <span>尚未就緒<span className="sub"> — 完成下列項目即可爬取</span></span>}
      </div>
      <div className="envlist2">
        {checks.map(c => (
          <div key={c.id} className={"envrow2 " + (c.ok ? "ok" : "bad")}>
            <span className="ei"><Icon name={c.ok ? "check" : "x"} size={11} /></span>
            <span className="el2">{c.label}<span className="en">{c.en}</span></span>
            <span className="ed2">{c.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CrawlButton({ k, kind, freshness, justRan, disabled, onStart, adv }) {
  return (
    <button className={"crawlbtn" + (adv ? " adv" : "")} disabled={disabled} onClick={() => onStart(k)}>
      <div className="cbh">
        <span className="cbrun"><Icon name="refresh" size={adv ? 12 : 14} /></span>
        <div style={{ flex: 1 }}>
          <div className="cbtitle">{kind.label}</div>
          <div className="cben">{kind.en}</div>
        </div>
      </div>
      {!adv && <div className="cbdesc">{kind.desc}</div>}
      <div className="cbrefresh"><Icon name="branch" size={11} /> 刷新：{kind.refresh}</div>
      <div className="cbfoot"><FreshBadge ts={freshness[k]} justRan={justRan === k} /></div>
    </button>
  );
}

function CrawlOpsSection({ envReady, freshness, justRan, onStart, mfRoot, setMfRoot }) {
  const [advOpen, setAdvOpen] = React.useState(false);
  const dis = !envReady;
  return (
    <div className="cfg-sec">
      <div className="sech"><span className="secn">3</span><span className="sect">爬取操作</span><span className="secd">{dis ? "環境就緒後啟用" : "一次僅能執行一項"}</span></div>

      <div className="field">
        <label>MF content root <span style={{ color: "var(--text-mute)" }}>— 限定專案爬取範圍</span></label>
        <div className="inp"><span className="pfx">root</span><input value={mfRoot} onChange={e => setMfRoot(e.target.value)} spellCheck="false" /></div>
      </div>

      <div className="tier-label">主要 · 專案（常用）<span className="ln" /></div>
      <CrawlButton k="projMF" kind={CRAWL_KINDS.projMF} freshness={freshness} justRan={justRan} disabled={dis} onStart={onStart} />
      <CrawlButton k="projMat" kind={CRAWL_KINDS.projMat} freshness={freshness} justRan={justRan} disabled={dis} onStart={onStart} />

      <div className={"advrow" + (advOpen ? " open" : "")} onClick={() => setAdvOpen(o => !o)}>
        <Icon name="caret" size={13} className="caret" />
        進階／維護（官方原生，一般用不到）
        <span className="hint">{advOpen ? "收合" : "展開"}</span>
      </div>
      {advOpen && (
        <div style={{ paddingTop: 4 }}>
          <CrawlButton k="nodeExport" kind={CRAWL_KINDS.nodeExport} freshness={freshness} justRan={justRan} disabled={dis} onStart={onStart} adv />
          <CrawlButton k="engineMF" kind={CRAWL_KINDS.engineMF} freshness={freshness} justRan={justRan} disabled={dis} onStart={onStart} adv />
        </div>
      )}
      {dis && <div className="note" style={{ marginTop: 4 }}>↑ 通過全部環境檢查後，這些按鈕才會啟用。</div>}
    </div>
  );
}

function RunLog({ lines }) {
  const ref = React.useRef(null);
  React.useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines]);
  return (
    <div className="runlog" ref={ref}>
      {lines.map((l, i) => (
        <div key={i} className={"ll " + l.lvl}><span className="lt">+{l.t.toFixed(1)}s</span><span className="lm">{l.msg}</span></div>
      ))}
    </div>
  );
}

function RunPanel({ crawl, elapsed, onStop, onReset }) {
  const kind = CRAWL_KINDS[crawl.kind];
  const running = crawl.phase === "running";
  const ok = crawl.phase === "success";
  const done = CRAWL_DONE[crawl.kind] || {};
  return (
    <div className="runwrap">
      <div className="run-head">
        <span className={"run-ico " + (running ? "" : ok ? "ok" : "err")}>
          {running ? <Icon name="refresh" size={16} className="spin" /> : ok ? <Icon name="check" size={16} /> : <Icon name="x" size={16} />}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="run-title">{kind.label}</div>
          <div className="run-sub">{running ? "執行中…（編輯器啟動需數分鐘）" : ok ? "完成，已即時刷新" : CRAWL_ERROR.title}</div>
        </div>
        <div className="run-elapsed">{(elapsed / 1000).toFixed(1)}s<br /><span style={{ color: "var(--text-mute)", fontSize: 9 }}>elapsed</span></div>
      </div>

      <div className="progress"><div className="bar" style={{ width: (running ? Math.min(96, crawl.lines.length / (crawlLog(crawl.kind).length) * 100) : 100) + "%", background: crawl.phase === "error" ? "var(--error)" : ok ? "var(--ok)" : undefined }} /></div>

      <RunLog lines={crawl.phase === "error" ? CRAWL_ERROR.logTail : crawl.lines} />

      {running && (
        <div className="run-actions">
          <button className="btn" style={{ flex: 1, justifyContent: "center" }} onClick={onStop}><Icon name="x" size={13} /> 停止爬取</button>
        </div>
      )}

      {ok && (
        <div className="run-result ok">
          <div className="rt"><Icon name="check" size={15} /> {kind.label}完成，已即時刷新</div>
          <div className="rstats">
            <div><div className="v" style={{ color: "var(--ok)" }}>{done.updated}</div><div className="l">已更新</div></div>
            <div><div className="v">{done.errors}</div><div className="l">錯誤</div></div>
            <div><div className="v" style={{ color: done.warnings ? "var(--warn)" : undefined }}>{done.warnings}</div><div className="l">警告</div></div>
          </div>
          {crawl.kind === "projMat" && <div className="fix-text" style={{ color: "var(--text-dim)" }}>→ 已填入 Files 分頁的「專案母材質（爬取）」。</div>}
        </div>
      )}

      {crawl.phase === "error" && (
        <div className="run-result err">
          <div className="rt"><Icon name="warn" size={15} /> {kind.label}失敗（exit {CRAWL_ERROR.exit}）</div>
          <div className="cause">{CRAWL_ERROR.cause}</div>
          <div>
            <span className={"fixpill " + (CRAWL_ERROR.fixSelf ? "self" : "maint")}>
              <Icon name={CRAWL_ERROR.fixSelf ? "check" : "warn"} size={11} />
              {CRAWL_ERROR.fixSelf ? "你可以自行修復" : "需要工具維護者協助"}
            </span>
          </div>
          <div className="fix-text">{CRAWL_ERROR.fixText}</div>
          <details className="logdetails">
            <summary><Icon name="caret" size={12} className="caret" /> 完整 log</summary>
            <RunLog lines={CRAWL_ERROR.logTail} />
          </details>
        </div>
      )}

      {!running && (
        <div className="run-actions">
          {crawl.phase === "error" && <button className="btn primary" style={{ flex: 1, justifyContent: "center" }} onClick={() => onReset(crawl.kind)}><Icon name="refresh" size={13} /> 重試</button>}
          <button className="btn" style={{ flex: 1, justifyContent: "center" }} onClick={() => onReset(null)}>返回爬取面板</button>
        </div>
      )}
    </div>
  );
}

function ConfigPanel({ conn, envReady, crawl, elapsed, freshness, justRan, mfRoot, setMfRoot, onStart, onStop, onReset }) {
  if (conn === "snapshot") {
    return (
      <div className="cfg">
        <div className="cfg-notice">
          <div className="ni"><Icon name="layers" size={20} /></div>
          <div className="nt">此匯出快照無法爬取</div>
          <div className="nd">爬取需要連到本機的 Unreal 專案。離線快照是唯讀的，環境檢查與爬取按鈕已隱藏。</div>
        </div>
        <div className="cfg-sec">
          <div className="field">
            <label>MF content root <span style={{ color: "var(--text-mute)" }}>— 保留供匯出使用</span></label>
            <div className="inp"><span className="pfx">root</span><input value={mfRoot} onChange={e => setMfRoot(e.target.value)} spellCheck="false" /></div>
          </div>
        </div>
      </div>
    );
  }
  if (conn === "reconnecting") {
    return (
      <div className="cfg">
        <div className="reconnect-spin">
          <Icon name="refresh" size={26} className="spin" style={{ color: "var(--accent)" }} />
          <div>正在連線本機 viewer server…<div className="note" style={{ marginTop: 6 }}>connecting to local viewer server · 127.0.0.1:8788</div></div>
        </div>
      </div>
    );
  }
  // live
  if (crawl.phase !== "idle") {
    return <div className="cfg"><RunPanel crawl={crawl} elapsed={elapsed} onStop={onStop} onReset={onReset} /></div>;
  }
  return (
    <div className="cfg">
      <PathsSection mfRoot={mfRoot} setMfRoot={setMfRoot} />
      <EnvSection envReady={envReady} />
      <CrawlOpsSection envReady={envReady} freshness={freshness} justRan={justRan} onStart={onStart} mfRoot={mfRoot} setMfRoot={setMfRoot} />
    </div>
  );
}

Object.assign(window, { ConfigPanel });

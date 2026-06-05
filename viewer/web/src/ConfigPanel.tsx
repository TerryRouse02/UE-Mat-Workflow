import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore } from './store';
import type { CrawlKind } from './crawlRequest';
import { diagnoseCrawl, crawlFoundNothing } from './crawlDiagnosis';

// Friendly labels for the env-probe checks (server keys -> what an artist reads),
// plus a short mono token shown beside each row.
const CHECKS: Record<string, { label: string; en: string }> = {
  platform: { label: 'Windows 平台', en: 'Win64' },
  config: { label: 'local.config.json', en: 'config' },
  engine: { label: 'UE 引擎已找到', en: 'UnrealEditor-Cmd.exe' },
  project: { label: '.uproject 存在', en: 'uproject' },
  plugin: { label: '外掛 DLL 已編譯', en: 'plugin.dll' },
  noShadow: { label: '無 shadow plugin 複本', en: 'shadow' },
};
const CHECK_ORDER = ['platform', 'config', 'engine', 'project', 'plugin', 'noShadow'];

const KIND_LABEL: Record<string, string> = {
  workmf: '專案 Material Function', projectmat: '專案母材質',
  export: '節點導出', enginemf: '引擎 Material Function',
};
const FRESH_KEY = (k: string) => `ue-crawl-fresh-${k}`;

function agoLabel(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分鐘前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小時前`;
  return `${Math.floor(h / 24)} 天前`;
}
function mmss(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
function logSeverity(line: string): string {
  if (/\berror\b|fail|exception|❌|✗/i.test(line)) return 'error';
  if (/\bwarn(ing)?\b|⚠/i.test(line)) return 'warn';
  if (/\b(done|success|completed|ok)\b|✓/i.test(line)) return 'ok';
  return 'info';
}

// The Config tab: set the crawl's project paths, see exactly what's still missing,
// and run the crawls — all button-driven, no JSON editing. Writes the same
// local.config.json the PowerShell scripts read, via POST /api/config.
export function ConfigPanel() {
  const { state, saveConfig, refreshEnv, startCrawl } = useStore();
  const { env, crawl, connection } = state;
  const live = connection === 'live';
  const ready = live && !!env?.ready;
  const running = crawl.status === 'running';

  const [projectPath, setProjectPath] = useState('');
  const [engineRoot, setEngineRoot] = useState('');
  // One MF content root, shared by the WorkMF crawl (scan scope) and the T3D export
  // (asset path for local MFs). Falls back to the legacy crawl key so an existing
  // setting carries over.
  const [mfRoot, setMfRoot] = useState(() => localStorage.getItem('ue-mf-root') || localStorage.getItem('ue-workmf-root') || '/Game');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Per-kind "last crawled" freshness (localStorage), + which kind just finished now.
  const [fresh, setFresh] = useState<Record<string, number>>(() => {
    const o: Record<string, number> = {};
    for (const k of Object.keys(KIND_LABEL)) { const v = localStorage.getItem(FRESH_KEY(k)); if (v) o[k] = +v; }
    return o;
  });
  const [justKind, setJustKind] = useState<string | null>(null);

  // Elapsed timer while a crawl streams.
  const [, tick] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    if (running) {
      if (startRef.current == null) startRef.current = Date.now();
      const id = setInterval(() => tick(n => n + 1), 1000);
      return () => clearInterval(id);
    }
    startRef.current = null;
  }, [running]);
  const elapsed = startRef.current ? Math.floor((Date.now() - startRef.current) / 1000) : 0;

  // Record freshness when a crawl succeeds; clear "just finished" when a new one starts.
  const prevStatus = useRef(crawl.status);
  useEffect(() => {
    if (prevStatus.current !== 'success' && crawl.status === 'success' && crawl.kind) {
      const now = Date.now();
      localStorage.setItem(FRESH_KEY(crawl.kind), String(now));
      setFresh(f => ({ ...f, [crawl.kind!]: now }));
      setJustKind(crawl.kind);
    }
    if (crawl.status === 'running') setJustKind(null);
    prevStatus.current = crawl.status;
  }, [crawl.status, crawl.kind]);

  // Seed the path fields from the probed config once it arrives; never clobber an
  // edit in progress (only fill an empty field).
  useEffect(() => { if (env?.projectPath) setProjectPath(p => p || env.projectPath!); }, [env?.projectPath]);
  useEffect(() => { if (env?.engineRoot) setEngineRoot(p => p || env.engineRoot!); }, [env?.engineRoot]);

  const onSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    const r = await saveConfig(projectPath.trim(), engineRoot.trim());
    setSaving(false);
    setSaveMsg(r.ok ? { ok: true, text: '已儲存，已重新檢查環境。' } : { ok: false, text: r.error || '儲存失敗' });
  };

  const doCrawl = (kind: CrawlKind) =>
    (kind === 'workmf' || kind === 'projectmat')
      ? startCrawl(kind, mfRoot.trim() || '/Game')
      : startCrawl(kind);

  function FreshBadge({ k }: { k: string }) {
    if (justKind === k) return <span className="freshbadge now">✓ 剛剛完成</span>;
    if (fresh[k]) return <span className="freshbadge has">上次 {agoLabel(fresh[k])}</span>;
    return <span className="freshbadge never">尚未爬取</span>;
  }

  // The one content root, two uses — always reachable (export works offline too).
  const mfRootField = (
    <div className="field">
      <label>MF content root — 限定專案爬取範圍，也用於導出時解析本地 MF 路徑</label>
      <div className="inp"><input value={mfRoot} spellCheck={false} placeholder="/Game"
        onChange={e => { setMfRoot(e.target.value); localStorage.setItem('ue-mf-root', e.target.value); }} /></div>
    </div>
  );

  // Offline (snapshot) / not-yet-connected: no server to crawl against.
  if (connection === 'snapshot' || !live) {
    return (
      <div className="cfg">
        {connection === 'snapshot' ? (
          <div className="cfg-notice">
            <div className="ni">⤓</div>
            <div className="nt">這是匯出快照</div>
            <div className="nd">快照沒有本機 server，無法設定專案或爬取。下方 MF 路徑仍可設定，供導出之用。</div>
          </div>
        ) : (
          <div className="reconnect-spin">
            <div className="spin" style={{ fontSize: 22 }}>↻</div>
            <div>正在連線本機 viewer server…<br />連上後即可設定與爬取。</div>
          </div>
        )}
        <div className="cfg-sec">{mfRootField}</div>
      </div>
    );
  }

  return (
    <div className="cfg">
      {/* 1 — project paths */}
      <div className="cfg-sec">
        <div className="sech"><span className="secn">1</span><span className="sect">專案路徑</span><span className="secd">靜態設定</span></div>
        <div className="field">
          <label>.uproject 路徑</label>
          <div className="inp"><input value={projectPath} spellCheck={false}
            placeholder="C:\Path\To\Project.uproject" onChange={e => setProjectPath(e.target.value)} /></div>
        </div>
        <div className="field">
          <label>UE 引擎根目錄</label>
          <div className="inp"><input value={engineRoot} spellCheck={false}
            placeholder="C:\Program Files\Epic Games\UE_5.7" onChange={e => setEngineRoot(e.target.value)} /></div>
        </div>
        <button className="btn sm" onClick={onSave} disabled={saving || (!projectPath.trim() && !engineRoot.trim())}>
          {saving ? '儲存中…' : '儲存設定'}
        </button>
        {saveMsg && <div className={`cfg-msg ${saveMsg.ok ? 'ok' : 'bad'}`}>{saveMsg.text}</div>}
      </div>

      {/* 2 — environment gate */}
      <div className="cfg-sec">
        <div className="sech"><span className="secn">2</span><span className="sect">環境檢查</span><span className="secd">爬取前置</span></div>
        <div className={`envbanner ${ready ? 'ready' : 'notready'}`}>
          {ready ? '✓ 環境就緒，可以爬取' : <span>尚未就緒<span className="sub"> — 完成下列項目即可爬取</span></span>}
        </div>
        <div className="envlist2">
          {env && CHECK_ORDER.map(k => {
            const c = env.checks[k];
            if (!c) return null;
            const meta = CHECKS[k] ?? { label: k, en: k };
            return (
              <div key={k} className={`envrow2 ${c.ok ? 'ok' : 'bad'}`}>
                <span className="ei">{c.ok ? '✓' : '✗'}</span>
                <span className="el2">{meta.label}<span className="en">{meta.en}</span></span>
                {c.detail && <span className="ed2">{c.detail}</span>}
              </div>
            );
          })}
        </div>
        <p className="note" style={{ marginTop: 10 }}>
          外掛已內附在 repo（<code>compiled/</code>），不需放進你的專案。若因引擎版本不符載入失敗，
          在終端機用 <code>-ForcePackage</code> 對你的引擎重新打包一次即可。
        </p>
        <button className="btn sm ghost" style={{ marginTop: 10 }} onClick={() => void refreshEnv()}>重新檢查</button>
      </div>

      {/* 3 — crawl operations (becomes a live-run takeover while running) */}
      <div className="cfg-sec" style={{ borderBottom: 'none', flex: running ? 1 : undefined, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div className="sech"><span className="secn">3</span><span className="sect">爬取操作</span><span className="secd">一次一項</span></div>

        {running ? (
          <RunView kind={crawl.kind} logs={crawl.logs} elapsed={elapsed} />
        ) : crawl.status === 'error' ? (
          <ErrorView kind={crawl.kind} logs={crawl.logs} exitCode={crawl.exitCode} />
        ) : (
          <>
            {mfRootField}
            {crawl.status === 'success' && (
              <div className="run-result ok" style={{ marginTop: 0, marginBottom: 12 }}>
                <div className="rt">✓ {KIND_LABEL[crawl.kind ?? ''] ?? crawl.kind} 完成，已即時刷新。</div>
                {crawl.kind === 'workmf' && crawlFoundNothing(crawl.logs) && (
                  <p className="cause">⚠ 索引到 0 個專案 MF —— 確認上方 MF content root 對到放 MF 的資料夾。</p>
                )}
              </div>
            )}

            <div className="tier-label">主要（專案）<span className="ln" /></div>
            <CrawlButton kind="workmf" title="重爬專案 Material Function" en="Re-crawl Project Material Functions"
              desc="掃描你 /Game 專案裡 Material Function 的 pin 簽章，刷新 Nodes 分頁並即時重新解析已開啟的圖。"
              disabled={!ready} onClick={() => doCrawl('workmf')} fresh={<FreshBadge k="workmf" />} />
            <CrawlButton kind="projectmat" title="重爬專案母材質" en="Re-crawl Project Materials"
              desc="把每個 /Game 母材質從 UE 匯出並導入成可開啟的圖，填入左側「專案母材質（爬取）」。"
              disabled={!ready} onClick={() => doCrawl('projectmat')} fresh={<FreshBadge k="projectmat" />} />

            <button className={`advrow ${advancedOpen ? 'open' : ''}`} onClick={() => setAdvancedOpen(o => !o)}>
              <span className="caret">▸</span> 進階／維護（官方原生，一般用不到）
              <span className="hint">{advancedOpen ? '收合' : '展開'}</span>
            </button>
            {advancedOpen && (
              <>
                <CrawlButton kind="export" adv title="重爬節點導出" en="Re-crawl Node Export"
                  desc="重建節點型別資料庫（官方原生）。" disabled={!ready} onClick={() => doCrawl('export')} fresh={<FreshBadge k="export" />} />
                <CrawlButton kind="enginemf" adv title="重爬引擎 Material Function" en="Re-crawl Engine Material Functions"
                  desc="重建 /Engine/ 的 MF 索引。" disabled={!ready} onClick={() => doCrawl('enginemf')} fresh={<FreshBadge k="enginemf" />} />
              </>
            )}
            {!ready && <p className="note" style={{ marginTop: 4 }}>完成上方環境檢查後，按鈕就會啟用。</p>}
          </>
        )}
      </div>
    </div>
  );
}

function CrawlButton({ title, en, desc, disabled, onClick, fresh, adv }: {
  kind: CrawlKind; title: string; en: string; desc: string; disabled: boolean; onClick: () => void; fresh: ReactNode; adv?: boolean;
}) {
  return (
    <button className={`crawlbtn ${adv ? 'adv' : ''}`} disabled={disabled} onClick={onClick}>
      <div className="cbh">
        <span className="cbrun">↻</span>
        <div>
          <div className="cbtitle">{title}</div>
          <div className="cben">{en}</div>
        </div>
      </div>
      <div className="cbdesc">{desc}</div>
      <div className="cbfoot">{fresh}</div>
    </button>
  );
}

function LogStream({ logs, height }: { logs: string[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [logs.length]);
  return (
    <div className="runlog" ref={ref} style={height ? { height, flex: 'none' } : undefined}>
      {logs.map((l, i) => (
        <div key={i} className={`ll ${logSeverity(l)}`}>
          <span className="lt">{String(i + 1).padStart(3, '0')}</span>
          <span className="lm">{l}</span>
        </div>
      ))}
      {logs.length === 0 && <div className="ll info"><span className="lt">···</span><span className="lm">等待編輯器輸出…</span></div>}
    </div>
  );
}

function RunView({ kind, logs, elapsed }: { kind: string | null; logs: string[]; elapsed: number }) {
  return (
    <div className="runwrap">
      <div className="run-head">
        <span className="run-ico"><span className="spin">↻</span></span>
        <div>
          <div className="run-title">{KIND_LABEL[kind ?? ''] ?? kind} 執行中…</div>
          <div className="run-sub">編輯器啟動需數分鐘</div>
        </div>
        <div className="run-elapsed">{mmss(elapsed)}</div>
      </div>
      <LogStream logs={logs} />
    </div>
  );
}

function ErrorView({ kind, logs, exitCode }: { kind: string | null; logs: string[]; exitCode: number | null }) {
  const d = diagnoseCrawl(logs);
  return (
    <div className="run-result err">
      <div className="rt">✗ {KIND_LABEL[kind ?? ''] ?? kind} 失敗{exitCode != null ? `（exit ${exitCode}）` : ''}</div>
      {d ? (
        <>
          <p className="cause"><b>可能原因：</b>{d.cause}</p>
          <p className="cause"><b>解決方法：</b>{d.fix}</p>
          <span className={`fixpill ${d.who === 'you' ? 'self' : 'maint'}`}>{d.who === 'you' ? '你可以自己處理' : '需要工具維護者'}</span>
        </>
      ) : (
        <p className="cause">無法自動判斷原因，請看下方 log；必要時附完整 log 回報維護者。</p>
      )}
      {logs.length > 0 && (
        <details className="logdetails">
          <summary><span className="caret">▸</span> 完整 log（最後 {Math.min(logs.length, 200)} 行）</summary>
          <LogStream logs={logs} height={160} />
        </details>
      )}
    </div>
  );
}

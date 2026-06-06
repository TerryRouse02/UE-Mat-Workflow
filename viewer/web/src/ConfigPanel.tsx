import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import type { CrawlKind } from './crawlRequest';
import { diagnoseCrawl } from './crawlDiagnosis';
import { Icon } from './Icon';
import './config.css';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Format an ISO timestamp as "MM-DD HH:MM" (compact, no year). */
function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mn = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mn}`;
  } catch {
    return '—';
  }
}

/** Return a human-readable relative time string ("3 分鐘前", "2 小時前", etc.). */
function relTime(iso: string): string {
  try {
    const delta = (Date.now() - new Date(iso).getTime()) / 1000;
    if (delta < 60) return '剛剛';
    if (delta < 3600) return `${Math.floor(delta / 60)} 分鐘前`;
    if (delta < 86400) return `${Math.floor(delta / 3600)} 小時前`;
    return `${Math.floor(delta / 86400)} 天前`;
  } catch {
    return '—';
  }
}

/** Heuristically classify a log line. */
function parseLogLine(line: string, i: number): { t: number; lvl: string; msg: string } {
  const lower = line.toLowerCase();
  let lvl = 'info';
  if (/error|fail|fatal|exception/i.test(lower)) lvl = 'error';
  else if (/warn/i.test(lower)) lvl = 'warn';
  else if (/loginit|logasset/i.test(lower)) lvl = 'dim';
  return { t: i * 0.1, lvl, msg: line };
}

// ─── CRAWL_KIND_META ────────────────────────────────────────────────────────

interface CrawlMeta { label: string; en: string; desc: string; refresh: string }

const CRAWL_KIND_META: Record<CrawlKind, CrawlMeta> = {
  workmf: {
    label: '爬取專案 MF',
    en: 'Crawl Project Material Functions',
    desc: '掃描指定 content root 下所有專案 MaterialFunction，建立簽名索引供 AI 呼叫。',
    refresh: '節點庫 · Project MF 分頁',
  },
  projectmat: {
    label: '爬取專案母材質',
    en: 'Crawl Project Parent Materials',
    desc: '蒐集「母材質 Content Route」下的母材質（可被子材質繼承），填入 Files 分頁的「工作」區。',
    refresh: 'Files 分頁 · 工作',
  },
  export: {
    label: '重爬節點導出',
    en: 'Re-crawl Node Export Metadata',
    desc: '重新擷取各節點的 UE 路徑 / GUID，刷新 agent-pack 節點導出元資料。僅在升版後需要。',
    refresh: 'agent-pack · 節點元資料',
  },
  enginemf: {
    label: '重爬引擎 MF',
    en: 'Re-crawl Engine Material Functions',
    desc: '掃描 /Engine/ 下所有官方 MaterialFunction，刷新引擎 MF 索引。僅在升版後需要。',
    refresh: '節點庫 · Engine MF 分頁',
  },
};

// English sub-labels for the env checks
const EN_LABELS: Record<string, string> = {
  platform: 'Windows platform',
  config: 'local.config.json',
  engine: 'UnrealEditor-Cmd.exe',
  project: '.uproject file',
  plugin: 'compiled plugin',
  noShadow: 'no shadow copy',
};

// Friendly zh-TW labels
const CHECK_LABELS: Record<string, string> = {
  platform: 'Windows 平台',
  config: '本機設定檔',
  engine: 'UE 引擎執行檔',
  project: '.uproject 專案檔',
  plugin: '已編譯外掛',
  noShadow: '無外掛副本遮蔽',
};

const CHECK_ORDER = ['platform', 'config', 'engine', 'project', 'plugin', 'noShadow'];

// ─── Sub-components ──────────────────────────────────────────────────────────

interface FreshBadgeProps { ts: string | null | undefined; justRan: boolean }

function FreshBadge({ ts, justRan }: FreshBadgeProps) {
  if (justRan) {
    return <span className="freshbadge now"><Icon name="check" size={10} /> 剛剛更新</span>;
  }
  if (!ts) {
    return <span className="freshbadge never">尚未爬取 · Never</span>;
  }
  return (
    <span className="freshbadge has">
      <Icon name="clock" size={10} /> {relTime(ts)} · {fmtTime(ts)}
    </span>
  );
}

// ─── §1 PathsSection ────────────────────────────────────────────────────────

interface PathsSectionProps {
  saveConfig: (p: string, e: string) => Promise<{ ok: boolean; error?: string }>;
  initialProjectPath: string;
  initialEngineRoot: string;
}

function PathsSection({ saveConfig, initialProjectPath, initialEngineRoot }: PathsSectionProps) {
  const [projectPath, setProjectPath] = useState(initialProjectPath);
  const [engineRoot, setEngineRoot] = useState(initialEngineRoot);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Seed once from env, never clobber an edit in progress
  const seededRef = useRef(false);
  useEffect(() => {
    if (!seededRef.current && (initialProjectPath || initialEngineRoot)) {
      seededRef.current = true;
      setProjectPath(p => p || initialProjectPath);
      setEngineRoot(p => p || initialEngineRoot);
    }
  }, [initialProjectPath, initialEngineRoot]);

  const onSave = async () => {
    setSaving(true);
    setMsg(null);
    const r = await saveConfig(projectPath.trim(), engineRoot.trim());
    setSaving(false);
    setMsg(r.ok ? { ok: true, text: '已儲存，已重新檢查環境。' } : { ok: false, text: r.error ?? '儲存失敗' });
  };

  return (
    <div className="cfg-sec">
      <div className="sech">
        <span className="secn">1</span>
        <span className="sect">專案路徑</span>
        <span className="secd">很少變動</span>
      </div>
      <div className="field">
        <label>.uproject 路徑</label>
        <div className="inp">
          <Icon name="folder" size={13} style={{ color: 'var(--text-mute)' }} />
          <input
            value={projectPath}
            spellCheck={false}
            placeholder="C:\Path\To\Project.uproject"
            onChange={e => setProjectPath(e.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label>UE 引擎根目錄 <span style={{ color: 'var(--text-mute)' }}>Engine root</span></label>
        <div className="inp">
          <Icon name="chip" size={13} style={{ color: 'var(--text-mute)' }} />
          <input
            value={engineRoot}
            spellCheck={false}
            placeholder="C:\Program Files\Epic Games\UE_5.7"
            onChange={e => setEngineRoot(e.target.value)}
          />
        </div>
      </div>
      <button
        className="btn sm"
        style={{ marginTop: 2 }}
        disabled={saving || (!projectPath.trim() && !engineRoot.trim())}
        onClick={() => void onSave()}
      >
        <Icon name="check" size={13} /> {saving ? '儲存中…' : '儲存設定'}
      </button>
      {msg && (
        <div style={{ fontSize: 11, marginTop: 5, color: msg.ok ? 'var(--ok)' : 'var(--error)' }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}

// ─── §2 EnvSection ──────────────────────────────────────────────────────────

interface EnvSectionProps {
  env: import('../../server/crawl-types').EnvStatus | null;
  refreshEnv: () => void;
}

function EnvSection({ env, refreshEnv }: EnvSectionProps) {
  const allOk = !!env?.ready;
  return (
    <div className="cfg-sec">
      <div className="sech">
        <span className="secn">2</span>
        <span className="sect">環境檢查</span>
        <span className="secd">爬取的前置條件</span>
      </div>
      <div className={'envbanner ' + (allOk ? 'ready' : 'notready')}>
        <Icon name={allOk ? 'check' : 'warn'} size={15} />
        {allOk
          ? <span>環境就緒，可以爬取</span>
          : <span>尚未就緒<span className="sub"> — 完成下列項目即可爬取</span></span>
        }
      </div>
      <div className="envlist2">
        {CHECK_ORDER.map(k => {
          const c = env?.checks[k];
          return (
            <div key={k} className={'envrow2 ' + (c?.ok ? 'ok' : 'bad')}>
              <span className="ei">
                <Icon name={c?.ok ? 'check' : 'x'} size={11} />
              </span>
              <span className="el2">
                {CHECK_LABELS[k] ?? k}
                <span className="en">{EN_LABELS[k]}</span>
              </span>
              {c && !c.ok && <span className="ed2">{c.detail}</span>}
            </div>
          );
        })}
      </div>
      <button
        className="btn sm"
        style={{ marginTop: 10 }}
        onClick={() => void refreshEnv()}
      >
        <Icon name="refresh" size={13} /> 重新檢查
      </button>
    </div>
  );
}

// ─── CrawlButton ────────────────────────────────────────────────────────────

interface CrawlButtonProps {
  k: CrawlKind;
  freshness: import('../../server/crawl-types').CrawlFreshness | undefined;
  justRan: CrawlKind | null;
  disabled: boolean;
  onStart: (k: CrawlKind) => void;
  adv?: boolean;
}

function CrawlButton({ k, freshness, justRan, disabled, onStart, adv = false }: CrawlButtonProps) {
  const meta = CRAWL_KIND_META[k];
  return (
    <button
      className={'crawlbtn' + (adv ? ' adv' : '')}
      disabled={disabled}
      onClick={() => onStart(k)}
    >
      <div className="cbh">
        <span className="cbrun">
          <Icon name="refresh" size={adv ? 12 : 14} />
        </span>
        <div style={{ flex: 1 }}>
          <div className="cbtitle">{meta.label}</div>
          <div className="cben">{meta.en}</div>
        </div>
      </div>
      {!adv && <div className="cbdesc">{meta.desc}</div>}
      <div className="cbrefresh">
        <Icon name="branch" size={11} /> 刷新：{meta.refresh}
      </div>
      <div className="cbfoot">
        <FreshBadge ts={freshness?.[k]} justRan={justRan === k} />
      </div>
    </button>
  );
}

// ─── §3 CrawlOpsSection ─────────────────────────────────────────────────────

interface CrawlOpsSectionProps {
  env: import('../../server/crawl-types').EnvStatus | null;
  mfRoot: string;
  setMfRoot: (v: string) => void;
  matRoot: string;
  setMatRoot: (v: string) => void;
  justRan: CrawlKind | null;
  onStart: (k: CrawlKind) => void;
}

function CrawlOpsSection({ env, mfRoot, setMfRoot, matRoot, setMatRoot, justRan, onStart }: CrawlOpsSectionProps) {
  const [advOpen, setAdvOpen] = useState(false);
  const dis = !env?.ready;
  const freshness = env?.freshness;

  return (
    <div className="cfg-sec">
      <div className="sech">
        <span className="secn">3</span>
        <span className="sect">爬取操作</span>
        <span className="secd">{dis ? '環境就緒後啟用' : '一次僅能執行一項'}</span>
      </div>

      <div className="tier-label">主要 · 專案（常用）<span className="ln" /></div>

      {/* MF scope — drives 爬取專案 MF, and the T3D export reads the same root. */}
      <div className="field">
        <label>MF Content Route <span style={{ color: 'var(--text-mute)' }}>— 爬取專案 MF · 也供導出</span></label>
        <div className="inp">
          <span className="pfx">root</span>
          <input
            value={mfRoot}
            onChange={e => setMfRoot(e.target.value)}
            spellCheck={false}
            placeholder="/Game"
          />
        </div>
      </div>
      <CrawlButton k="workmf" freshness={freshness} justRan={justRan} disabled={dis} onStart={onStart} />

      {/* Base-material scope — drives 爬取專案母材質 (a separate folder from MF). */}
      <div className="field" style={{ marginTop: 12 }}>
        <label>母材質 Content Route <span style={{ color: 'var(--text-mute)' }}>— 爬取專案母材質</span></label>
        <div className="inp">
          <span className="pfx">root</span>
          <input
            value={matRoot}
            onChange={e => setMatRoot(e.target.value)}
            spellCheck={false}
            placeholder="/Game"
          />
        </div>
      </div>
      <CrawlButton k="projectmat" freshness={freshness} justRan={justRan} disabled={dis} onStart={onStart} />

      <div
        className={'advrow' + (advOpen ? ' open' : '')}
        role="button"
        tabIndex={0}
        onClick={() => setAdvOpen(o => !o)}
        onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setAdvOpen(o => !o)}
      >
        <Icon name="caret" size={13} className="caret" />
        進階／維護（官方原生，一般用不到）
        <span className="hint">{advOpen ? '收合' : '展開'}</span>
      </div>
      {advOpen && (
        <div style={{ paddingTop: 4 }}>
          <CrawlButton k="export" freshness={freshness} justRan={justRan} disabled={dis} onStart={onStart} adv />
          <CrawlButton k="enginemf" freshness={freshness} justRan={justRan} disabled={dis} onStart={onStart} adv />
        </div>
      )}
      {dis && (
        <div className="note" style={{ marginTop: 4 }}>
          ↑ 通過全部環境檢查後，這些按鈕才會啟用。
        </div>
      )}
    </div>
  );
}

// ─── RunLog ─────────────────────────────────────────────────────────────────

function RunLog({ lines }: { lines: Array<{ t: number; lvl: string; msg: string }> }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  return (
    <div className="runlog" ref={ref}>
      {lines.map((l, i) => (
        <div key={i} className={'ll ' + l.lvl}>
          <span className="lt">+{l.t.toFixed(1)}s</span>
          <span className="lm">{l.msg}</span>
        </div>
      ))}
    </div>
  );
}

// ─── RunPanel ────────────────────────────────────────────────────────────────

interface RunPanelProps {
  crawl: { status: string; kind: string | null; logs: string[]; exitCode: number | null };
  startRef: number;
  onStop: () => void;
  onReset: () => void;
  onRetry: () => void;
}

function RunPanel({ crawl, startRef, onStop, onReset, onRetry }: RunPanelProps) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (crawl.status !== 'running') return;
    setElapsed(Date.now() - startRef);
    const id = setInterval(() => setElapsed(Date.now() - startRef), 500);
    return () => clearInterval(id);
  }, [crawl.status, startRef]);

  const running = crawl.status === 'running';
  const ok = crawl.status === 'success';
  const kindKey = (crawl.kind ?? 'workmf') as CrawlKind;
  const meta = CRAWL_KIND_META[kindKey] ?? CRAWL_KIND_META.workmf;

  const logLines = crawl.logs.map(parseLogLine);
  const progress = running ? Math.min(96, (logLines.length / 20) * 100) : 100;
  const progressBg = crawl.status === 'error'
    ? 'var(--error)'
    : ok
    ? 'var(--ok)'
    : undefined;

  const diag = crawl.status === 'error' ? diagnoseCrawl(crawl.logs) : null;

  return (
    <div className="runwrap">
      <div className="run-head">
        <span className={'run-ico ' + (running ? '' : ok ? 'ok' : 'err')}>
          {running
            ? <Icon name="refresh" size={16} className="spin" />
            : ok
            ? <Icon name="check" size={16} />
            : <Icon name="x" size={16} />
          }
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="run-title">{meta.label}</div>
          <div className="run-sub">
            {running
              ? '執行中…（編輯器啟動需數分鐘）'
              : ok
              ? '完成，已即時刷新'
              : `${meta.label}失敗${crawl.exitCode != null ? `（exit ${crawl.exitCode}）` : ''}`
            }
          </div>
        </div>
        <div className="run-elapsed">
          {(elapsed / 1000).toFixed(1)}s
          <br />
          <span style={{ color: 'var(--text-mute)', fontSize: 9 }}>elapsed</span>
        </div>
      </div>

      <div className="progress">
        <div className="bar" style={{ width: progress + '%', background: progressBg }} />
      </div>

      <RunLog lines={logLines} />

      {running && (
        <div className="run-actions">
          <button className="btn" style={{ flex: 1, justifyContent: 'center' }} onClick={onStop}>
            <Icon name="x" size={13} /> 停止爬取
          </button>
        </div>
      )}

      {ok && (
        <div className="run-result ok">
          <div className="rt">
            <Icon name="check" size={15} /> {meta.label}完成，已即時刷新
          </div>
          {kindKey === 'projectmat' && (
            <div className="fix-text" style={{ color: 'var(--text-dim)' }}>
              → 已填入 Files 分頁的「工作」區（僅母材質，MF 已略過）。
            </div>
          )}
        </div>
      )}

      {crawl.status === 'error' && (
        <div className="run-result err">
          <div className="rt">
            <Icon name="warn" size={15} /> {meta.label}失敗
            {crawl.exitCode != null ? `（exit ${crawl.exitCode}）` : ''}
          </div>
          {diag ? (
            <>
              <div className="cause">{diag.cause}</div>
              <div>
                <span className={'fixpill ' + (diag.who === 'you' ? 'self' : 'maint')}>
                  <Icon name={diag.who === 'you' ? 'check' : 'warn'} size={11} />
                  {diag.who === 'you' ? '你可以自行修復' : '需要工具維護者協助'}
                </span>
              </div>
              <div className="fix-text">{diag.fix}</div>
            </>
          ) : (
            <div className="cause">無法自動判斷原因，請見下方完整 log，必要時附給維護者。</div>
          )}
          {crawl.logs.length > 0 && (
            <details className="logdetails">
              <summary>
                <Icon name="caret" size={12} className="caret" /> 完整 log
              </summary>
              <RunLog lines={logLines} />
            </details>
          )}
        </div>
      )}

      {!running && (
        <div className="run-actions">
          {crawl.status === 'error' && (
            <button className="btn primary" style={{ flex: 1, justifyContent: 'center' }} onClick={onRetry}>
              <Icon name="refresh" size={13} /> 重試
            </button>
          )}
          <button className="btn" style={{ flex: 1, justifyContent: 'center' }} onClick={onReset}>
            返回爬取面板
          </button>
        </div>
      )}
    </div>
  );
}

// ─── ConfigPanel (public export) ────────────────────────────────────────────

export interface ConfigPanelProps {
  /** MF content root (爬取專案 MF + 導出) — from App via Sidebar. Use the props, not localStorage. */
  mfRoot: string;
  setMfRoot: (v: string) => void;
  /** Base-material content root (爬取專案母材質) — from App via Sidebar. */
  matRoot: string;
  setMatRoot: (v: string) => void;
}

export function ConfigPanel({ mfRoot, setMfRoot, matRoot, setMatRoot }: ConfigPanelProps) {
  const { state, startCrawl, stopCrawl, resetCrawl, refreshEnv, saveConfig } = useStore();
  const { env, crawl, connection } = state;

  // Each crawl scope reads its own content root; the advanced/maintenance crawls
  // (export/enginemf) take no root.
  const rootFor = (k: CrawlKind): string | undefined =>
    k === 'workmf' ? (mfRoot.trim() || '/Game')
      : k === 'projectmat' ? (matRoot.trim() || '/Game')
        : undefined;

  // Track the most-recently-completed crawl kind for FreshBadge "justRan" indicator.
  const [justRan, setJustRan] = useState<CrawlKind | null>(null);
  const prevStatusRef = useRef(crawl.status);
  useEffect(() => {
    if (prevStatusRef.current === 'running' && crawl.status === 'success') {
      setJustRan(crawl.kind as CrawlKind | null);
    }
    prevStatusRef.current = crawl.status;
  }, [crawl.status, crawl.kind]);

  // Track crawl start time for elapsed timer
  const crawlStartRef = useRef(Date.now());
  useEffect(() => {
    if (crawl.status === 'running') crawlStartRef.current = Date.now();
  }, [crawl.status]);

  const onStart = (k: CrawlKind) => {
    void startCrawl(k, rootFor(k));
  };

  const onRetry = () => {
    const k = crawl.kind as CrawlKind;
    void startCrawl(k, rootFor(k));
  };

  // ── snapshot branch ──────────────────────────────────────────────────────
  if (connection === 'snapshot') {
    return (
      <div className="cfg">
        <div className="cfg-notice">
          <div className="ni"><Icon name="layers" size={20} /></div>
          <div className="nt">此匯出快照無法爬取</div>
          <div className="nd">
            爬取需要連到本機的 Unreal 專案。離線快照是唯讀的，環境檢查與爬取按鈕已隱藏。
          </div>
        </div>
        <div className="cfg-sec">
          <div className="field">
            <label>MF content root <span style={{ color: 'var(--text-mute)' }}>— 保留供匯出使用</span></label>
            <div className="inp">
              <span className="pfx">root</span>
              <input
                value={mfRoot}
                onChange={e => setMfRoot(e.target.value)}
                spellCheck={false}
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── reconnecting branch ──────────────────────────────────────────────────
  if (connection === 'reconnecting') {
    return (
      <div className="cfg">
        <div className="reconnect-spin">
          <Icon name="refresh" size={26} className="spin" style={{ color: 'var(--accent)' }} />
          <div>
            正在連線本機 viewer server…
            <div className="note" style={{ marginTop: 6 }}>
              connecting to local viewer server · 127.0.0.1
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── live: run-panel takeover ─────────────────────────────────────────────
  if (crawl.status !== 'idle') {
    return (
      <div className="cfg">
        <RunPanel
          crawl={crawl}
          startRef={crawlStartRef.current}
          onStop={stopCrawl}
          onReset={resetCrawl}
          onRetry={onRetry}
        />
      </div>
    );
  }

  // ── live: idle ───────────────────────────────────────────────────────────
  return (
    <div className="cfg">
      <PathsSection
        saveConfig={saveConfig}
        initialProjectPath={env?.projectPath ?? ''}
        initialEngineRoot={env?.engineRoot ?? ''}
      />
      <EnvSection env={env} refreshEnv={() => void refreshEnv()} />
      <CrawlOpsSection
        env={env}
        mfRoot={mfRoot}
        setMfRoot={setMfRoot}
        matRoot={matRoot}
        setMatRoot={setMatRoot}
        justRan={justRan}
        onStart={onStart}
      />
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { useStore } from './store';
import { UserAdminSection } from './UserAdmin';
import { TeamPanel } from './TeamPanel';
import type { CrawlKind } from './crawlRequest';
import { diagnoseCrawl } from './crawlDiagnosis';
import { Icon } from './Icon';
import './config.css';
import { fmtTimeCompact as fmtTime, relTimeMinutes as relTime } from './timeUtils';
import { parseLogLine } from './uiHelpers';
import type { ProviderStatus } from './agent/protocol';

// ─── CRAWL_KIND_META ────────────────────────────────────────────────────────

interface CrawlMeta { label: string; en: string; desc: string; refresh: string }

const CRAWL_KIND_META: Record<CrawlKind, CrawlMeta> = {
  workmf: {
    label: '爬取專案 MF',
    en: 'Crawl Project Material Functions',
    desc: '掃描指定 Content Route 下所有專案 MaterialFunction，只刷新簽名索引，供節點庫 / AI / 導出解析；不寫入 Files 的工作區。',
    refresh: 'Project MF 簽名索引',
  },
  projectmat: {
    label: '爬取專案母材質',
    en: 'Crawl Project Parent Materials',
    desc: '匯入「母材質 Content Route」下的母材質到 Files 的「工作」區；也會帶入這些母材質引用到的專案 MF，方便點進函式圖。',
    refresh: 'Files 分頁 · 工作（母材質 + 引用 MF）',
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

// English sub-labels for the env checks. Kept platform-neutral: the crawl runs
// on Windows OR macOS, so the labels must read correctly on both. The exact
// host / binary name surfaces in the per-check detail string from crawl-env.ts.
const EN_LABELS: Record<string, string> = {
  platform: 'host platform',
  config: 'local.config.json',
  engine: 'UE editor binary',
  project: '.uproject file',
  plugin: 'compiled plugin',
  noShadow: 'no shadow copy',
};

// Friendly zh-TW labels
const CHECK_LABELS: Record<string, string> = {
  platform: '執行平台',
  config: '本機設定檔',
  engine: 'UE 編輯器執行檔',
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
  const stickToBottomRef = useRef(true);
  const lastLineCountRef = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const firstRender = lastLineCountRef.current === 0;
    lastLineCountRef.current = lines.length;
    if (firstRender || stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines.length, lines[lines.length - 1]?.msg]);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  };

  return (
    <div className="runlog" ref={ref} onScroll={onScroll} onWheel={e => e.stopPropagation()}>
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
  const [copiedLog, setCopiedLog] = useState(false);
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
  const copyErrorLog = async () => {
    try {
      await navigator.clipboard.writeText(crawl.logs.join('\n'));
      setCopiedLog(true);
      window.setTimeout(() => setCopiedLog(false), 1400);
    } catch {
      setCopiedLog(false);
    }
  };

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
              → 已填入 Files 分頁的「工作」區（母材質，以及其引用到的專案 MF）。
            </div>
          )}
        </div>
      )}

      {crawl.status === 'error' && (
        <div className="run-result err">
          <div className="errtop">
            <div className="rt">
              <Icon name="warn" size={15} /> {meta.label}失敗
              {crawl.exitCode != null ? `（exit ${crawl.exitCode}）` : ''}
            </div>
            {crawl.logs.length > 0 && (
              <button className="copylogbtn" onClick={() => void copyErrorLog()}>
                <Icon name={copiedLog ? 'check' : 'clip'} size={12} />
                {copiedLog ? '已複製' : '複製錯誤 log'}
              </button>
            )}
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

// ─── §4 AiSection ───────────────────────────────────────────────────────────

interface AiSectionProps {
  saveAgentConfig: (llm: {
    provider: string; baseUrl?: string; apiKey?: string; model: string; maxTokens?: number;
    maxIters?: number; contextLimit?: number;
  }, web?: {
    searchBackend?: string; tavilyApiKey?: string; braveApiKey?: string;
    searxngBaseUrl?: string; proxyUrl?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
}

// web_search backend choices — 'auto' picks the first configured key backend,
// DDG when none. Stored value '' (auto) clears the field server-side.
const SEARCH_BACKEND_OPTIONS = [
  { value: 'auto',       label: '自動（有金鑰用金鑰後端，否則 DuckDuckGo）' },
  { value: 'duckduckgo', label: 'DuckDuckGo（免金鑰，品質一般）' },
  { value: 'tavily',     label: 'Tavily（為 AI 設計，免費 1000 次/月）' },
  { value: 'brave',      label: 'Brave Search（免費 2000 次/月）' },
  { value: 'searxng',    label: 'SearXNG（自架/公共實例，填 Base URL）' },
];

// 最大迭代次數 choices — value is what gets stored (0 = unlimited).
const MAX_ITERS_OPTIONS = [
  { value: '8',  label: '8（預設）' },
  { value: '16', label: '16' },
  { value: '32', label: '32' },
  { value: '0',  label: '不限制（仍受上下文上限保護）' },
];

// 上下文長度 choices — tokens; '' = use the loop defaults (300K 上限 / 150K 壓縮).
const CONTEXT_LIMIT_OPTIONS = [
  { value: '',        label: '預設（300K 上限，150K 開始壓縮）' },
  { value: '128000',  label: '128K' },
  { value: '200000',  label: '200K' },
  { value: '256000',  label: '256K' },
  { value: '1000000', label: '1M' },
];

function AiSection({ saveAgentConfig }: AiSectionProps) {
  const [provider, setProvider] = useState<'anthropic' | 'openai-compatible'>('anthropic');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  // apiKey is NEVER pre-filled from anywhere — password input only. Saving
  // without typing leaves the previously-stored key intact (the server contract).
  const [apiKey, setApiKey] = useState('');
  const [maxTokens, setMaxTokens] = useState('');
  const [maxIters, setMaxIters] = useState('8');
  const [contextLimit, setContextLimit] = useState('');
  // 網路搜尋 (Web section). API keys follow the apiKey contract: never
  // pre-filled, empty = keep the stored key.
  const [searchBackend, setSearchBackend] = useState('auto');
  const [tavilyKey, setTavilyKey] = useState('');
  const [braveKey, setBraveKey] = useState('');
  const [searxngBaseUrl, setSearxngBaseUrl] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [webTesting, setWebTesting] = useState(false);
  const [webTestResult, setWebTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  // Fetch current provider status on mount; seed the form from the saved config
  // ONCE so the user edits what is stored instead of a blank form (key excluded).
  const seededRef = useRef(false);
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch('/api/agent/status', { cache: 'no-store' });
        if (!r.ok) return;
        const s = await r.json() as ProviderStatus;
        setStatus(s);
        if (!seededRef.current && s.configured) {
          seededRef.current = true;
          if (s.provider === 'anthropic' || s.provider === 'openai-compatible') setProvider(s.provider);
          setModel(m => m || (s.model ?? ''));
          setBaseUrl(b => b || (s.baseUrl ?? ''));
          // Seed the two selects only when the stored value matches an option;
          // a hand-edited custom number keeps the default choice instead of
          // silently rendering a value the select cannot show.
          if (s.maxIters !== undefined && MAX_ITERS_OPTIONS.some(o => o.value === String(s.maxIters))) {
            setMaxIters(String(s.maxIters));
          }
          if (s.contextLimit !== undefined && CONTEXT_LIMIT_OPTIONS.some(o => o.value === String(s.contextLimit))) {
            setContextLimit(String(s.contextLimit));
          }
        }
        // Web fields seed independently of Llm (the effect runs once on mount).
        if (s.webSearchBackend && SEARCH_BACKEND_OPTIONS.some(o => o.value === s.webSearchBackend)) {
          setSearchBackend(s.webSearchBackend);
        }
        setSearxngBaseUrl(v => v || (s.searxngBaseUrl ?? ''));
        setProxyUrl(v => v || (s.webProxyUrl ?? ''));
      } catch { /* ignore */ }
    })();
  }, []);

  const onSave = async () => {
    setSaving(true);
    setMsg(null);
    setTestResult(null);
    const llm: {
      provider: string; baseUrl?: string; apiKey?: string; model: string; maxTokens?: number;
      maxIters?: number; contextLimit?: number;
    } = {
      provider,
      model: model.trim(),
      // Always sent (both providers accept a custom endpoint / relay);
      // an empty string clears the stored value → adapters fall back to the default.
      baseUrl: baseUrl.trim(),
      // Always sent: 0 = unlimited iterations; the server stores the number as-is.
      maxIters: parseInt(maxIters, 10),
      // Always sent: '' maps to -1 which the server treats as "clear → defaults".
      contextLimit: contextLimit === '' ? -1 : parseInt(contextLimit, 10),
    };
    // Only send apiKey if the user typed something; empty = leave stored key intact.
    if (apiKey) llm.apiKey = apiKey;
    const mt = parseInt(maxTokens.trim(), 10);
    if (!isNaN(mt) && mt > 0) llm.maxTokens = mt;

    // Web section: backend/URLs always sent (empty clears); keys only when typed.
    const web: { searchBackend?: string; tavilyApiKey?: string; braveApiKey?: string; searxngBaseUrl?: string; proxyUrl?: string } = {
      searchBackend,
      searxngBaseUrl: searxngBaseUrl.trim(),
      proxyUrl: proxyUrl.trim(),
    };
    if (tavilyKey) web.tavilyApiKey = tavilyKey;
    if (braveKey) web.braveApiKey = braveKey;

    const r = await saveAgentConfig(llm, web);
    setSaving(false);
    if (r.ok) {
      setMsg({ ok: true, text: '已儲存 AI 助手設定。' });
      setApiKey(''); // Clear after save to avoid accidental re-submission.
      setTavilyKey('');
      setBraveKey('');
      // Refresh status after save.
      try {
        const s = await fetch('/api/agent/status', { cache: 'no-store' });
        if (s.ok) setStatus(await s.json() as ProviderStatus);
      } catch { /* ignore */ }
    } else {
      setMsg({ ok: false, text: r.error ?? '儲存失敗' });
    }
  };

  const onWebTest = async () => {
    setWebTesting(true);
    setWebTestResult(null);
    try {
      const r = await fetch('/api/agent/web-test', { method: 'POST', cache: 'no-store' });
      if (!r.ok) {
        setWebTestResult({ ok: false, text: `測試請求失敗（HTTP ${r.status}）` });
        return;
      }
      const body = await r.json() as import('./agent/protocol').AgentWebTestResponse;
      setWebTestResult(body.ok
        ? { ok: true, text: `搜尋正常 — ${body.backend} 回傳 ${body.results} 筆結果` }
        : { ok: false, text: body.error });
    } catch {
      setWebTestResult({ ok: false, text: '測試請求失敗' });
    } finally {
      setWebTesting(false);
    }
  };

  const onTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await fetch('/api/agent/test', { method: 'POST', cache: 'no-store' });
      if (!r.ok) {
        setTestResult({ ok: false, text: `測試請求失敗（HTTP ${r.status}）` });
        return;
      }
      const body = await r.json() as import('./agent/protocol').AgentTestResponse;
      setTestResult(body.ok
        ? { ok: true, text: `連線成功 — ${body.model} 回應正常` }
        : { ok: false, text: body.error });
    } catch {
      setTestResult({ ok: false, text: '測試請求失敗' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="cfg-sec">
      <div className="sech">
        <span className="secn">4</span>
        <span className="sect">AI 助手</span>
        <span className="secd">對話式材質生成</span>
      </div>

      {/* Saved-config status card. The key itself is never echoed — only whether one is stored. */}
      <div className={'ai-card' + (status?.configured ? '' : ' uncfg')}>
        {status?.configured ? (
          <>
            <div className="ai-card-head">
              <Icon name="check" size={12} /> 已設定
            </div>
            <div className="ai-row"><span className="k">Provider</span><span className="v">{status.provider}</span></div>
            <div className="ai-row"><span className="k">Model</span><span className="v">{status.model}</span></div>
            {status.baseUrl && (
              <div className="ai-row"><span className="k">Base URL</span><span className="v">{status.baseUrl}</span></div>
            )}
            <div className="ai-row">
              <span className="k">API Key</span>
              <span className="v">{status.hasApiKey ? '已儲存（不會顯示）' : '未設定'}</span>
            </div>
            {status.maxIters !== undefined && (
              <div className="ai-row">
                <span className="k">迭代上限</span>
                <span className="v">{status.maxIters === 0 ? '不限制' : status.maxIters}</span>
              </div>
            )}
            {status.contextLimit !== undefined && (
              <div className="ai-row">
                <span className="k">上下文</span>
                <span className="v">{status.contextLimit >= 1_000_000 ? `${status.contextLimit / 1_000_000}M` : `${Math.round(status.contextLimit / 1000)}K`} tokens</span>
              </div>
            )}
            {status.webSearchBackend && (
              <div className="ai-row">
                <span className="k">搜尋後端</span>
                <span className="v">
                  {status.webSearchBackend}
                  {status.hasTavilyKey ? ' · tavily✓' : ''}
                  {status.hasBraveKey ? ' · brave✓' : ''}
                  {status.searxngBaseUrl ? ' · searxng✓' : ''}
                  {status.webProxyUrl ? ' · 代理✓' : ''}
                </span>
              </div>
            )}
            <div className="ai-test-row">
              <button className="btn sm" disabled={testing} onClick={() => void onTest()}>
                {testing
                  ? <><Icon name="refresh" size={12} className="spin" /> 測試中…</>
                  : <><Icon name="bolt" size={12} /> 測試連線</>}
              </button>
              {testResult && (
                <span className={'ai-test-result ' + (testResult.ok ? 'ok' : 'err')}>{testResult.text}</span>
              )}
            </div>
          </>
        ) : (
          <div className="ai-card-head">
            <Icon name="warn" size={12} /> 尚未設定 — 填寫下方欄位並儲存
          </div>
        )}
      </div>

      <div className="field">
        <label>Provider</label>
        <div className="inp">
          <select
            value={provider}
            onChange={e => setProvider(e.target.value as 'anthropic' | 'openai-compatible')}
          >
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai-compatible">OpenAI-compatible (OpenAI / DeepSeek / Ollama / …)</option>
          </select>
        </div>
      </div>

      <div className="field">
        <label>
          Base URL{' '}
          <span style={{ color: 'var(--text-mute)' }}>
            {provider === 'anthropic' ? '— 選填，中轉/代理用；留空走官方 API' : '— 例如 https://api.openai.com/v1'}
          </span>
        </label>
        <div className="inp">
          <input
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            spellCheck={false}
            placeholder={provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'}
          />
        </div>
      </div>

      <div className="field">
        <label>Model</label>
        <div className="inp">
          <input
            value={model}
            onChange={e => setModel(e.target.value)}
            spellCheck={false}
            placeholder={provider === 'anthropic' ? 'claude-opus-4-8' : 'gpt-4o'}
          />
        </div>
      </div>

      <div className="field">
        <label>API Key <span style={{ color: 'var(--text-mute)' }}>— 不填保留現有金鑰</span></label>
        <div className="inp">
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            autoComplete="off"
            placeholder="sk-…（不填表示保留現有金鑰）"
          />
        </div>
      </div>

      <div className="field">
        <label>Max Tokens <span style={{ color: 'var(--text-mute)' }}>— 選填，預設 8192</span></label>
        <div className="inp">
          <input
            value={maxTokens}
            onChange={e => setMaxTokens(e.target.value)}
            placeholder="8192"
            inputMode="numeric"
          />
        </div>
      </div>

      <div className="field">
        <label>
          最大迭代次數{' '}
          <span style={{ color: 'var(--text-mute)' }}>— 每輪對話的工具迴圈上限</span>
        </label>
        <div className="inp">
          <select value={maxIters} onChange={e => setMaxIters(e.target.value)}>
            {MAX_ITERS_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label>
          上下文長度{' '}
          <span style={{ color: 'var(--text-mute)' }}>— 依模型視窗選擇；達一半自動壓縮舊對話</span>
        </label>
        <div className="inp">
          <select value={contextLimit} onChange={e => setContextLimit(e.target.value)}>
            {CONTEXT_LIMIT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── 網路搜尋（web_search 後端 / 代理）── */}
      <div className="field">
        <label>
          搜尋後端{' '}
          <span style={{ color: 'var(--text-mute)' }}>— agent 查網路時用的搜尋服務</span>
        </label>
        <div className="inp">
          <select value={searchBackend} onChange={e => setSearchBackend(e.target.value)}>
            {SEARCH_BACKEND_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {(searchBackend === 'auto' || searchBackend === 'tavily') && (
        <div className="field">
          <label>Tavily API Key <span style={{ color: 'var(--text-mute)' }}>— tavily.com 免費註冊；不填保留現有金鑰</span></label>
          <div className="inp">
            <input
              type="password"
              value={tavilyKey}
              onChange={e => setTavilyKey(e.target.value)}
              autoComplete="off"
              placeholder={status?.hasTavilyKey ? '已儲存（不填保留）' : 'tvly-…'}
            />
          </div>
        </div>
      )}

      {(searchBackend === 'auto' || searchBackend === 'brave') && (
        <div className="field">
          <label>Brave API Key <span style={{ color: 'var(--text-mute)' }}>— brave.com/search/api；不填保留現有金鑰</span></label>
          <div className="inp">
            <input
              type="password"
              value={braveKey}
              onChange={e => setBraveKey(e.target.value)}
              autoComplete="off"
              placeholder={status?.hasBraveKey ? '已儲存（不填保留）' : 'BSA…'}
            />
          </div>
        </div>
      )}

      {(searchBackend === 'auto' || searchBackend === 'searxng') && (
        <div className="field">
          <label>SearXNG Base URL <span style={{ color: 'var(--text-mute)' }}>— 自架或可達的實例（需開放 JSON API）</span></label>
          <div className="inp">
            <input
              value={searxngBaseUrl}
              onChange={e => setSearxngBaseUrl(e.target.value)}
              spellCheck={false}
              placeholder="http://192.168.1.10:8888"
            />
          </div>
        </div>
      )}

      <div className="field">
        <label>網路代理 <span style={{ color: 'var(--text-mute)' }}>— 選填；web 工具走此 http 代理（如 Clash 本機埠）</span></label>
        <div className="inp">
          <input
            value={proxyUrl}
            onChange={e => setProxyUrl(e.target.value)}
            spellCheck={false}
            placeholder="http://127.0.0.1:7890"
          />
        </div>
      </div>

      <div className="ai-test-row">
        <button
          className="btn sm"
          disabled={webTesting}
          onClick={() => void onWebTest()}
          title="以「已儲存」的搜尋設定實際搜一次——改動後請先儲存再測試"
        >
          {webTesting
            ? <><Icon name="refresh" size={12} className="spin" /> 搜尋中…</>
            : <><Icon name="globe" size={12} /> 測試搜尋</>}
        </button>
        {webTestResult && (
          <span className={'ai-test-result ' + (webTestResult.ok ? 'ok' : 'err')}>{webTestResult.text}</span>
        )}
      </div>

      <button
        className="btn sm"
        style={{ marginTop: 2 }}
        disabled={saving || !model.trim()}
        onClick={() => void onSave()}
      >
        <Icon name="check" size={13} /> {saving ? '儲存中…' : '儲存 AI 設定'}
      </button>
      {msg && (
        <div style={{ fontSize: 11, marginTop: 5, color: msg.ok ? 'var(--ok)' : 'var(--error)' }}>
          {msg.text}
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
  const { state, startCrawl, stopCrawl, resetCrawl, refreshEnv, saveConfig, saveAgentConfig } = useStore();
  const { env, crawl, connection } = state;
  // The panel got crowded (UE paths + env checks + crawls + LLM/Web + team) —
  // a segmented sub-tab keeps each concern on a short page.
  const [cfgTab, setCfgTab] = useState<'crawl' | 'ai' | 'team'>('crawl');

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

  // ── team mode, member role: the whole panel is admin-managed ─────────────
  if (state.auth?.mode === 'team' && state.auth.role !== 'admin') {
    return (
      <div className="cfg">
        <div className="cfg-notice">
          <div className="ni"><Icon name="settings" size={20} /></div>
          <div className="nt">此區由管理員管理</div>
          <div className="nd">
            UE 路徑、爬取與 LLM 設定屬於伺服器端設定，僅管理員可變更。
            {crawl.status === 'running' && ' 目前有一個爬取正在進行。'}
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
      <div className="cfg-tabs" role="tablist">
        {([['crawl', '爬取'], ['ai', 'AI'], ['team', '團隊']] as const).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={cfgTab === k}
            className={'cfg-tab' + (cfgTab === k ? ' on' : '')}
            onClick={() => setCfgTab(k)}
          >
            {label}
          </button>
        ))}
      </div>
      {cfgTab === 'crawl' && (
        <>
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
        </>
      )}
      {cfgTab === 'ai' && <AiSection saveAgentConfig={saveAgentConfig} />}
      {cfgTab === 'team' && (
        <>
          <TeamPanel />
          {state.auth?.mode === 'team' && state.auth.role === 'admin' && <UserAdminSection />}
        </>
      )}
    </div>
  );
}

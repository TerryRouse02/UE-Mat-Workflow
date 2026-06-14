import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useStore } from './store';
import { UserAdminSection } from './UserAdmin';
import { TeamPanel } from './TeamPanel';
import { MyAccountSection } from './MyAccount';
import { TeamUsageSection } from './TeamUsage';
import { ProposalInboxSection } from './ProposalInbox';
import type { CrawlKind } from './crawlRequest';
import { compilePluginAction } from './compilePluginState';
import { diagnoseCrawl } from './crawlDiagnosis';
import { Icon } from './Icon';
import './config.css';
import { fmtTimeCompact as fmtTime, relTimeMinutes as relTime } from './timeUtils';
import { parseLogLine } from './uiHelpers';
import type { ProviderStatus } from './agent/protocol';
import { FsBrowser } from './FsBrowser';

// ─── CRAWL_KIND_META ────────────────────────────────────────────────────────

interface CrawlMeta { label: string; en: string; desc: string; refresh: string }

// i18n key fragments per crawl kind; resolved at render time via t('crawl.<kind>.<field>').
const crawlMeta = (t: TFunction, k: CrawlKind): CrawlMeta => ({
  label: t(`crawl.${k}.label`),
  en: t(`crawl.${k}.en`),
  desc: t(`crawl.${k}.desc`),
  refresh: t(`crawl.${k}.refresh`),
});

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

const CHECK_ORDER = ['platform', 'config', 'engine', 'project', 'plugin', 'noShadow'];

// ─── Sub-components ──────────────────────────────────────────────────────────

interface FreshBadgeProps { ts: string | null | undefined; justRan: boolean }

function FreshBadge({ ts, justRan }: FreshBadgeProps) {
  const { t } = useTranslation();
  if (justRan) {
    return <span className="freshbadge now"><Icon name="check" size={10} /> {t('configPanel.freshJustNow')}</span>;
  }
  if (!ts) {
    return <span className="freshbadge never">{t('configPanel.freshNever')}</span>;
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
  /** Local mode only — the host file picker is hidden in team mode. */
  allowBrowse: boolean;
}

function PathsSection({ saveConfig, initialProjectPath, initialEngineRoot, allowBrowse }: PathsSectionProps) {
  const { t } = useTranslation();
  const [projectPath, setProjectPath] = useState(initialProjectPath);
  const [engineRoot, setEngineRoot] = useState(initialEngineRoot);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Which field's host-directory picker is open (null = none).
  const [browsing, setBrowsing] = useState<'project' | 'engine' | null>(null);

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
    setMsg(r.ok ? { ok: true, text: t('configPanel.pathsSaved') } : { ok: false, text: r.error ?? t('configPanel.saveFailed') });
  };

  return (
    <div className="cfg-sec">
      <div className="sech">
        <span className="secn">1</span>
        <span className="sect">{t('configPanel.pathsTitle')}</span>
        <span className="secd">{t('configPanel.pathsHint')}</span>
      </div>
      <div className="field">
        <label>{t('configPanel.uprojectPath')}</label>
        <div className="inp">
          <Icon name="folder" size={13} style={{ color: 'var(--text-mute)' }} />
          <input
            value={projectPath}
            spellCheck={false}
            placeholder="C:\Path\To\Project.uproject"
            onChange={e => setProjectPath(e.target.value)}
          />
          {allowBrowse && (
            <button className="inp-browse" title={t('configPanel.browseProjectTitle')} onClick={() => setBrowsing('project')}>
              {t('configPanel.browse')}
            </button>
          )}
        </div>
      </div>
      <div className="field">
        <label>{t('configPanel.engineRoot')} <span style={{ color: 'var(--text-mute)' }}>Engine root</span></label>
        <div className="inp">
          <Icon name="chip" size={13} style={{ color: 'var(--text-mute)' }} />
          <input
            value={engineRoot}
            spellCheck={false}
            placeholder="C:\Program Files\Epic Games\UE_5.7"
            onChange={e => setEngineRoot(e.target.value)}
          />
          {allowBrowse && (
            <button className="inp-browse" title={t('configPanel.browseEngineTitle')} onClick={() => setBrowsing('engine')}>
              {t('configPanel.browse')}
            </button>
          )}
        </div>
      </div>

      {browsing === 'project' && (
        <FsBrowser
          pick="file"
          fileExt="uproject"
          initialPath={projectPath}
          title={t('configPanel.pickProjectTitle')}
          onPick={p => { setProjectPath(p); setBrowsing(null); }}
          onClose={() => setBrowsing(null)}
        />
      )}
      {browsing === 'engine' && (
        <FsBrowser
          pick="dir"
          initialPath={engineRoot}
          title={t('configPanel.pickEngineTitle')}
          onPick={p => { setEngineRoot(p); setBrowsing(null); }}
          onClose={() => setBrowsing(null)}
        />
      )}
      <button
        className="btn sm"
        style={{ marginTop: 2 }}
        disabled={saving || (!projectPath.trim() && !engineRoot.trim())}
        onClick={() => void onSave()}
      >
        <Icon name="check" size={13} /> {saving ? t('configPanel.saving') : t('configPanel.saveConfig')}
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
  onCompile: () => void;
}

function EnvSection({ env, refreshEnv, onCompile }: EnvSectionProps) {
  const { t } = useTranslation();
  const allOk = !!env?.ready;
  const compile = compilePluginAction(env);
  return (
    <div className="cfg-sec">
      <div className="sech">
        <span className="secn">2</span>
        <span className="sect">{t('configPanel.envTitle')}</span>
        <span className="secd">{t('configPanel.envHint')}</span>
      </div>
      <div className={'envbanner ' + (allOk ? 'ready' : 'notready')}>
        <Icon name={allOk ? 'check' : 'warn'} size={15} />
        {allOk
          ? <span>{t('configPanel.envReady')}</span>
          : <span>{t('configPanel.envNotReady')}<span className="sub"> {t('configPanel.envNotReadySub')}</span></span>
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
                {t(`configPanel.check_${k}`)}
                <span className="en">{EN_LABELS[k]}</span>
              </span>
              {c && !c.ok && <span className="ed2">{c.detail}</span>}
            </div>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button
          className="btn sm"
          onClick={() => void refreshEnv()}
        >
          <Icon name="refresh" size={13} /> {t('configPanel.recheck')}
        </button>
        {/* Build the external plugin binary for this OS (Win64 .dll / Mac .dylib).
            Runs on either platform via RunUAT, so a macOS user can produce the
            gitignored .dylib here instead of dropping to a terminal. */}
        <button
          className={'btn sm' + (compile.emphasize ? ' primary' : '')}
          disabled={!compile.enabled}
          title={compile.hint}
          onClick={onCompile}
        >
          <Icon name="chip" size={13} /> {t('configPanel.compilePlugin')}
        </button>
      </div>
    </div>
  );
}

// ─── CrawlButton ────────────────────────────────────────────────────────────

interface CrawlButtonProps {
  // 'compile' is a plugin build with no freshness entry — it lives in EnvSection,
  // never as a CrawlButton, so excluding it keeps the freshness lookup below sound.
  k: Exclude<CrawlKind, 'compile'>;
  freshness: import('../../server/crawl-types').CrawlFreshness | undefined;
  justRan: CrawlKind | null;
  disabled: boolean;
  onStart: (k: CrawlKind) => void;
  adv?: boolean;
}

function CrawlButton({ k, freshness, justRan, disabled, onStart, adv = false }: CrawlButtonProps) {
  const { t } = useTranslation();
  const meta = crawlMeta(t, k);
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
        <Icon name="branch" size={11} /> {t('configPanel.refreshes', { what: meta.refresh })}
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
  const { t } = useTranslation();
  const [advOpen, setAdvOpen] = useState(false);
  const dis = !env?.ready;
  const freshness = env?.freshness;

  return (
    <div className="cfg-sec">
      <div className="sech">
        <span className="secn">3</span>
        <span className="sect">{t('configPanel.crawlOpsTitle')}</span>
        <span className="secd">{dis ? t('configPanel.crawlOpsHintDisabled') : t('configPanel.crawlOpsHintEnabled')}</span>
      </div>

      <div className="tier-label">{t('configPanel.tierPrimary')}<span className="ln" /></div>

      {/* MF scope — drives 爬取專案 MF, and the T3D export reads the same root. */}
      <div className="field">
        <label>MF Content Route <span style={{ color: 'var(--text-mute)' }}>{t('configPanel.mfRootHint')}</span></label>
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
        <label>{t('configPanel.matRootLabel')} <span style={{ color: 'var(--text-mute)' }}>{t('configPanel.matRootHint')}</span></label>
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
        {t('configPanel.advancedToggle')}
        <span className="hint">{advOpen ? t('configPanel.collapse') : t('configPanel.expand')}</span>
      </div>
      {advOpen && (
        <div style={{ paddingTop: 4 }}>
          <CrawlButton k="export" freshness={freshness} justRan={justRan} disabled={dis} onStart={onStart} adv />
          <CrawlButton k="enginemf" freshness={freshness} justRan={justRan} disabled={dis} onStart={onStart} adv />
        </div>
      )}
      {dis && (
        <div className="note" style={{ marginTop: 4 }}>
          {t('configPanel.crawlDisabledNote')}
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
  const { t } = useTranslation();
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
  const meta = crawlMeta(t, kindKey);

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
              ? (kindKey === 'compile' ? t('configPanel.runCompiling') : t('configPanel.runRunning'))
              : ok
              ? (kindKey === 'compile' ? t('configPanel.runCompileOk') : t('configPanel.runOk'))
              : t('configPanel.runFailed', { label: meta.label, exit: crawl.exitCode != null ? t('configPanel.exitSuffix', { code: crawl.exitCode }) : '' })
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
            <Icon name="x" size={13} /> {t('configPanel.stopCrawl')}
          </button>
        </div>
      )}

      {ok && (
        <div className="run-result ok">
          <div className="rt">
            <Icon name="check" size={15} /> {kindKey === 'compile' ? t('configPanel.resultDoneCompile', { label: meta.label }) : t('configPanel.resultDone', { label: meta.label })}
          </div>
          {kindKey === 'projectmat' && (
            <div className="fix-text" style={{ color: 'var(--text-dim)' }}>
              {t('configPanel.resultProjectmatNote')}
            </div>
          )}
          {kindKey === 'compile' && (
            <div className="fix-text" style={{ color: 'var(--text-dim)' }}>
              {t('configPanel.resultCompileNote')}
            </div>
          )}
        </div>
      )}

      {crawl.status === 'error' && (
        <div className="run-result err">
          <div className="errtop">
            <div className="rt">
              <Icon name="warn" size={15} /> {t('configPanel.runFailed', { label: meta.label, exit: crawl.exitCode != null ? t('configPanel.exitSuffix', { code: crawl.exitCode }) : '' })}
            </div>
            {crawl.logs.length > 0 && (
              <button className="copylogbtn" onClick={() => void copyErrorLog()}>
                <Icon name={copiedLog ? 'check' : 'clip'} size={12} />
                {copiedLog ? t('configPanel.copied') : t('configPanel.copyErrorLog')}
              </button>
            )}
          </div>
          {diag ? (
            <>
              <div className="cause">{diag.cause}</div>
              <div>
                <span className={'fixpill ' + (diag.who === 'you' ? 'self' : 'maint')}>
                  <Icon name={diag.who === 'you' ? 'check' : 'warn'} size={11} />
                  {diag.who === 'you' ? t('configPanel.fixSelf') : t('configPanel.fixMaint')}
                </span>
              </div>
              <div className="fix-text">{diag.fix}</div>
            </>
          ) : (
            <div className="cause">{t('configPanel.causeUnknown')}</div>
          )}
          {crawl.logs.length > 0 && (
            <details className="logdetails">
              <summary>
                <Icon name="caret" size={12} className="caret" /> {t('configPanel.fullLog')}
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
              <Icon name="refresh" size={13} /> {t('configPanel.retry')}
            </button>
          )}
          <button className="btn" style={{ flex: 1, justifyContent: 'center' }} onClick={onReset}>
            {t('configPanel.backToCrawl')}
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
// label resolved at render via t('configPanel.searchBackend_<key>').
const SEARCH_BACKEND_OPTIONS = [
  { value: 'auto',       key: 'auto' },
  { value: 'duckduckgo', key: 'duckduckgo' },
  { value: 'tavily',     key: 'tavily' },
  { value: 'brave',      key: 'brave' },
  { value: 'searxng',    key: 'searxng' },
];

// 最大迭代次數 choices — value is what gets stored (0 = unlimited).
const MAX_ITERS_OPTIONS = [
  { value: '8',  key: 'iters8' },
  { value: '16', key: 'iters16' },
  { value: '32', key: 'iters32' },
  { value: '0',  key: 'iters0' },
];

// 上下文長度 choices — tokens; '' = use the loop defaults (300K 上限 / 150K 壓縮).
const CONTEXT_LIMIT_OPTIONS = [
  { value: '',        key: 'ctxDefault' },
  { value: '128000',  key: 'ctx128' },
  { value: '200000',  key: 'ctx200' },
  { value: '256000',  key: 'ctx256' },
  { value: '1000000', key: 'ctx1m' },
];

function AiSection({ saveAgentConfig }: AiSectionProps) {
  const { t } = useTranslation();
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
      setMsg({ ok: true, text: t('configPanel.aiSaved') });
      setApiKey(''); // Clear after save to avoid accidental re-submission.
      setTavilyKey('');
      setBraveKey('');
      // Refresh status after save.
      try {
        const s = await fetch('/api/agent/status', { cache: 'no-store' });
        if (s.ok) setStatus(await s.json() as ProviderStatus);
      } catch { /* ignore */ }
    } else {
      setMsg({ ok: false, text: r.error ?? t('configPanel.saveFailed') });
    }
  };

  const onWebTest = async () => {
    setWebTesting(true);
    setWebTestResult(null);
    try {
      const r = await fetch('/api/agent/web-test', { method: 'POST', cache: 'no-store' });
      if (!r.ok) {
        setWebTestResult({ ok: false, text: t('configPanel.testReqFailedHttp', { status: r.status }) });
        return;
      }
      const body = await r.json() as import('./agent/protocol').AgentWebTestResponse;
      setWebTestResult(body.ok
        ? { ok: true, text: t('configPanel.webTestOk', { backend: body.backend, results: body.results }) }
        : { ok: false, text: body.error });
    } catch {
      setWebTestResult({ ok: false, text: t('configPanel.testReqFailed') });
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
        setTestResult({ ok: false, text: t('configPanel.testReqFailedHttp', { status: r.status }) });
        return;
      }
      const body = await r.json() as import('./agent/protocol').AgentTestResponse;
      setTestResult(body.ok
        ? { ok: true, text: t('configPanel.testConnOk', { model: body.model }) }
        : { ok: false, text: body.error });
    } catch {
      setTestResult({ ok: false, text: t('configPanel.testReqFailed') });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="cfg-sec">
      <div className="sech">
        <span className="secn">4</span>
        <span className="sect">{t('configPanel.aiTitle')}</span>
        <span className="secd">{t('configPanel.aiHint')}</span>
      </div>

      {/* Saved-config status card. The key itself is never echoed — only whether one is stored. */}
      <div className={'ai-card' + (status?.configured ? '' : ' uncfg')}>
        {status?.configured ? (
          <>
            <div className="ai-card-head">
              <Icon name="check" size={12} /> {t('configPanel.configured')}
            </div>
            <div className="ai-row"><span className="k">Provider</span><span className="v">{status.provider}</span></div>
            <div className="ai-row"><span className="k">Model</span><span className="v">{status.model}</span></div>
            {status.baseUrl && (
              <div className="ai-row"><span className="k">Base URL</span><span className="v">{status.baseUrl}</span></div>
            )}
            <div className="ai-row">
              <span className="k">API Key</span>
              <span className="v">{status.hasApiKey ? t('configPanel.apiKeyStored') : t('configPanel.apiKeyUnset')}</span>
            </div>
            {status.maxIters !== undefined && (
              <div className="ai-row">
                <span className="k">{t('configPanel.itersLimit')}</span>
                <span className="v">{status.maxIters === 0 ? t('configPanel.unlimited') : status.maxIters}</span>
              </div>
            )}
            {status.contextLimit !== undefined && (
              <div className="ai-row">
                <span className="k">{t('configPanel.context')}</span>
                <span className="v">{status.contextLimit >= 1_000_000 ? `${status.contextLimit / 1_000_000}M` : `${Math.round(status.contextLimit / 1000)}K`} tokens</span>
              </div>
            )}
            {status.webSearchBackend && (
              <div className="ai-row">
                <span className="k">{t('configPanel.searchBackendLabel')}</span>
                <span className="v">
                  {status.webSearchBackend}
                  {status.hasTavilyKey ? ' · tavily✓' : ''}
                  {status.hasBraveKey ? ' · brave✓' : ''}
                  {status.searxngBaseUrl ? ' · searxng✓' : ''}
                  {status.webProxyUrl ? t('configPanel.proxyMark') : ''}
                </span>
              </div>
            )}
            <div className="ai-test-row">
              <button className="btn sm" disabled={testing} onClick={() => void onTest()}>
                {testing
                  ? <><Icon name="refresh" size={12} className="spin" /> {t('configPanel.testing')}</>
                  : <><Icon name="bolt" size={12} /> {t('configPanel.testConnection')}</>}
              </button>
              {testResult && (
                <span className={'ai-test-result ' + (testResult.ok ? 'ok' : 'err')}>{testResult.text}</span>
              )}
            </div>
          </>
        ) : (
          <div className="ai-card-head">
            <Icon name="warn" size={12} /> {t('configPanel.aiUnconfigured')}
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
            {provider === 'anthropic' ? t('configPanel.baseUrlHintAnthropic') : t('configPanel.baseUrlHintOpenai')}
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
        <label>API Key <span style={{ color: 'var(--text-mute)' }}>{t('configPanel.apiKeyHint')}</span></label>
        <div className="inp">
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            autoComplete="off"
            placeholder={t('configPanel.apiKeyPlaceholder')}
          />
        </div>
      </div>

      <div className="field">
        <label>Max Tokens <span style={{ color: 'var(--text-mute)' }}>{t('configPanel.maxTokensHint')}</span></label>
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
          {t('configPanel.maxItersLabel')}{' '}
          <span style={{ color: 'var(--text-mute)' }}>{t('configPanel.maxItersHint')}</span>
        </label>
        <div className="inp">
          <select value={maxIters} onChange={e => setMaxIters(e.target.value)}>
            {MAX_ITERS_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{t(`configPanel.opt_${o.key}`)}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label>
          {t('configPanel.contextLenLabel')}{' '}
          <span style={{ color: 'var(--text-mute)' }}>{t('configPanel.contextLenHint')}</span>
        </label>
        <div className="inp">
          <select value={contextLimit} onChange={e => setContextLimit(e.target.value)}>
            {CONTEXT_LIMIT_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{t(`configPanel.opt_${o.key}`)}</option>
            ))}
          </select>
        </div>
      </div>

      {/* ── 網路搜尋（web_search 後端 / 代理）── */}
      <div className="field">
        <label>
          {t('configPanel.searchBackendField')}{' '}
          <span style={{ color: 'var(--text-mute)' }}>{t('configPanel.searchBackendFieldHint')}</span>
        </label>
        <div className="inp">
          <select value={searchBackend} onChange={e => setSearchBackend(e.target.value)}>
            {SEARCH_BACKEND_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{t(`configPanel.searchBackend_${o.key}`)}</option>
            ))}
          </select>
        </div>
      </div>

      {(searchBackend === 'auto' || searchBackend === 'tavily') && (
        <div className="field">
          <label>Tavily API Key <span style={{ color: 'var(--text-mute)' }}>{t('configPanel.tavilyKeyHint')}</span></label>
          <div className="inp">
            <input
              type="password"
              value={tavilyKey}
              onChange={e => setTavilyKey(e.target.value)}
              autoComplete="off"
              placeholder={status?.hasTavilyKey ? t('configPanel.keyStoredPlaceholder') : 'tvly-…'}
            />
          </div>
        </div>
      )}

      {(searchBackend === 'auto' || searchBackend === 'brave') && (
        <div className="field">
          <label>Brave API Key <span style={{ color: 'var(--text-mute)' }}>{t('configPanel.braveKeyHint')}</span></label>
          <div className="inp">
            <input
              type="password"
              value={braveKey}
              onChange={e => setBraveKey(e.target.value)}
              autoComplete="off"
              placeholder={status?.hasBraveKey ? t('configPanel.keyStoredPlaceholder') : 'BSA…'}
            />
          </div>
        </div>
      )}

      {(searchBackend === 'auto' || searchBackend === 'searxng') && (
        <div className="field">
          <label>SearXNG Base URL <span style={{ color: 'var(--text-mute)' }}>{t('configPanel.searxngHint')}</span></label>
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
        <label>{t('configPanel.proxyLabel')} <span style={{ color: 'var(--text-mute)' }}>{t('configPanel.proxyHint')}</span></label>
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
          title={t('configPanel.webTestTitle')}
        >
          {webTesting
            ? <><Icon name="refresh" size={12} className="spin" /> {t('configPanel.searching')}</>
            : <><Icon name="globe" size={12} /> {t('configPanel.testSearch')}</>}
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
        <Icon name="check" size={13} /> {saving ? t('configPanel.saving') : t('configPanel.saveAiConfig')}
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
  const { t, i18n } = useTranslation();
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
          <div className="nt">{t('configPanel.snapshotTitle')}</div>
          <div className="nd">
            {t('configPanel.snapshotBody')}
          </div>
        </div>
        <div className="cfg-sec">
          <div className="field">
            <label>MF content root <span style={{ color: 'var(--text-mute)' }}>{t('configPanel.mfRootSnapshotHint')}</span></label>
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
            {t('configPanel.connecting')}
            <div className="note" style={{ marginTop: 6 }}>
              connecting to local viewer server · 127.0.0.1
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── team mode, member role: my-account self service + an admin-managed note ──
  if (state.auth?.mode === 'team' && state.auth.role !== 'admin') {
    return (
      <div className="cfg">
        <MyAccountSection />
        <div className="cfg-notice">
          <div className="ni"><Icon name="settings" size={20} /></div>
          <div className="nt">{t('configPanel.memberNoticeTitle')}</div>
          <div className="nd">
            {t('configPanel.memberNoticeBody')}
            {crawl.status === 'running' && ' ' + t('configPanel.memberCrawlRunning')}
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
        {([['crawl', t('configPanel.tabCrawl')], ['ai', t('configPanel.tabAi')], ['team', t('configPanel.tabTeam')]] as const).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={cfgTab === k}
            className={'cfg-tab' + (cfgTab === k ? ' on' : '')}
            onClick={() => setCfgTab(k as 'crawl' | 'ai' | 'team')}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Local UI-language preference. Stays user-changeable even in Team mode —
          Team only provides a default; this local override always wins. */}
      <div className="field" style={{ marginTop: 8 }}>
        <label>
          {t('configPanel.uiLanguage')}{' '}
          <span style={{ color: 'var(--text-mute)' }}>{t('configPanel.uiLanguageHint')}</span>
        </label>
        <div className="lang-seg" role="group" aria-label={t('configPanel.uiLanguage')}>
          {([['zh-Hant', '繁體中文'], ['en', 'English']] as const).map(([lng, label]) => (
            <button
              key={lng}
              className={'btn sm' + (i18n.language === lng ? ' primary' : '')}
              aria-pressed={i18n.language === lng}
              onClick={() => {
                localStorage.setItem('ui-language', lng);
                void i18n.changeLanguage(lng);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {cfgTab === 'crawl' && (
        <>
          <PathsSection
            saveConfig={saveConfig}
            initialProjectPath={env?.projectPath ?? ''}
            initialEngineRoot={env?.engineRoot ?? ''}
            allowBrowse={state.auth?.mode !== 'team'}
          />
          <EnvSection env={env} refreshEnv={() => void refreshEnv()} onCompile={() => onStart('compile')} />
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
          {state.auth?.mode === 'team' && state.auth.role === 'admin' && <ProposalInboxSection />}
          {state.auth?.mode === 'team' && state.auth.role === 'admin' && <UserAdminSection />}
          {state.auth?.mode === 'team' && state.auth.role === 'admin' && <TeamUsageSection />}
          {state.auth?.mode === 'team' && state.auth.authed && <MyAccountSection />}
        </>
      )}
    </div>
  );
}

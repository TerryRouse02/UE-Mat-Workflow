// web/src/agent/AgentChat.tsx — 4th Sidebar tab: conversational material agent UI.
//
// Scope (M3+M4+M7): streamed narrative text + grouped tool steps + diff blocks
// + thinking cards + cumulative usage + persistent sessions (list / switch /
// delete / replay) + input box with stop/undo + unconfigured-state guidance +
// empty-state example prompts. NodeExplainPopover (M5) is NOT implemented here.
//
// Hidden when connection === 'snapshot' (same as ConfigPanel).
//
// Item-building rules live in transcript.ts (pure reducer) — the live SSE
// stream and persisted-transcript replay share ONE implementation. This file
// keeps only the side effects: fetches, the SSE pump, opening written graphs.

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store';
import { Icon } from '../Icon';
import { streamChat } from './sse';
import { relTimeMinutes } from '../timeUtils';
import type {
  AgentThinkingLevel,
  ProviderStatus,
  AgentUndoResponse,
  AgentRedoResponse,
  AgentRegenerateResponse,
  AgentDbEditResponse,
  AgentSessionMeta,
  AgentSessionsListResponse,
  AgentSessionCreateResponse,
  AgentSessionDetail,
} from './protocol';
import {
  type ChatItem,
  type ToolGroup,
  type NoticeLine,
  type DiffBlock,
  type ThinkingItem,
  type CrawlProposal,
  type DbEditProposal,
  type ApprovalRequest,
  type SystemReport,
  type UsageTotal,
  newTurnFlags,
  startUserTurn,
  applyAgentEvent,
  accumulateUsage,
  reduceTranscript,
  transcriptToMarkdown,
} from './transcript';
import './agent.css';

// ─── Example prompts ─────────────────────────────────────────────────────────

// i18n keys for the empty-state example prompts (labels translated at render).
const EXAMPLE_PROMPT_KEYS = ['examplePromptEmissive', 'examplePromptSnow', 'examplePromptPbr'] as const;

// Thinking-level select labels are translated at render via t('agentChat.thinking<Level>').
const THINKING_LEVELS: AgentThinkingLevel[] = ['off', 'low', 'medium', 'high'];
const THINKING_LABEL_KEYS: Record<AgentThinkingLevel, string> = {
  off: 'thinkingOff', low: 'thinkingLow', medium: 'thinkingMedium', high: 'thinkingHigh',
};
const THINKING_STORAGE_KEY = 'agent-thinking-level';
/** 🌐 switch persistence — anything but 'off' means on (default on). */
const WEB_SEARCH_STORAGE_KEY = 'agent-web-search';
/** Write-approval mode persistence ('skip' | 'review'); anything but 'skip' = review (default). */
const APPROVAL_MODE_STORAGE_KEY = 'agent-approval-mode';

// ─── Quick commands (⚡ menu / slash input) ──────────────────────────────────

interface QuickCommand {
  cmd: string;                                   // slash form, e.g. "/validate"
  labelKey: string;                              // i18n key suffix (agentChat.<labelKey>)
  kind: 'send' | 'regen' | 'undo' | 'redo' | 'md' | 'new' | 'crawlmf';
  textKey?: string;                              // i18n key suffix for the canned prompt
}

const QUICK_COMMANDS: QuickCommand[] = [
  { cmd: '/validate', labelKey: 'cmdValidateLabel', kind: 'send', textKey: 'cmdValidateText' },
  { cmd: '/explain',  labelKey: 'cmdExplainLabel',  kind: 'send', textKey: 'cmdExplainText' },
  { cmd: '/export',   labelKey: 'cmdExportLabel',   kind: 'send', textKey: 'cmdExportText' },
  { cmd: '/compact',  labelKey: 'cmdCompactLabel',  kind: 'send', textKey: 'cmdCompactText' },
  { cmd: '/log',      labelKey: 'cmdLogLabel',      kind: 'send', textKey: 'cmdLogText' },
  { cmd: '/help',     labelKey: 'cmdHelpLabel',     kind: 'send', textKey: 'cmdHelpText' },
  { cmd: '/regen',    labelKey: 'cmdRegenLabel',    kind: 'regen' },
  { cmd: '/undo',     labelKey: 'cmdUndoLabel',     kind: 'undo' },
  { cmd: '/redo',     labelKey: 'cmdRedoLabel',     kind: 'redo' },
  { cmd: '/md',       labelKey: 'cmdMdLabel',       kind: 'md' },
  { cmd: '/new',      labelKey: 'cmdNewLabel',      kind: 'new' },
  { cmd: '/crawlmf',  labelKey: 'cmdCrawlmfLabel',  kind: 'crawlmf' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function sessionLabel(s: AgentSessionMeta, untitled: string): string {
  const title = s.title || untitled;
  // Team mode: the admin's list spans every member — prefix the owner.
  const owned = s.owner ? `[${s.owner}] ${title}` : title;
  return s.updatedAt ? `${owned} · ${relTimeMinutes(s.updatedAt)}` : owned;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ToolGroupView({ item, onToggle }: { item: ToolGroup; onToggle: () => void }) {
  const { t } = useTranslation();
  const running = item.steps.some(s => !s.done);
  const anyErr = item.steps.some(s => s.done && s.ok === false);
  // Collapsed state is authoritative: a live group is collapsed:false (so it
  // shows progress), and once the turn ends / a new turn starts the reducer sets
  // collapsed:true. Don't let a step stuck mid-run (an interrupted turn that
  // never got its tool_end) keep the group expanded after it was folded.
  const open = !item.collapsed;
  const lastStep = item.steps[item.steps.length - 1];

  return (
    <div className={'agent-tools agent-item' + (open ? ' open' : '')}>
      <button type="button" className="agent-tools-head" onClick={onToggle}>
        <Icon name="caret" size={12} className="caret" />
        {running ? (
          <>
            <Icon name="refresh" size={12} className="spin run-ico" />
            <span>{lastStep?.summary}</span>
          </>
        ) : (
          <>
            <Icon name={anyErr ? 'warn' : 'check'} size={12} className={anyErr ? 'warn-ico' : 'ok-ico'} />
            <span>{t('agentChat.runSteps', { n: item.steps.length })}</span>
          </>
        )}
      </button>
      {open && (
        <div className="agent-tools-steps">
          {item.steps.map((s, i) => (
            <div key={i} className={'agent-tool ' + (!s.done ? 'running' : s.ok ? 'ok' : 'err')}>
              <Icon name={!s.done ? 'refresh' : s.ok ? 'check' : 'x'} size={12} className={!s.done ? 'spin' : undefined} />
              <span className="agent-tool-name">{s.done ? (s.endSummary ?? s.summary) : s.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NoticeItem({ item }: { item: NoticeLine }) {
  const iconName = item.variant === 'info' ? 'check' : 'warn';
  return (
    <div className={'agent-notice agent-item ' + item.variant}>
      <Icon name={iconName} size={12} />
      <span>{item.message}</span>
    </div>
  );
}

/** Collapsible reasoning card — live 思考中… while streaming, 思考過程 after. */
function ThinkingView({ item, live, onToggle }: { item: ThinkingItem; live: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const open = !item.collapsed;
  // While streaming, keep the inner scroller pinned to the newest text — the
  // box is height-capped (max-height) so without this the tail streams out
  // of view. Once live ends the user scrolls freely.
  const textRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = textRef.current;
    if (live && open && el) el.scrollTop = el.scrollHeight;
  }, [item.text, live, open]);
  return (
    <div className={'agent-thinking agent-item' + (open ? ' open' : '')}>
      <button type="button" className="agent-thinking-head" onClick={onToggle}>
        <Icon name="caret" size={11} className="caret" />
        {live
          ? <><Icon name="refresh" size={11} className="spin" /><span className="live">{t('agentChat.thinkingLive')}</span></>
          : <><Icon name="bolt" size={11} /><span>{t('agentChat.thinkingDone', { n: item.text.length })}</span></>}
      </button>
      {open && <div className="agent-thinking-text" ref={textRef}>{item.text}</div>}
    </div>
  );
}

/** System-generated report (crawl outcome) — a collapsed card, not a user
    bubble: the title says what happened, the log tail expands on demand. */
function SystemReportView({ item, onToggle }: { item: SystemReport; onToggle: () => void }) {
  const { t } = useTranslation();
  const open = !item.collapsed;
  return (
    <div className={'agent-sysreport agent-item' + (open ? ' open' : '')}>
      <button type="button" className="agent-sysreport-head" onClick={onToggle}>
        <Icon name="caret" size={11} className="caret" />
        <Icon name="refresh" size={11} />
        <span>{t('agentChat.systemReport', { title: item.title })}</span>
      </button>
      {open && item.detail && <pre className="agent-sysreport-detail">{item.detail}</pre>}
    </div>
  );
}

/** Agent-proposed crawl card — the agent can only PROPOSE; this button is the
    user's approval and goes through the same POST /api/crawl as the Config tab. */
function CrawlProposalView({ item, crawl, onApprove }: {
  item: CrawlProposal;
  crawl: { status: string; kind: string | null };
  onApprove: () => void;
}) {
  const { t } = useTranslation();
  const kindLabel = item.crawlKind === 'workmf' ? t('agentChat.crawlKindWorkmf') : t('agentChat.crawlKindMaterials');
  const running = crawl.status === 'running';
  return (
    <div className="agent-crawl-proposal agent-item">
      <div className="agent-crawl-title">
        <Icon name="refresh" size={12} /> {t('agentChat.crawlRequest', { kind: kindLabel, root: item.contentRoot })}
      </div>
      <div className="agent-crawl-note">{t('agentChat.crawlNote')}</div>
      {item.resolved
        ? <div className="agent-crawl-resolved">{running ? t('agentChat.crawlRunning') : t('agentChat.crawlHandled')}</div>
        : (
          <button className="agent-crawl-approve" disabled={running} onClick={onApprove}>
            {running ? t('agentChat.crawlBusyOther') : t('agentChat.crawlStart')}
          </button>
        )}
    </div>
  );
}

/** Write-approval card (review mode) — the agent paused before a graph
    mutation; the session OWNER approves/rejects via POST /api/agent/approve.
    Self-approval only (never the admin). The server's approval_resolved event
    flips item.resolved through the reducer; this only posts the decision. */
function ApprovalRequestView({ item, sessionId, onError }: {
  item: ApprovalRequest;
  sessionId: string | null;
  onError: (message: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const decide = async (decision: 'approve' | 'reject') => {
    if (!sessionId) { onError(t('agentChat.approveNoSession')); return; }
    setBusy(true);
    try {
      const r = await fetch('/api/agent/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          requestId: item.id,
          decision,
          reason: decision === 'reject' && reason.trim() ? reason.trim() : undefined,
        }),
        cache: 'no-store',
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        onError(b.error ?? `HTTP ${r.status}`);
        setBusy(false);
      }
      // On success the server resumes the turn and emits approval_resolved,
      // which flips item.resolved — leave the card in its busy state until then.
    } catch {
      onError(t('agentChat.approveRequestFailed'));
      setBusy(false);
    }
  };

  const auto = item.mode === 'auto';
  const icon = auto ? 'bolt' : 'lock';

  if (item.resolved) {
    const base = item.decision === 'approved'
      ? (auto ? t('agentChat.approveAutoApproved') : t('agentChat.approveApproved'))
      : item.decision === 'timeout'
        ? t('agentChat.approveTimeout')
        : (auto ? t('agentChat.approveAutoRejected') : t('agentChat.approveRejected'));
    const sep = i18n.language?.startsWith('en') ? ': ' : '：';
    const label = item.decision === 'rejected' && item.reason ? `${base}${sep}${item.reason}` : base;
    return (
      <div className="agent-approval agent-item resolved">
        <div className="agent-approval-title"><Icon name={icon} size={12} /> {item.summary}</div>
        <div className="agent-approval-resolved">{label}</div>
      </div>
    );
  }

  // Auto mode: the LLM judge is deciding — informational card, no buttons.
  if (auto) {
    return (
      <div className="agent-approval agent-item auto">
        <div className="agent-approval-title"><Icon name="bolt" size={12} /> {t('agentChat.approveAutoJudging')}</div>
        <div className="agent-approval-summary">{item.summary}</div>
      </div>
    );
  }

  return (
    <div className="agent-approval agent-item">
      <div className="agent-approval-title"><Icon name="lock" size={12} /> {t('agentChat.approveTitle')}</div>
      <div className="agent-approval-summary">{item.summary}</div>
      {item.diff && item.diff.length > 0 && (
        <ul className="agent-approval-diff">
          {item.diff.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      )}
      <input
        className="agent-approval-reason"
        placeholder={t('agentChat.approveReasonPlaceholder')}
        value={reason}
        onChange={e => setReason(e.target.value)}
        disabled={busy}
      />
      <div className="agent-approval-actions">
        <button className="agent-approval-approve" disabled={busy} onClick={() => void decide('approve')}>
          {busy ? t('agentChat.approveWorking') : t('agentChat.approveApprove')}
        </button>
        <button className="agent-approval-reject" disabled={busy} onClick={() => void decide('reject')}>
          {t('agentChat.approveReject')}
        </button>
      </div>
    </div>
  );
}

/** One-line summary per patched DB field, shown on the approval card. */
function dbPatchSummary(patch: Record<string, unknown>, t: (key: string, opts?: Record<string, unknown>) => string): string[] {
  return Object.entries(patch).map(([k, v]) => {
    if (k === 'description') return t('agentChat.dbPatchDescription', { v: `${String(v).slice(0, 120)}${String(v).length > 120 ? '…' : ''}` });
    if (k === 'category') return t('agentChat.dbPatchCategory', { v: String(v) });
    if (k === 'verified') return t('agentChat.dbPatchVerified', { v: String(v) });
    if (Array.isArray(v)) return t('agentChat.dbPatchArray', { k, n: v.length });
    return t('agentChat.dbPatchGeneric', { k, v: JSON.stringify(v) });
  });
}

/** Agent-proposed node-DB edit card — same approval model as CrawlProposalView:
    the agent only PROPOSES; this button calls POST /api/agent/db-edit, which
    applies + regenerates the index + runs the parity audit (rollback on fail). */
function DbEditProposalView({ item, onResolve }: {
  item: DbEditProposal;
  onResolve: (notice: { variant: 'info' | 'error'; message: string }) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const approve = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/agent/db-edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ueVersion: item.ueVersion, nodeName: item.nodeName, patch: item.patch, create: item.create }),
        cache: 'no-store',
      });
      const body = (r.ok ? await r.json() : { ok: false, error: `HTTP ${r.status}` }) as AgentDbEditResponse;
      if (body.ok) {
        onResolve({
          variant: 'info',
          message: item.create
            ? t('agentChat.dbEditCreated', { node: item.nodeName })
            : t('agentChat.dbEditUpdated', { node: item.nodeName, keys: body.changedKeys.join(t('common.listSep')) }),
        });
      } else {
        onResolve({ variant: 'error', message: t('agentChat.dbEditFailed', { error: body.error }) });
      }
    } catch {
      onResolve({ variant: 'error', message: t('agentChat.dbEditRequestFailed') });
    }
  };
  return (
    <div className="agent-crawl-proposal agent-item">
      <div className="agent-crawl-title">
        <Icon name="hash" size={12} /> {t(item.create ? 'agentChat.dbProposeCreate' : 'agentChat.dbProposeModify', { node: item.nodeName, ue: item.ueVersion })}
      </div>
      {item.create && (
        <div className="agent-crawl-note">
          {t('agentChat.dbCreateNotePre')}<b>verified:false</b>{t('agentChat.dbCreateNotePost')}
        </div>
      )}
      <ul className="agent-dbedit-lines">
        {dbPatchSummary(item.patch, t).map((l, i) => <li key={i}>{l}</li>)}
      </ul>
      {item.rationale && <div className="agent-crawl-note">{t('agentChat.dbRationale', { rationale: item.rationale })}</div>}
      <div className="agent-crawl-note">
        {t('agentChat.dbPublicNotePre', { ue: item.ueVersion })}<b>{t('agentChat.dbPublicNoteBold')}</b>{t('agentChat.dbPublicNotePost')}
      </div>
      {item.pendingApproval
        ? <div className="agent-crawl-resolved">{t('agentChat.dbPendingApproval')}</div>
        : item.resolved
        ? <div className="agent-crawl-resolved">{t('agentChat.crawlHandled')}</div>
        : (
          <button className="agent-crawl-approve" disabled={busy} onClick={() => void approve()}>
            {busy ? t('agentChat.dbApplying') : t('agentChat.dbApply')}
          </button>
        )}
    </div>
  );
}

/** Collapsible block listing plain-language diff lines after a successful write. */
function DiffBlockView({ item, onToggle }: { item: DiffBlock; onToggle: () => void }) {
  const { t } = useTranslation();
  const open = !item.collapsed;
  return (
    <div className={'agent-diff agent-item' + (open ? ' open' : '')}>
      <button type="button" className="agent-diff-header" onClick={onToggle}>
        <Icon name="caret" size={11} className="caret" />
        <Icon name="hash" size={11} />
        <span>{t('agentChat.diffSummary', { n: item.lines.length })}</span>
      </button>
      {open && (
        <ul className="agent-diff-lines">
          {item.lines.map((line, i) => (
            <li key={i} className="agent-diff-line">{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── AgentChat ────────────────────────────────────────────────────────────────

export interface AgentChatProps {
  onGotoConfig(): void;
  /**
   * Whether the Agent tab is the visible one. The component stays MOUNTED
   * while hidden (Sidebar keep-alive) so the crawl-report loop and in-flight
   * streams survive tab switches; active only drives scroll + the unseen cue.
   */
  active?: boolean;
}

export function AgentChat({ onGotoConfig, active = true }: AgentChatProps) {
  const { t, i18n } = useTranslation();
  // The UI language to ask the agent to reply in (the catalog only has these two).
  const language: 'zh-Hant' | 'en' = i18n.language === 'en' ? 'en' : 'zh-Hant';
  const { state, open, highlightNodes, requestAgentExport, startCrawl, bumpMetadata, setAgentActivity } = useStore();
  const { connection, currentPath, selectedNodeId } = state;

  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [usage, setUsage] = useState<UsageTotal | null>(null);
  const [sessions, setSessions] = useState<AgentSessionMeta[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  // Whether a redo is currently available (set by undo/redo responses; cleared
  // by any fresh turn — send / regenerate / new / switch — which forks history).
  const [canRedo, setCanRedo] = useState(false);
  // Per-turn reasoning effort; persisted so the choice survives reloads.
  const [thinking, setThinking] = useState<AgentThinkingLevel>(() => {
    try {
      const v = localStorage.getItem(THINKING_STORAGE_KEY);
      return v === 'low' || v === 'medium' || v === 'high' ? v : 'off';
    } catch { return 'off'; }
  });
  // 🌐 per-turn web-tools switch. Default ON: the prompt makes the model judge
  // timeliness before answering. OFF removes web_search/web_fetch server-side.
  const [webOn, setWebOn] = useState<boolean>(() => {
    try { return localStorage.getItem(WEB_SEARCH_STORAGE_KEY) !== 'off'; } catch { return true; }
  });
  // Write-approval mode (per-turn, persisted). 'review' (default) pauses every
  // graph mutation for the user to approve; 'auto' lets an LLM judge decide;
  // 'skip' applies writes immediately.
  const [approvalMode, setApprovalMode] = useState<'skip' | 'review' | 'auto'>(() => {
    try {
      const v = localStorage.getItem(APPROVAL_MODE_STORAGE_KEY);
      return v === 'skip' ? 'skip' : v === 'auto' ? 'auto' : 'review';
    } catch { return 'review'; }
  });
  // Team-mode admin lock: a member's thinking/🌐 controls are forced to the
  // admin-set values and grayed out (the server enforces them regardless).
  const memberLock = state.auth?.mode === 'team' && state.auth.role !== 'admin'
    ? state.auth.memberLock
    : undefined;
  const effThinking = memberLock ? memberLock.thinking : thinking;
  const effWebOn = memberLock ? memberLock.webSearch : webOn;
  // Images pasted into the input, awaiting the next send (base64, no prefix).
  const [pendingImages, setPendingImages] = useState<Array<{ mediaType: string; data: string }>>([]);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // One-shot jump-to-bottom: set when a session's items are (re)loaded — on
  // mount (tab switch) or session switch — so the view starts at the latest
  // message instead of the top. Live streaming keeps the near-bottom rule.
  const jumpToBottomRef = useRef(false);

  // Fetch /api/agent/status on mount and after config saves.
  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const r = await fetch('/api/agent/status', { cache: 'no-store' });
      if (r.ok) setStatus(await r.json() as ProviderStatus);
      else setStatus({ configured: false });
    } catch {
      setStatus({ configured: false });
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => { void fetchStatus(); }, [fetchStatus]);

  // ── Session management (M7) ────────────────────────────────────────────────

  const fetchSessions = useCallback(async (): Promise<AgentSessionMeta[]> => {
    try {
      const r = await fetch('/api/agent/sessions', { cache: 'no-store' });
      if (!r.ok) return [];
      const body = await r.json() as AgentSessionsListResponse;
      setSessions(body.sessions);
      return body.sessions;
    } catch {
      return [];
    }
  }, []);

  const loadSession = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/agent/sessions/${id}`, { cache: 'no-store' });
      if (!r.ok) return;
      const detail = await r.json() as AgentSessionDetail;
      const { items: reduced, usage: total } = reduceTranscript(detail.transcript);
      jumpToBottomRef.current = true;
      setItems(reduced);
      setUsage(total);
      setSessionId(id);
      // Switching sessions: the new session's redo availability is unknown
      // until its next undo — start hidden rather than show a stale button.
      setCanRedo(false);
    } catch { /* keep the current view */ }
  }, []);

  // A server-injected（系統回報）landed in THIS session (approval outcome) —
  // re-fetch the transcript so the member sees it without a manual reload.
  // Never mid-stream: the SSE turn owns the view until it finishes.
  const lastBumpRef = useRef(0);
  useEffect(() => {
    const bump = state.sessionBump;
    if (!bump || bump.version === lastBumpRef.current) return;
    lastBumpRef.current = bump.version;
    if (!streaming && sessionId !== null && bump.id === sessionId) void loadSession(sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.sessionBump]);

  // On mount: list sessions and restore the most recent one — a page reload
  // continues the conversation instead of silently inheriting it server-side.
  useEffect(() => {
    void (async () => {
      const list = await fetchSessions();
      if (list.length > 0) await loadSession(list[0].id);
    })();
  }, [fetchSessions, loadSession]);

  const handleNewSession = useCallback(async () => {
    if (streaming) return;
    try {
      const r = await fetch('/api/agent/sessions', { method: 'POST', cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      const { id } = await r.json() as AgentSessionCreateResponse;
      setSessionId(id);
      setSessions(prev => [
        { id, title: '', createdAt: '', updatedAt: '', ueVersion: '', totalTokens: 0, turns: 0 },
        ...prev,
      ]);
    } catch {
      // Endpoint unavailable — still clear the view; the next send creates implicitly.
      setSessionId(null);
    }
    setItems([]);
    setUsage(null);
    setCanRedo(false);
  }, [streaming]);

  // Team mode: designate / clear this session as the announcement channel.
  // The server broadcasts `publicAgent` to every client; the store keeps the
  // pointer, so the button label flips without a local round-trip state.
  const togglePublic = useCallback(async () => {
    if (sessionId === null) return;
    const makePublic = state.publicAgent.id !== sessionId;
    try {
      await fetch(`/api/agent/sessions/${sessionId}/public`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ public: makePublic }),
      });
    } catch { /* surfaced by the unchanged button state */ }
  }, [sessionId, state.publicAgent.id]);

  const handleDeleteSession = useCallback(async () => {
    if (streaming || !sessionId) return;
    if (!window.confirm(t('agentChat.deleteConfirm'))) return;
    try {
      await fetch(`/api/agent/sessions/${sessionId}`, { method: 'DELETE', cache: 'no-store' });
    } catch { /* best-effort */ }
    const list = await fetchSessions();
    if (list.length > 0) {
      await loadSession(list[0].id);
    } else {
      setSessionId(null);
      setItems([]);
      setUsage(null);
    }
  }, [streaming, sessionId, fetchSessions, loadSession, t]);

  // ── View helpers ───────────────────────────────────────────────────────────

  // Auto-scroll to bottom when items change — but only when the user is already
  // near the bottom, so scrolling up to re-read is never yanked away.
  // Exception: a freshly loaded session always jumps to the latest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (jumpToBottomRef.current) {
      jumpToBottomRef.current = false;
      el.scrollTop = el.scrollHeight;
      return;
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < 240) el.scrollTop = el.scrollHeight;
  }, [items]);

  // Auto-resize the textarea up to its CSS max-height.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [input]);

  const toggleCollapse = useCallback((index: number) => {
    setItems(prev => prev.map((it, i) =>
      i === index && (it.kind === 'tools' || it.kind === 'diff' || it.kind === 'thinking' || it.kind === 'systemReport')
        ? { ...it, collapsed: !it.collapsed }
        : it,
    ));
  }, []);

  const changeThinking = useCallback((v: AgentThinkingLevel) => {
    setThinking(v);
    try { localStorage.setItem(THINKING_STORAGE_KEY, v); } catch { /* private mode etc. */ }
  }, []);

  const toggleWeb = useCallback(() => {
    setWebOn(prev => {
      const next = !prev;
      try { localStorage.setItem(WEB_SEARCH_STORAGE_KEY, next ? 'on' : 'off'); } catch { /* private mode etc. */ }
      return next;
    });
  }, []);

  const changeApprovalMode = useCallback((v: 'skip' | 'review' | 'auto') => {
    setApprovalMode(v);
    try { localStorage.setItem(APPROVAL_MODE_STORAGE_KEY, v); } catch { /* private mode etc. */ }
  }, []);

  // Abort any in-flight stream on real unmount (e.g. switching into snapshot
  // mode — the Sidebar keep-alive normally keeps this mounted): otherwise the
  // fetch keeps streaming and its handlers setState on an unmounted component.
  useEffect(() => () => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // Stop = abort the local fetch; the server notices the socket close, aborts
  // the run, and releases its single-flight lock immediately, so an instant
  // re-send starts a fresh turn (no 409, undo history intact).
  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleUndo = useCallback(async () => {
    if (streaming) return;
    try {
      const r = await fetch('/api/agent/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sessionId ? { sessionId } : {}),
        cache: 'no-store',
      });
      if (!r.ok) {
        setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: t('agentChat.undoFailedHttp', { status: r.status }) }]);
        return;
      }
      const body = await r.json() as AgentUndoResponse;
      if (body.ok) {
        const count = body.restored.length;
        setCanRedo(body.canRedo);
        setItems(prev => [...prev, {
          kind: 'notice', variant: 'info',
          message: t('agentChat.undoDone', { n: count }),
        }]);
      } else {
        setItems(prev => [...prev, { kind: 'notice', variant: 'info', message: t('agentChat.undoNothing') }]);
      }
    } catch {
      setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: t('agentChat.undoFailed') }]);
    }
  }, [streaming, sessionId, t]);

  const handleRedo = useCallback(async () => {
    if (streaming) return;
    try {
      const r = await fetch('/api/agent/redo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(sessionId ? { sessionId } : {}),
        cache: 'no-store',
      });
      if (!r.ok) {
        setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: t('agentChat.redoFailedHttp', { status: r.status }) }]);
        return;
      }
      const body = await r.json() as AgentRedoResponse;
      if (body.ok) {
        setCanRedo(body.canRedo);
        setItems(prev => [...prev, {
          kind: 'notice', variant: 'info',
          message: t('agentChat.redoDone', { n: body.redone.length }),
        }]);
      } else {
        setCanRedo(false);
        setItems(prev => [...prev, { kind: 'notice', variant: 'info', message: t('agentChat.redoNothing') }]);
      }
    } catch {
      setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: t('agentChat.redoFailed') }]);
    }
  }, [streaming, sessionId, t]);

  // Clipboard images → pending attachments. Plain-text pastes keep the
  // default behaviour (no preventDefault unless an image was actually found).
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter(it => it.kind === 'file' && /^image\/(png|jpeg|webp|gif)$/.test(it.type))
      .map(it => it.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) {
      if (f.size > 5 * 1024 * 1024) continue; // server rejects >5MB decoded
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result ?? '');
        const comma = url.indexOf(',');
        if (comma < 0) return;
        const data = url.slice(comma + 1);
        // Cap at 3 — matches the server-side limit.
        setPendingImages(prev => (prev.length >= 3 ? prev : [...prev, { mediaType: f.type, data }]));
      };
      reader.readAsDataURL(f);
    }
  }, []);

  const handleSend = useCallback(async (text: string) => {
    if (!text.trim() || streaming) return;

    const userText = text.trim();
    // Snapshot + clear the pending images: they belong to THIS message only.
    const sendImages = pendingImages;
    setPendingImages([]);
    setInput('');
    setStreaming(true);
    // A fresh turn forks history: the server clears the redo stack on the next
    // write, so hide the redo button immediately.
    setCanRedo(false);

    // Ensure a persistent session exists; fall back to the server's implicit
    // session when the endpoint is unavailable.
    let sid = sessionId;
    if (!sid) {
      try {
        const r = await fetch('/api/agent/sessions', { method: 'POST', cache: 'no-store' });
        if (r.ok) {
          sid = ((await r.json()) as AgentSessionCreateResponse).id;
          setSessionId(sid);
          setSessions(prev => [
            { id: sid!, title: userText.slice(0, 30), createdAt: '', updatedAt: '', ueVersion: '', totalTokens: 0, turns: 0 },
            ...prev,
          ]);
        }
      } catch { /* implicit session */ }
    }

    setItems(prev => startUserTurn(prev, userText, sendImages.length));

    const ac = new AbortController();
    abortRef.current = ac;
    const flags = newTurnFlags();
    // Off-topic strike limit: the server deletes the session mid-stream; skip
    // the post-turn list refresh — it can race the deletion and briefly
    // resurrect the dead session in the sidebar.
    let sessionClosed = false;

    // Build the request. `language` is now declared on AgentChatRequest;
    // the server reads it to reply in the user's chosen UI language.
    const chatReq = {
      text: userText,
      graphPath: currentPath ?? undefined,
      selectedNodeId: selectedNodeId ?? undefined,
      thinking: effThinking !== 'off' ? effThinking : undefined,
      // Absent = on (the default); only the off state is sent explicitly.
      webSearch: effWebOn ? undefined : false,
      // Write-approval mode for this turn (default 'review' on the server too).
      approvalMode,
      // The UI language the agent should reply in (mirrors the user's
      // localStorage 'ui-language' / team default via i18n.language).
      language,
      images: sendImages.length > 0
        ? sendImages.map(im => ({ mediaType: im.mediaType, data: im.data }))
        : undefined,
      sessionId: sid ?? undefined,
    };

    try {
      for await (const event of streamChat(chatReq, ac.signal)) {
        // Side effects stay here; item building lives in the shared reducer.
        if (event.type === 'graph_written') {
          open(event.path);
          if (event.changedNodeIds?.length) highlightNodes(event.path, event.changedNodeIds);
        }
        if (event.type === 'export_request') {
          open(event.path); // export needs the graph rendered — App completes the copy
          requestAgentExport(event.path);
        }
        if (event.type === 'usage') setUsage(prev => accumulateUsage(prev, event));
        if (event.type === 'session_closed') {
          // The server deleted this session (off-topic strike limit) — drop
          // our binding so the next send starts a fresh session.
          sessionClosed = true;
          setSessionId(null);
          setSessions(prev => prev.filter(s => s.id !== sid));
        }
        setItems(prev => applyAgentEvent(prev, event, flags));
      }
    } catch (e: unknown) {
      if ((e as Error)?.name === 'AbortError') {
        setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: t('agentChat.aborted') }]);
      } else {
        setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: (e as Error)?.message ?? t('agentChat.connError') }]);
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      inputRef.current?.focus();
      // Refresh titles/timestamps after the turn lands on disk — except when
      // the server just deleted the session (the refetch could race the
      // deletion and re-add the dead session; the local filter already removed it).
      if (!sessionClosed) void fetchSessions();
    }
  }, [streaming, currentPath, selectedNodeId, open, effThinking, effWebOn, approvalMode, language, pendingImages, sessionId, fetchSessions, highlightNodes, requestAgentExport, t]);

  // Agent-tab attention cue: pulse while streaming; if a reply finishes while
  // another tab is visible, leave a steady dot until the user opens the tab.
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (streaming) setAgentActivity('busy');
    else if (wasStreamingRef.current) setAgentActivity(active ? 'idle' : 'unseen');
    wasStreamingRef.current = streaming;
  }, [streaming, active, setAgentActivity]);
  const prevActiveRef = useRef(active);
  useEffect(() => {
    if (active && state.agentActivity === 'unseen') setAgentActivity('idle');
    if (active && !prevActiveRef.current) {
      // Heights are zero while the panel is display:none, so any pinned-bottom
      // scroll done off-tab landed at 0 — re-pin once when the tab opens.
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
      // Team mode: other people create sessions while this tab is hidden —
      // refresh the list on every open so the admin's dropdown never goes stale.
      void fetchSessions();
    }
    prevActiveRef.current = active;
  }, [active, state.agentActivity, setAgentActivity, fetchSessions]);

  // Crawl-result feedback loop: a crawl approved from an agent proposal card
  // reports its outcome (status + log tail) back into the conversation once it
  // finishes, so the agent can re-search on success or diagnose the failure
  // itself. Manual Config-tab crawls never report — only ones the agent asked
  // for. Waits for any in-flight stream to end before sending.
  const pendingCrawlReport = useRef<{ kind: string } | null>(null);
  useEffect(() => {
    const c = state.crawl;
    const pending = pendingCrawlReport.current;
    if (!pending || streaming) return;
    if (c.status !== 'success' && c.status !== 'error') return;
    pendingCrawlReport.current = null;
    const tail = c.logs.slice(-30).join('\n').slice(-3000);
    // First line = clean card title; the instruction to the model lives in the
    // collapsed detail so prompt-speak never headlines the conversation.
    const title = c.status === 'success'
      ? t('agentChat.crawlReportDone', { kind: pending.kind })
      : t('agentChat.crawlReportFailed', { kind: pending.kind, exit: c.exitCode ?? '?' });
    const instruction = c.status === 'success'
      ? t('agentChat.crawlReportInstrSuccess')
      : t('agentChat.crawlReportInstrFailure');
    void handleSend(t('agentChat.crawlReportBody', { title, instruction, tail }));
  }, [state.crawl, streaming, handleSend, t]);

  // 問 AI / post-import explain: consume the store's one-shot ask request.
  // Waits for the provider status so an unconfigured agent silently drops it
  // (the guidance panel is already on screen). send=true submits immediately;
  // send=false (or mid-stream) prefills the input instead.
  const consumedAskNonce = useRef(0);
  useEffect(() => {
    const ask = state.agentAsk;
    if (!ask || ask.nonce === consumedAskNonce.current || statusLoading) return;
    consumedAskNonce.current = ask.nonce;
    if (Date.now() - ask.ts > 15_000 || !status?.configured) return;
    if (ask.send && !streaming) {
      void handleSend(ask.text);
    } else {
      setInput(ask.text);
      inputRef.current?.focus();
    }
  }, [state.agentAsk, statusLoading, status, streaming, handleSend]);

  // Regenerate: rewind the last user turn server-side (files + history +
  // transcript), reload the trimmed view, then re-send the same text through
  // the normal chat flow — "try a different take" without retyping.
  const handleRegenerate = useCallback(async () => {
    if (streaming || !sessionId) return;
    // Destructive rewind: the server clears the redo stack — hide redo.
    setCanRedo(false);
    try {
      const r = await fetch('/api/agent/regenerate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
        cache: 'no-store',
      });
      if (!r.ok) {
        setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: t('agentChat.regenFailedHttp', { status: r.status }) }]);
        return;
      }
      const body = await r.json() as AgentRegenerateResponse;
      if (!body.ok) {
        setItems(prev => [...prev, { kind: 'notice', variant: 'info', message: t('agentChat.regenNothing') }]);
        return;
      }
      await loadSession(sessionId);
      await handleSend(body.text);
    } catch {
      setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: t('agentChat.regenFailed') }]);
    }
  }, [streaming, sessionId, loadSession, handleSend, t]);

  // Download the conversation as a Markdown file (pure client-side).
  const downloadMarkdown = useCallback(() => {
    const title = sessions.find(s => s.id === sessionId)?.title || undefined;
    const md = transcriptToMarkdown(items, { title, provider: status?.provider, model: status?.model });
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `agent-${sessionId ?? 'session'}-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, [items, sessions, sessionId, status]);

  // ── Quick commands (⚡) — canned prompts + local actions ───────────────────
  const [quickOpen, setQuickOpen] = useState(false);
  useEffect(() => {
    if (!quickOpen) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement | null)?.closest('.agent-quick')) setQuickOpen(false);
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setQuickOpen(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [quickOpen]);

  // Hidden in snapshot mode.
  if (connection === 'snapshot') return null;

  // Loading state.
  if (statusLoading) {
    return (
      <div className="agent-panel">
        <div className="agent-loading">
          <Icon name="refresh" size={16} className="spin" style={{ color: 'var(--accent)' }} />
          <span>{t('agentChat.loading')}</span>
        </div>
      </div>
    );
  }

  // Unconfigured state: guide user to Config tab.
  if (!status?.configured) {
    return (
      <div className="agent-panel">
        <div className="agent-uncfg">
          <Icon name="chip" size={28} style={{ color: 'var(--accent)', marginBottom: 12 }} />
          <div className="agent-uncfg-title">{t('agentChat.unconfiguredTitle')}</div>
          <div className="agent-uncfg-desc">
            {t('agentChat.unconfiguredDesc')}
          </div>
          <button className="btn primary" style={{ marginTop: 16 }} onClick={onGotoConfig}>
            <Icon name="settings" size={13} /> {t('agentChat.gotoConfig')}
          </button>
        </div>
      </div>
    );
  }

  const usageTotal = usage ? usage.input + usage.output : 0;
  const lastIndex = items.length - 1;
  const currentInList = sessionId !== null && sessions.some(s => s.id === sessionId);

  // Slash mode: a single-line input starting with "/" opens the quick menu and
  // filters it; Enter runs the first enabled match (never sent to the model).
  const slashQuery = input.startsWith('/') && !input.includes('\n')
    ? input.slice(1).trim().toLowerCase()
    : null;
  const menuOpen = quickOpen || slashQuery !== null;
  const visibleCommands = slashQuery
    ? QUICK_COMMANDS.filter(c => c.cmd.slice(1).startsWith(slashQuery) || t(`agentChat.${c.labelKey}`).toLowerCase().includes(slashQuery))
    : QUICK_COMMANDS;
  const cmdDisabled = (c: QuickCommand): boolean => {
    if (c.kind === 'send') return streaming;
    if (c.kind === 'regen') return streaming || !sessionId || items.length === 0;
    if (c.kind === 'undo') return streaming;
    if (c.kind === 'redo') return streaming || !canRedo;
    if (c.kind === 'new') return streaming;
    if (c.kind === 'crawlmf') {
      // Crawls are admin-only in team mode — a member's request would 403.
      if (state.auth?.mode === 'team' && state.auth.role !== 'admin') return true;
      return state.crawl.status === 'running' || !state.env?.ready;
    }
    return items.length === 0; // md
  };
  const runQuickCommand = (c: QuickCommand) => {
    if (cmdDisabled(c)) return;
    setQuickOpen(false);
    setInput('');
    if (c.kind === 'send' && c.textKey) void handleSend(t(`agentChat.${c.textKey}`));
    else if (c.kind === 'regen') void handleRegenerate();
    else if (c.kind === 'undo') void handleUndo();
    else if (c.kind === 'redo') void handleRedo();
    else if (c.kind === 'md') downloadMarkdown();
    else if (c.kind === 'new') void handleNewSession();
    else if (c.kind === 'crawlmf') {
      // User-initiated crawl from the chat: same scope the Config tab uses
      // (localStorage MF root), and the outcome reports back to the agent.
      const mfRoot = (localStorage.getItem('ue-mf-root') || '/Game').trim() || '/Game';
      pendingCrawlReport.current = { kind: 'workmf' };
      void startCrawl('workmf', mfRoot);
      setItems(prev => [...prev, {
        kind: 'notice', variant: 'info',
        message: t('agentChat.crawlmfStarted', { root: mfRoot }),
      }]);
    }
  };

  // M8: per-session tool usage stats (live and replayed items both count —
  // tool steps are part of the persisted transcript).
  const toolCounts = new Map<string, { n: number; fail: number }>();
  for (const it of items) {
    if (it.kind !== 'tools') continue;
    for (const s of it.steps) {
      const c = toolCounts.get(s.name) ?? { n: 0, fail: 0 };
      c.n += 1;
      if (s.done && s.ok === false) c.fail += 1;
      toolCounts.set(s.name, c);
    }
  }
  const toolTotal = [...toolCounts.values()].reduce((acc, c) => acc + c.n, 0);
  const toolBreakdown = [...toolCounts.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([name, c]) => `${name} ×${c.n}${c.fail > 0 ? t('agentChat.toolFailSuffix', { n: c.fail }) : ''}`)
    .join('\n');

  return (
    <div className="agent-panel">
      {/* Status bar */}
      <div className={'agent-statusbar' + (streaming ? ' streaming' : '')}>
        <span className="agent-status-dot" />
        <span className="agent-provider">{status.provider} · {status.model}</span>
        <span className="grow" />
        {toolTotal > 0 && (
          <span className="agent-usage" title={t('agentChat.toolCallsTitle', { breakdown: toolBreakdown })}>
            {t('agentChat.toolCount', { n: toolTotal })}
          </span>
        )}
        {usage && (
          <span
            className="agent-usage"
            title={
              t('agentChat.usageTitle', { input: fmtTokens(usage.input), output: fmtTokens(usage.output) })
              + (usage.cached > 0 ? t('agentChat.usageTitleCached', { cached: fmtTokens(usage.cached) }) : '')
              + (usage.estimated ? t('agentChat.usageTitleEstimated') : '')
            }
          >
            {usage.estimated ? t('agentChat.usageApproxPrefix') : ''}{t('agentChat.tokens', { n: fmtTokens(usageTotal) })}
            {usage.cached > 0 && <span className="agent-usage-cached">⚡{fmtTokens(usage.cached)}</span>}
          </span>
        )}
        {!streaming && (
          <>
            {items.length > 0 && sessionId !== null && (
              <button
                className="agent-bar-btn"
                onClick={() => void handleRegenerate()}
                title={t('agentChat.regenTitle')}
              >
                <Icon name="refresh" size={11} /> {t('agentChat.regen')}
              </button>
            )}
            <button
              className="agent-bar-btn"
              onClick={() => void handleUndo()}
              title={t('agentChat.undoTitle')}
            >
              <Icon name="history" size={11} /> {t('agentChat.undo')}
            </button>
            {canRedo && (
              <button
                className="agent-bar-btn"
                onClick={() => void handleRedo()}
                title={t('agentChat.redoTitle')}
              >
                <Icon name="refresh" size={11} /> {t('agentChat.redo')}
              </button>
            )}
            <button
              className="agent-bar-btn"
              onClick={() => void handleNewSession()}
              title={t('agentChat.newChatTitle')}
            >
              <Icon name="plus" size={11} /> {t('agentChat.newChat')}
            </button>
          </>
        )}
      </div>

      {/* Session bar (M7): switch / delete persisted conversations */}
      <div className="agent-sessbar">
        <Icon name="clock" size={11} style={{ color: 'var(--text-mute)', flex: '0 0 auto' }} />
        <select
          className="agent-sess-sel"
          value={sessionId ?? ''}
          disabled={streaming}
          onChange={e => { if (e.target.value) void loadSession(e.target.value); }}
          title={t('agentChat.switchSession')}
        >
          {sessionId === null && <option value="">{t('agentChat.optionNewSession')}</option>}
          {sessionId !== null && !currentInList && <option value={sessionId}>{t('agentChat.optionCurrentSession')}</option>}
          {sessions.map(s => (
            <option key={s.id} value={s.id}>{sessionLabel(s, t('agentChat.untitledSession'))}</option>
          ))}
        </select>
        {sessionId !== null && !streaming && state.auth?.mode === 'team' && state.auth.role === 'admin' && (
          <button
            className={'agent-bar-btn' + (state.publicAgent.id === sessionId ? ' on' : '')}
            onClick={() => void togglePublic()}
            title={state.publicAgent.id === sessionId
              ? t('agentChat.unsetPublicTitle')
              : t('agentChat.setPublicTitle')}
          >
            <Icon name="eye" size={11} /> {state.publicAgent.id === sessionId ? t('agentChat.publicAgent') : t('agentChat.setPublicAgent')}
          </button>
        )}
        {sessionId !== null && !streaming && (
          <button className="agent-bar-btn" onClick={() => void handleDeleteSession()} title={t('agentChat.deleteSessionTitle')}>
            <Icon name="x" size={11} /> {t('agentChat.delete')}
          </button>
        )}
      </div>

      {/* Message list */}
      <div className="agent-messages" ref={scrollRef}>
        {items.length === 0 && (
          <div className="agent-empty">
            <Icon name="bolt" size={26} className="agent-empty-icon" />
            <div className="agent-empty-title">{t('agentChat.emptyTitle')}</div>
            <div className="agent-empty-sub">{t('agentChat.emptySub')}</div>
            <div className="agent-empty-examples">
              {EXAMPLE_PROMPT_KEYS.map((key, i) => {
                const p = t(`agentChat.${key}`);
                return (
                  <button
                    key={i}
                    className="agent-example-btn"
                    onClick={() => void handleSend(p)}
                    disabled={streaming}
                  >
                    {p}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {items.map((item, i) => {
          if (item.kind === 'text') {
            const isStreamingBubble = streaming && i === lastIndex && item.role === 'assistant';
            return (
              <div key={i} className={'agent-bubble agent-item ' + item.role + (isStreamingBubble ? ' streaming' : '')}>
                <span className="agent-bubble-text">{item.text}</span>
                {item.images != null && item.images > 0 && (
                  <span className="agent-bubble-imgs" title={t('agentChat.bubbleImagesTitle')}>
                    <Icon name="clip" size={10} /> {t('agentChat.bubbleImages', { n: item.images })}
                  </span>
                )}
              </div>
            );
          }
          if (item.kind === 'tools') {
            return <ToolGroupView key={i} item={item} onToggle={() => toggleCollapse(i)} />;
          }
          if (item.kind === 'notice') {
            return <NoticeItem key={i} item={item} />;
          }
          if (item.kind === 'diff') {
            return <DiffBlockView key={i} item={item} onToggle={() => toggleCollapse(i)} />;
          }
          if (item.kind === 'thinking') {
            return (
              <ThinkingView
                key={i}
                item={item}
                live={streaming && i === lastIndex}
                onToggle={() => toggleCollapse(i)}
              />
            );
          }
          if (item.kind === 'systemReport') {
            return <SystemReportView key={i} item={item} onToggle={() => toggleCollapse(i)} />;
          }
          if (item.kind === 'turnUsage') {
            return (
              <div key={i} className="agent-turn-usage agent-item">
                {t(item.estimated ? 'agentChat.turnUsageEstimated' : 'agentChat.turnUsage', {
                  total: fmtTokens(item.input + item.output),
                  input: fmtTokens(item.input),
                  output: fmtTokens(item.output),
                })}
              </div>
            );
          }
          if (item.kind === 'dbEditProposal') {
            return (
              <DbEditProposalView
                key={i}
                item={item}
                onResolve={(notice) => {
                  setItems(prev => [
                    ...prev.map((it, j) => (j === i && it.kind === 'dbEditProposal' ? { ...it, resolved: true } : it)),
                    { kind: 'notice', ...notice },
                  ]);
                  if (notice.variant === 'info') bumpMetadata();
                }}
              />
            );
          }
          if (item.kind === 'crawlProposal') {
            return (
              <CrawlProposalView
                key={i}
                item={item}
                crawl={state.crawl}
                onApprove={() => {
                  setItems(prev => prev.map((it, j) => (j === i && it.kind === 'crawlProposal' ? { ...it, resolved: true } : it)));
                  pendingCrawlReport.current = { kind: item.crawlKind };
                  void startCrawl(item.crawlKind, item.contentRoot);
                }}
              />
            );
          }
          if (item.kind === 'approval') {
            return (
              <ApprovalRequestView
                key={i}
                item={item}
                sessionId={sessionId}
                onError={(message) => setItems(prev => [...prev, { kind: 'notice', variant: 'error', message }])}
              />
            );
          }
          return null;
        })}
      </div>

      {/* Input area */}
      <div className="agent-input-wrap">
        {pendingImages.length > 0 && (
          <div className="agent-img-previews">
            {pendingImages.map((im, i) => (
              <span key={i} className="agent-img-chip">
                <img src={`data:${im.mediaType};base64,${im.data}`} alt={t('agentChat.imageAlt', { n: i + 1 })} />
                <button
                  type="button"
                  aria-label={t('agentChat.removeImage')}
                  title={t('agentChat.removeImage')}
                  onClick={() => setPendingImages(prev => prev.filter((_, j) => j !== i))}
                >
                  <Icon name="x" size={9} />
                </button>
              </span>
            ))}
            <span className="agent-img-note">{t('agentChat.imgNote')}</span>
          </div>
        )}
        <div className="agent-inputbox">
          <div className="agent-quick">
            <button
              className="agent-quick-btn"
              title={t('agentChat.quickCmdTitle')}
              aria-label={t('agentChat.quickCmdLabel')}
              onClick={() => setQuickOpen(o => !o)}
            >
              <Icon name="bolt" size={13} />
            </button>
            {menuOpen && (
              <div className="agent-quick-menu">
                {visibleCommands.map(c => (
                  <button
                    key={c.cmd}
                    className="agent-quick-item"
                    disabled={cmdDisabled(c)}
                    onClick={() => runQuickCommand(c)}
                  >
                    <code className="agent-quick-cmd">{c.cmd}</code>
                    <span>{t(`agentChat.${c.labelKey}`)}</span>
                  </button>
                ))}
                {visibleCommands.length === 0 && (
                  <div className="agent-quick-empty">{t('agentChat.quickNoMatch')}</div>
                )}
              </div>
            )}
          </div>
          <textarea
            ref={inputRef}
            className="agent-input"
            placeholder={t('agentChat.inputPlaceholder')}
            value={input}
            rows={1}
            onChange={e => setInput(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={e => {
              if (e.key === 'Escape' && slashQuery !== null) {
                e.preventDefault();
                setInput('');
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                // Slash mode: Enter runs the first matching command instead of
                // sending the raw "/xxx" text to the model.
                if (slashQuery !== null) {
                  const first = visibleCommands.find(c => !cmdDisabled(c));
                  if (first) runQuickCommand(first);
                  return;
                }
                void handleSend(input);
              }
            }}
          />
          {streaming ? (
            <button className="agent-stop-btn" onClick={handleStop} title={t('agentChat.stopTitle')} aria-label={t('agentChat.stop')}>
              <Icon name="stop" size={12} />
            </button>
          ) : (
            <button
              className="agent-send-btn"
              disabled={!input.trim()}
              onClick={() => void handleSend(input)}
              title={t('agentChat.sendTitle')}
              aria-label={t('agentChat.send')}
            >
              <Icon name="send" size={14} />
            </button>
          )}
        </div>
        <div className="agent-input-hint">
          <span className="agent-input-ctrls">
            <label
              className="agent-think"
              title={memberLock ? t('agentChat.thinkingLockedTitle') : t('agentChat.thinkingTitle')}
            >
              {t('agentChat.thinkingLabel')}
              <select
                className={effThinking !== 'off' ? 'on' : ''}
                value={effThinking}
                disabled={streaming || !!memberLock}
                onChange={e => changeThinking(e.target.value as AgentThinkingLevel)}
              >
                {THINKING_LEVELS.map(lv => (
                  <option key={lv} value={lv}>{t(`agentChat.${THINKING_LABEL_KEYS[lv]}`)}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={'agent-web-toggle' + (effWebOn ? ' on' : '')}
              disabled={streaming || !!memberLock}
              onClick={toggleWeb}
              aria-pressed={effWebOn}
              title={memberLock
                ? t('agentChat.webLockedTitle')
                : effWebOn
                  ? t('agentChat.webOnTitle')
                  : t('agentChat.webOffTitle')}
            >
              <Icon name="globe" size={11} /> {effWebOn ? t('agentChat.webToggleOn') : t('agentChat.webToggleOff')}
            </button>
            <label
              className={'agent-approval-mode' + (approvalMode !== 'skip' ? ' on' : '') + (streaming ? ' disabled' : '')}
              title={approvalMode === 'review' ? t('agentChat.approvalReviewTitle')
                : approvalMode === 'auto' ? t('agentChat.approvalAutoTitle')
                : t('agentChat.approvalSkipTitle')}
            >
              <Icon name="lock" size={11} />
              <select
                value={approvalMode}
                disabled={streaming}
                onChange={e => changeApprovalMode(e.target.value as 'skip' | 'review' | 'auto')}
              >
                <option value="review">{t('agentChat.approvalReview')}</option>
                <option value="auto">{t('agentChat.approvalAuto')}</option>
                <option value="skip">{t('agentChat.approvalSkip')}</option>
              </select>
            </label>
            {memberLock && <span className="agent-lock-note" title={t('agentChat.lockNoteTitle')}><Icon name="lock" size={10} /> {t('agentChat.lockNote')}</span>}
          </span>
          <span>{t('agentChat.inputHint')}</span>
          {streaming && <span className="responding">{t('agentChat.responding')}</span>}
        </div>
      </div>
    </div>
  );
}

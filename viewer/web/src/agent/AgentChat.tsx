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
import { useStore } from '../store';
import { Icon } from '../Icon';
import { streamChat } from './sse';
import { relTimeMinutes } from '../timeUtils';
import type {
  AgentThinkingLevel,
  ProviderStatus,
  AgentUndoResponse,
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
  type UsageTotal,
  newTurnFlags,
  startUserTurn,
  applyAgentEvent,
  accumulateUsage,
  reduceTranscript,
} from './transcript';
import './agent.css';

// ─── Example prompts ─────────────────────────────────────────────────────────

const EXAMPLE_PROMPTS = [
  '建立一個發光材質，讓物件看起來會自發光',
  '建立一個雪地材質，有粗糙感和結晶光澤',
  '建立一個基礎 PBR 材質，有金屬感和反光',
];

const THINKING_LABELS: Record<AgentThinkingLevel, string> = {
  off: '關', low: '低', medium: '中', high: '高',
};
const THINKING_STORAGE_KEY = 'agent-thinking-level';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

function sessionLabel(s: AgentSessionMeta): string {
  const title = s.title || '（未命名）';
  return s.updatedAt ? `${title} · ${relTimeMinutes(s.updatedAt)}` : title;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ToolGroupView({ item, onToggle }: { item: ToolGroup; onToggle: () => void }) {
  const running = item.steps.some(s => !s.done);
  const anyErr = item.steps.some(s => s.done && s.ok === false);
  // Force open while any step is still running so the user sees live progress.
  const open = running || !item.collapsed;
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
            <span>執行過程 · {item.steps.length} 步</span>
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
          ? <><Icon name="refresh" size={11} className="spin" /><span className="live">思考中…</span></>
          : <><Icon name="bolt" size={11} /><span>思考過程 · {item.text.length} 字</span></>}
      </button>
      {open && <div className="agent-thinking-text" ref={textRef}>{item.text}</div>}
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
  const kindLabel = item.crawlKind === 'workmf' ? '專案 Material Function 索引' : '專案材質';
  const running = crawl.status === 'running';
  return (
    <div className="agent-crawl-proposal agent-item">
      <div className="agent-crawl-title">
        <Icon name="refresh" size={12} /> Agent 請求爬取{kindLabel}（{item.contentRoot}）
      </div>
      <div className="agent-crawl-note">會啟動 UE 編輯器、需數分鐘；進度顯示在 Config 分頁。</div>
      {item.resolved
        ? <div className="agent-crawl-resolved">{running ? '爬取進行中…' : '已處理'}</div>
        : (
          <button className="agent-crawl-approve" disabled={running} onClick={onApprove}>
            {running ? '另一個爬取進行中…' : '開始爬取'}
          </button>
        )}
    </div>
  );
}

/** One-line zh-TW summary per patched DB field, shown on the approval card. */
function dbPatchSummary(patch: Record<string, unknown>): string[] {
  return Object.entries(patch).map(([k, v]) => {
    if (k === 'description') return `描述 → ${String(v).slice(0, 120)}${String(v).length > 120 ? '…' : ''}`;
    if (k === 'category') return `類別 → ${String(v)}`;
    if (k === 'verified') return `verified → ${String(v)}`;
    if (Array.isArray(v)) return `${k} → ${v.length} 項（取代整個列表）`;
    return `${k} → ${JSON.stringify(v)}`;
  });
}

/** Agent-proposed node-DB edit card — same approval model as CrawlProposalView:
    the agent only PROPOSES; this button calls POST /api/agent/db-edit, which
    applies + regenerates the index + runs the parity audit (rollback on fail). */
function DbEditProposalView({ item, onResolve }: {
  item: DbEditProposal;
  onResolve: (notice: { variant: 'info' | 'error'; message: string }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const approve = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/agent/db-edit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ueVersion: item.ueVersion, nodeName: item.nodeName, patch: item.patch }),
        cache: 'no-store',
      });
      const body = (r.ok ? await r.json() : { ok: false, error: `HTTP ${r.status}` }) as AgentDbEditResponse;
      if (body.ok) {
        onResolve({ variant: 'info', message: `節點 DB 已更新（${item.nodeName}：${body.changedKeys.join('、')}），索引已重生並通過 parity audit。` });
      } else {
        onResolve({ variant: 'error', message: `節點 DB 修改失敗（已回滾）：${body.error}` });
      }
    } catch {
      onResolve({ variant: 'error', message: '節點 DB 修改請求失敗' });
    }
  };
  return (
    <div className="agent-crawl-proposal agent-item">
      <div className="agent-crawl-title">
        <Icon name="hash" size={12} /> Agent 提議修改節點 DB：{item.nodeName}（UE {item.ueVersion}）
      </div>
      <ul className="agent-dbedit-lines">
        {dbPatchSummary(item.patch).map((l, i) => <li key={i}>{l}</li>)}
      </ul>
      {item.rationale && <div className="agent-crawl-note">依據：{item.rationale}</div>}
      <div className="agent-crawl-note">
        nodes-ue{item.ueVersion}.json 是<b>公開資料檔</b>——只接受乾淨的 Epic／公開 UE 資料。
        套用後會自動重生索引並跑 parity audit，失敗即回滾。
      </div>
      {item.resolved
        ? <div className="agent-crawl-resolved">已處理</div>
        : (
          <button className="agent-crawl-approve" disabled={busy} onClick={() => void approve()}>
            {busy ? '套用中…' : '套用修改'}
          </button>
        )}
    </div>
  );
}

/** Collapsible block listing plain-language diff lines after a successful write. */
function DiffBlockView({ item, onToggle }: { item: DiffBlock; onToggle: () => void }) {
  const open = !item.collapsed;
  return (
    <div className={'agent-diff agent-item' + (open ? ' open' : '')}>
      <button type="button" className="agent-diff-header" onClick={onToggle}>
        <Icon name="caret" size={11} className="caret" />
        <Icon name="hash" size={11} />
        <span>變更摘要 · {item.lines.length} 項</span>
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
}

export function AgentChat({ onGotoConfig }: AgentChatProps) {
  const { state, open, highlightNodes, requestAgentExport, startCrawl, bumpMetadata } = useStore();
  const { connection, currentPath, selectedNodeId } = state;

  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [usage, setUsage] = useState<UsageTotal | null>(null);
  const [sessions, setSessions] = useState<AgentSessionMeta[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  // Per-turn reasoning effort; persisted so the choice survives reloads.
  const [thinking, setThinking] = useState<AgentThinkingLevel>(() => {
    try {
      const v = localStorage.getItem(THINKING_STORAGE_KEY);
      return v === 'low' || v === 'medium' || v === 'high' ? v : 'off';
    } catch { return 'off'; }
  });
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
    } catch { /* keep the current view */ }
  }, []);

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
  }, [streaming]);

  const handleDeleteSession = useCallback(async () => {
    if (streaming || !sessionId) return;
    if (!window.confirm('刪除此對話？已寫入的圖檔不受影響。')) return;
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
  }, [streaming, sessionId, fetchSessions, loadSession]);

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
      i === index && (it.kind === 'tools' || it.kind === 'diff' || it.kind === 'thinking')
        ? { ...it, collapsed: !it.collapsed }
        : it,
    ));
  }, []);

  const changeThinking = useCallback((v: AgentThinkingLevel) => {
    setThinking(v);
    try { localStorage.setItem(THINKING_STORAGE_KEY, v); } catch { /* private mode etc. */ }
  }, []);

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
        setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: `還原請求失敗（HTTP ${r.status}）` }]);
        return;
      }
      const body = await r.json() as AgentUndoResponse;
      if (body.ok) {
        const count = body.restored.length;
        setItems(prev => [...prev, {
          kind: 'notice', variant: 'info',
          message: `已還原上一步（${count} 個檔案）`,
        }]);
      } else {
        setItems(prev => [...prev, { kind: 'notice', variant: 'info', message: '沒有可還原的步驟' }]);
      }
    } catch {
      setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: '還原請求失敗' }]);
    }
  }, [streaming, sessionId]);

  const handleSend = useCallback(async (text: string) => {
    if (!text.trim() || streaming) return;

    const userText = text.trim();
    setInput('');
    setStreaming(true);

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

    setItems(prev => startUserTurn(prev, userText));

    const ac = new AbortController();
    abortRef.current = ac;
    const flags = newTurnFlags();

    try {
      for await (const event of streamChat(
        {
          text: userText,
          graphPath: currentPath ?? undefined,
          selectedNodeId: selectedNodeId ?? undefined,
          thinking: thinking !== 'off' ? thinking : undefined,
          sessionId: sid ?? undefined,
        },
        ac.signal,
      )) {
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
        setItems(prev => applyAgentEvent(prev, event, flags));
      }
    } catch (e: unknown) {
      if ((e as Error)?.name === 'AbortError') {
        setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: '已中斷' }]);
      } else {
        setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: (e as Error)?.message ?? '連線錯誤' }]);
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      inputRef.current?.focus();
      // Refresh titles/timestamps after the turn lands on disk.
      void fetchSessions();
    }
  }, [streaming, currentPath, selectedNodeId, open, thinking, sessionId, fetchSessions, highlightNodes, requestAgentExport]);

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
    const head = c.status === 'success'
      ? `（系統回報）你先前請求的 ${pending.kind} 爬取已完成，請繼續先前的工作（需要的話重新查詢索引）。`
      : `（系統回報）你先前請求的 ${pending.kind} 爬取失敗（exit ${c.exitCode ?? '?'}）。請根據 log 找出原因，用白話告訴我該怎麼解決。`;
    void handleSend(`${head}\n\nlog 尾段：\n${tail}`);
  }, [state.crawl, streaming, handleSend]);

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
    try {
      const r = await fetch('/api/agent/regenerate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
        cache: 'no-store',
      });
      if (!r.ok) {
        setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: `重新生成請求失敗（HTTP ${r.status}）` }]);
        return;
      }
      const body = await r.json() as AgentRegenerateResponse;
      if (!body.ok) {
        setItems(prev => [...prev, { kind: 'notice', variant: 'info', message: '沒有可重新生成的回覆' }]);
        return;
      }
      await loadSession(sessionId);
      await handleSend(body.text);
    } catch {
      setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: '重新生成請求失敗' }]);
    }
  }, [streaming, sessionId, loadSession, handleSend]);

  // Hidden in snapshot mode.
  if (connection === 'snapshot') return null;

  // Loading state.
  if (statusLoading) {
    return (
      <div className="agent-panel">
        <div className="agent-loading">
          <Icon name="refresh" size={16} className="spin" style={{ color: 'var(--accent)' }} />
          <span>載入中…</span>
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
          <div className="agent-uncfg-title">AI 助手尚未設定</div>
          <div className="agent-uncfg-desc">
            請先在 Config 分頁的「AI 助手」區塊設定 LLM 提供商和 API Key，
            再回來使用對話式材質生成。
          </div>
          <button className="btn primary" style={{ marginTop: 16 }} onClick={onGotoConfig}>
            <Icon name="settings" size={13} /> 前往 Config 設定
          </button>
        </div>
      </div>
    );
  }

  const usageTotal = usage ? usage.input + usage.output : 0;
  const lastIndex = items.length - 1;
  const currentInList = sessionId !== null && sessions.some(s => s.id === sessionId);

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
    .map(([name, c]) => `${name} ×${c.n}${c.fail > 0 ? `（${c.fail} 失敗）` : ''}`)
    .join('\n');

  return (
    <div className="agent-panel">
      {/* Status bar */}
      <div className={'agent-statusbar' + (streaming ? ' streaming' : '')}>
        <span className="agent-status-dot" />
        <span className="agent-provider">{status.provider} · {status.model}</span>
        <span className="grow" />
        {toolTotal > 0 && (
          <span className="agent-usage" title={`本會話工具呼叫：\n${toolBreakdown}`}>
            {toolTotal} 工具
          </span>
        )}
        {usage && (
          <span
            className="agent-usage"
            title={`輸入 ${fmtTokens(usage.input)} · 輸出 ${fmtTokens(usage.output)} tokens${usage.estimated ? '（估算值）' : ''}`}
          >
            {usage.estimated ? '約 ' : ''}{fmtTokens(usageTotal)} tokens
          </span>
        )}
        {!streaming && (
          <>
            {items.length > 0 && sessionId !== null && (
              <button
                className="agent-bar-btn"
                onClick={() => void handleRegenerate()}
                title="還原上一輪的檔案變更並重新生成回覆"
              >
                <Icon name="refresh" size={11} /> 重新生成
              </button>
            )}
            <button
              className="agent-bar-btn"
              onClick={() => void handleUndo()}
              title="還原上一步的檔案變更"
            >
              <Icon name="history" size={11} /> 還原
            </button>
            <button
              className="agent-bar-btn"
              onClick={() => void handleNewSession()}
              title="開始新的對話（目前對話保留在歷史）"
            >
              <Icon name="plus" size={11} /> 新對話
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
          title="切換歷史對話"
        >
          {sessionId === null && <option value="">（新對話）</option>}
          {sessionId !== null && !currentInList && <option value={sessionId}>（目前對話）</option>}
          {sessions.map(s => (
            <option key={s.id} value={s.id}>{sessionLabel(s)}</option>
          ))}
        </select>
        {sessionId !== null && !streaming && (
          <button className="agent-bar-btn" onClick={() => void handleDeleteSession()} title="刪除此對話">
            <Icon name="x" size={11} /> 刪除
          </button>
        )}
      </div>

      {/* Message list */}
      <div className="agent-messages" ref={scrollRef}>
        {items.length === 0 && (
          <div className="agent-empty">
            <Icon name="bolt" size={26} className="agent-empty-icon" />
            <div className="agent-empty-title">開始對話，生成 UE 材質</div>
            <div className="agent-empty-sub">用白話描述想要的效果，AI 會即時生成節點圖，改錯了隨時還原</div>
            <div className="agent-empty-examples">
              {EXAMPLE_PROMPTS.map((p, i) => (
                <button
                  key={i}
                  className="agent-example-btn"
                  onClick={() => void handleSend(p)}
                  disabled={streaming}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((item, i) => {
          if (item.kind === 'text') {
            const isStreamingBubble = streaming && i === lastIndex && item.role === 'assistant';
            return (
              <div key={i} className={'agent-bubble agent-item ' + item.role + (isStreamingBubble ? ' streaming' : '')}>
                <span className="agent-bubble-text">{item.text}</span>
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
          return null;
        })}
      </div>

      {/* Input area */}
      <div className="agent-input-wrap">
        <div className="agent-inputbox">
          <textarea
            ref={inputRef}
            className="agent-input"
            placeholder="描述你想要的材質效果…"
            value={input}
            rows={1}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend(input);
              }
            }}
          />
          {streaming ? (
            <button className="agent-stop-btn" onClick={handleStop} title="停止生成" aria-label="停止">
              <Icon name="stop" size={12} />
            </button>
          ) : (
            <button
              className="agent-send-btn"
              disabled={!input.trim()}
              onClick={() => void handleSend(input)}
              title="送出"
              aria-label="送出"
            >
              <Icon name="send" size={14} />
            </button>
          )}
        </div>
        <div className="agent-input-hint">
          <label className="agent-think" title="模型思考程度：越高越深思但越慢、越耗 token">
            思考
            <select
              value={thinking}
              disabled={streaming}
              onChange={e => changeThinking(e.target.value as AgentThinkingLevel)}
            >
              {(Object.keys(THINKING_LABELS) as AgentThinkingLevel[]).map(lv => (
                <option key={lv} value={lv}>{THINKING_LABELS[lv]}</option>
              ))}
            </select>
          </label>
          <span>Enter 送出 · Shift+Enter 換行</span>
          {streaming && <span className="responding">回應中…</span>}
        </div>
      </div>
    </div>
  );
}

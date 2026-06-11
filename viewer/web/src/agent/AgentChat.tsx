// web/src/agent/AgentChat.tsx — 4th Sidebar tab: conversational material agent UI.
//
// Scope (M3+M4+polish): streamed narrative text + grouped tool steps
// (collapsible 執行過程 card) + diff blocks (collapsible 變更摘要) + cumulative
// usage display + input box with stop/undo/reset + unconfigured-state guidance
// + empty-state example prompts. NodeExplainPopover (M5) is NOT implemented here.
//
// Hidden when connection === 'snapshot' (same as ConfigPanel).
//
// Grouping rules:
//   - Consecutive tool steps merge into ONE ToolGroup item; any text/diff/notice
//     item in between starts a new group. Groups stay expanded while any step is
//     still running and auto-collapse when the turn's 'done' event arrives.
//   - Diff blocks arrive expanded; sending the NEXT user message collapses all
//     previous diff blocks (and tool groups) so long conversations stay readable.
//   - A diff item does NOT touch needsNewBubble — the preceding tool_start
//     already set it, so the next text event opens a fresh assistant bubble.

import { useEffect, useRef, useState, useCallback } from 'react';
import { useStore } from '../store';
import { Icon } from '../Icon';
import { streamChat } from './sse';
import type { AgentSseEvent, ProviderStatus, AgentUndoResponse, AgentResetResponse } from './protocol';
import './agent.css';

// ─── Message model ────────────────────────────────────────────────────────────

type MsgRole = 'user' | 'assistant';

interface TextBubble {
  kind: 'text';
  role: MsgRole;
  text: string;
}

interface ToolStep {
  name: string;
  summary: string;
  ok?: boolean;
  endSummary?: string;
  done: boolean;
}

/** Consecutive tool steps grouped into one collapsible 執行過程 card. */
interface ToolGroup {
  kind: 'tools';
  steps: ToolStep[];
  collapsed: boolean;
}

interface NoticeLine {
  kind: 'notice';
  variant: 'limit' | 'error' | 'info';
  message: string;
}

/** Plain-language diff lines emitted after a successful write_graph/patch_graph. */
interface DiffBlock {
  kind: 'diff';
  lines: string[];
  collapsed: boolean;
}

type ChatItem = TextBubble | ToolGroup | NoticeLine | DiffBlock;

/** Cumulative token usage across the whole conversation. */
interface UsageTotal {
  input: number;
  output: number;
  estimated: boolean;
}

// ─── Example prompts ─────────────────────────────────────────────────────────

const EXAMPLE_PROMPTS = [
  '建立一個發光材質，讓物件看起來會自發光',
  '建立一個雪地材質，有粗糙感和結晶光澤',
  '建立一個基礎 PBR 材質，有金屬感和反光',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
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
  const { state, open } = useStore();
  const { connection, currentPath } = state;

  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [usage, setUsage] = useState<UsageTotal | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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

  // Auto-scroll to bottom when items change — but only when the user is already
  // near the bottom, so scrolling up to re-read is never yanked away.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
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
      i === index && (it.kind === 'tools' || it.kind === 'diff')
        ? { ...it, collapsed: !it.collapsed }
        : it,
    ));
  }, []);

  const handleStop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const handleUndo = useCallback(async () => {
    if (streaming) return;
    try {
      const r = await fetch('/api/agent/undo', { method: 'POST', cache: 'no-store' });
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
  }, [streaming]);

  const handleReset = useCallback(async () => {
    if (streaming) return;
    try {
      const r = await fetch('/api/agent/reset', { method: 'POST', cache: 'no-store' });
      if (!r.ok) {
        setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: `重設請求失敗（HTTP ${r.status}）` }]);
        return;
      }
      await r.json() as AgentResetResponse;
      // Clear local conversation history and usage on success.
      setItems([]);
      setUsage(null);
    } catch {
      setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: '重設請求失敗' }]);
    }
  }, [streaming]);

  const handleSend = useCallback(async (text: string) => {
    if (!text.trim() || streaming) return;

    const userText = text.trim();
    setInput('');
    setStreaming(true);

    // Collapse previous-turn diff blocks and tool groups, then add the user bubble.
    setItems(prev => [
      ...prev.map(it =>
        it.kind === 'diff' || it.kind === 'tools' ? { ...it, collapsed: true } : it,
      ),
      { kind: 'text', role: 'user', text: userText },
    ]);

    const ac = new AbortController();
    abortRef.current = ac;

    // Per-send mutable state captured by the event handler below.
    // needsNewBubble: whether the next text event opens a fresh assistant bubble
    // (true after a tool_start resets the text run).
    let needsNewBubble = true;
    // Paths already announced via graph_written this turn (dedup the notice).
    const announcedWrites = new Set<string>();

    const handleEvent = (event: AgentSseEvent) => {
      switch (event.type) {
        case 'text': {
          if (needsNewBubble) {
            needsNewBubble = false;
            setItems(prev => [...prev, { kind: 'text', role: 'assistant', text: event.text }]);
          } else {
            setItems(prev => {
              const last = prev[prev.length - 1];
              if (last?.kind === 'text' && last.role === 'assistant') {
                const updated = [...prev];
                updated[updated.length - 1] = { ...last, text: last.text + event.text };
                return updated;
              }
              // Fallback: no assistant bubble at tail — create one.
              return [...prev, { kind: 'text', role: 'assistant', text: event.text }];
            });
          }
          break;
        }

        case 'tool_start': {
          // Mark that the next text run needs a fresh bubble.
          needsNewBubble = true;
          const step: ToolStep = { name: event.name, summary: event.summary, done: false };
          setItems(prev => {
            const last = prev[prev.length - 1];
            if (last?.kind === 'tools') {
              // Merge into the trailing group (consecutive tool steps).
              const updated = [...prev];
              updated[updated.length - 1] = { ...last, steps: [...last.steps, step] };
              return updated;
            }
            return [...prev, { kind: 'tools', steps: [step], collapsed: false }];
          });
          break;
        }

        case 'tool_end': {
          setItems(prev => {
            // Find the last group containing an unfinished step with this name.
            const copy = [...prev];
            for (let i = copy.length - 1; i >= 0; i--) {
              const item = copy[i];
              if (item.kind !== 'tools') continue;
              for (let j = item.steps.length - 1; j >= 0; j--) {
                const s = item.steps[j];
                if (s.name === event.name && !s.done) {
                  const steps = [...item.steps];
                  steps[j] = { ...s, done: true, ok: event.ok, endSummary: event.summary };
                  copy[i] = { ...item, steps };
                  return copy;
                }
              }
            }
            return prev;
          });
          break;
        }

        case 'usage': {
          setUsage(prev => ({
            input: (prev?.input ?? 0) + event.inputTokens,
            output: (prev?.output ?? 0) + event.outputTokens,
            estimated: (prev?.estimated ?? false) || event.estimated,
          }));
          break;
        }

        case 'limit': {
          setItems(prev => [...prev, { kind: 'notice', variant: 'limit', message: event.message }]);
          break;
        }

        case 'error': {
          setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: event.message }]);
          break;
        }

        case 'diff': {
          // Dedicated DiffBlock item; needsNewBubble untouched (see header note).
          setItems(prev => [...prev, { kind: 'diff', lines: event.lines, collapsed: false }]);
          break;
        }

        case 'graph_written': {
          // Open the written graph via the existing mechanism + announce once.
          open(event.path);
          if (!announcedWrites.has(event.path)) {
            announcedWrites.add(event.path);
            setItems(prev => [...prev, { kind: 'notice', variant: 'info', message: `已開啟圖形：${event.path}` }]);
          }
          break;
        }

        case 'done': {
          // Turn finished — auto-collapse all tool groups; diffs stay open
          // until the next user message so the result remains in view.
          setItems(prev => prev.map(it => (it.kind === 'tools' ? { ...it, collapsed: true } : it)));
          break;
        }

        default:
          break;
      }
    };

    try {
      for await (const event of streamChat(
        { text: userText, graphPath: currentPath ?? undefined },
        ac.signal,
      )) {
        handleEvent(event);
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
    }
  }, [streaming, currentPath, open]);

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

  return (
    <div className="agent-panel">
      {/* Status bar */}
      <div className={'agent-statusbar' + (streaming ? ' streaming' : '')}>
        <span className="agent-status-dot" />
        <span className="agent-provider">{status.provider} · {status.model}</span>
        <span className="grow" />
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
            <button
              className="agent-bar-btn"
              onClick={() => void handleUndo()}
              title="還原上一步的檔案變更"
            >
              <Icon name="history" size={11} /> 還原
            </button>
            <button
              className="agent-bar-btn"
              onClick={() => void handleReset()}
              title="清空對話，開始新的會話"
            >
              <Icon name="plus" size={11} /> 新對話
            </button>
          </>
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
          <span>Enter 送出 · Shift+Enter 換行</span>
          {streaming && <span className="responding">回應中…</span>}
        </div>
      </div>
    </div>
  );
}

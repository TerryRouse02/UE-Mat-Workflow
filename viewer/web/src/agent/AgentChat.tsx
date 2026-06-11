// web/src/agent/AgentChat.tsx — 4th Sidebar tab: conversational material agent UI.
//
// Scope (M3+M4): streamed narrative text + tool step lines (tool_start/tool_end) +
// diff blocks (plain-language change list) + input box + stop/undo/reset buttons +
// unconfigured-state guidance + empty-state example prompts.
// NodeExplainPopover (M5) is NOT implemented here.
//
// Hidden when connection === 'snapshot' (same as ConfigPanel).
//
// Bubble-grouping note for diff events:
//   A diff block is inserted as its own ChatItem (kind:'diff'). It does NOT
//   call setNeedsNewBubble(true) — diff events come from the server AFTER a
//   successful tool write, between tool_end and the next text run. The
//   subsequent text event will open a new bubble only if needsNewBubble is
//   still true from the preceding tool_start (which it is), so grouping is
//   naturally correct without special handling.

import { useEffect, useRef, useState, useCallback } from 'react';
import React from 'react';
import { useStore } from '../store';
import { Icon } from '../Icon';
import { streamChat } from './sse';
import type { AgentSseEvent, ProviderStatus, AgentUndoResponse, AgentResetResponse } from './protocol';

// ─── Message model ────────────────────────────────────────────────────────────

type MsgRole = 'user' | 'assistant';

interface TextBubble {
  kind: 'text';
  role: MsgRole;
  text: string;
}

interface ToolLine {
  kind: 'tool';
  name: string;
  summary: string;
  ok?: boolean;
  endSummary?: string;
  done: boolean;
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
}

type ChatItem = TextBubble | ToolLine | NoticeLine | DiffBlock;

// ─── Example prompts ─────────────────────────────────────────────────────────

const EXAMPLE_PROMPTS = [
  '建立一個發光材質，讓物件看起來會自發光',
  '建立一個雪地材質，有粗糙感和結晶光澤',
  '建立一個基礎 PBR 材質，有金屬感和反光',
];

// ─── Sub-components ───────────────────────────────────────────────────────────

function ToolStepLine({ item }: { item: ToolLine }) {
  if (!item.done) {
    return (
      <div className="agent-tool running">
        <Icon name="refresh" size={12} className="spin" />
        <span className="agent-tool-name">{item.summary}</span>
      </div>
    );
  }
  return (
    <div className={'agent-tool ' + (item.ok ? 'ok' : 'err')}>
      <Icon name={item.ok ? 'check' : 'x'} size={12} />
      <span className="agent-tool-name">
        {item.endSummary ?? item.summary}
      </span>
    </div>
  );
}

function NoticeItem({ item }: { item: NoticeLine }) {
  const iconName = item.variant === 'error' ? 'warn' : item.variant === 'info' ? 'check' : 'hash';
  return (
    <div className={'agent-notice ' + item.variant}>
      <Icon name={iconName} size={12} />
      <span>{item.message}</span>
    </div>
  );
}

/** Compact block listing plain-language diff lines after a successful write. */
function DiffBlockView({ item }: { item: DiffBlock }) {
  return (
    <div className="agent-diff">
      <div className="agent-diff-header">
        <Icon name="hash" size={11} />
        <span>變更摘要</span>
      </div>
      <ul className="agent-diff-lines">
        {item.lines.map((line, i) => (
          <li key={i} className="agent-diff-line">{line}</li>
        ))}
      </ul>
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

  // Auto-scroll to bottom when items change.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items]);

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
      // Clear local conversation history on success.
      setItems([]);
    } catch {
      setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: '重設請求失敗' }]);
    }
  }, [streaming]);

  const handleSend = useCallback(async (text: string) => {
    if (!text.trim() || streaming) return;

    const userText = text.trim();
    setInput('');
    setStreaming(true);

    // Add user bubble.
    setItems(prev => [...prev, { kind: 'text', role: 'user', text: userText }]);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      // needsNewBubble tracks whether the next text event should open a fresh
      // assistant bubble (true after a tool_start resets the text run).
      let needsNewBubble = true;

      for await (const event of streamChat(
        { text: userText, graphPath: currentPath ?? undefined },
        ac.signal,
      )) {
        handleSseEvent(event, (updater: (prev: ChatItem[]) => ChatItem[]) => setItems(updater), () => needsNewBubble, (v) => { needsNewBubble = v; });
      }
    } catch (e: unknown) {
      if ((e as Error)?.name === 'AbortError') {
        // User stopped — add a notice.
        setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: '已中斷' }]);
      } else {
        setItems(prev => [...prev, { kind: 'notice', variant: 'error', message: (e as Error)?.message ?? '連線錯誤' }]);
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
      inputRef.current?.focus();
    }
  }, [streaming, currentPath]);

  // Process incoming SSE events and update the item list.
  //
  // needsNewBubble / setNeedsNewBubble: a boolean flag that starts true and is
  // set to false once an assistant bubble has been opened.  A tool_start event
  // resets it to true so the next text event from the subsequent LLM turn opens
  // a fresh bubble rather than appending into the pre-tool bubble.
  function handleSseEvent(
    event: AgentSseEvent,
    setItemsFn: React.Dispatch<React.SetStateAction<ChatItem[]>> | ((f: (prev: ChatItem[]) => ChatItem[]) => void),
    getNeedsNewBubble: () => boolean,
    setNeedsNewBubble: (v: boolean) => void,
  ) {
    switch (event.type) {
      case 'text': {
        if (getNeedsNewBubble()) {
          // Open a fresh assistant bubble for this text run.
          setNeedsNewBubble(false);
          setItemsFn(prev => [...prev, { kind: 'text', role: 'assistant', text: event.text }]);
        } else {
          // Append to the last assistant bubble (same LLM turn, streaming deltas).
          setItemsFn(prev => {
            const last = prev[prev.length - 1];
            if (last?.kind === 'text' && (last as TextBubble).role === 'assistant') {
              const updated = [...prev];
              updated[updated.length - 1] = {
                ...(last as TextBubble),
                text: (last as TextBubble).text + event.text,
              };
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
        setNeedsNewBubble(true);
        setItemsFn(prev => [...prev, {
          kind: 'tool', name: event.name, summary: event.summary, done: false,
        }]);
        break;
      }

      case 'tool_end': {
        setItemsFn(prev => {
          // Find the last tool line with this name that hasn't finished.
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            const item = copy[i];
            if (item.kind === 'tool' && item.name === event.name && !item.done) {
              copy[i] = { ...item, done: true, ok: event.ok, endSummary: event.summary };
              return copy;
            }
          }
          return prev;
        });
        break;
      }

      case 'limit': {
        setItemsFn(prev => [...prev, { kind: 'notice', variant: 'limit', message: event.message }]);
        break;
      }

      case 'error': {
        setItemsFn(prev => [...prev, { kind: 'notice', variant: 'error', message: event.message }]);
        break;
      }

      case 'diff': {
        // Diff block: insert as a dedicated DiffBlock item. Does NOT touch
        // needsNewBubble — the preceding tool_start already set it to true, so
        // the next text event will naturally open a fresh assistant bubble.
        setItemsFn(prev => [...prev, { kind: 'diff', lines: event.lines }]);
        break;
      }

      case 'graph_written': {
        // Open the written graph via existing mechanism.
        open(event.path);
        break;
      }

      case 'done':
        // Nothing extra needed; streaming flag handled in handleSend finally.
        break;

      default:
        break;
    }
  }

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

  return (
    <div className="agent-panel">
      {/* Status bar */}
      <div className="agent-statusbar">
        <Icon name="check" size={11} style={{ color: 'var(--ok)' }} />
        <span className="agent-provider">{status.provider} · {status.model}</span>
      </div>

      {/* Message list */}
      <div className="agent-messages" ref={scrollRef}>
        {items.length === 0 && (
          <div className="agent-empty">
            <div className="agent-empty-title">開始對話，生成 UE 材質</div>
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
            return (
              <div key={i} className={'agent-bubble ' + item.role}>
                <div className="agent-bubble-text">{item.text}</div>
              </div>
            );
          }
          if (item.kind === 'tool') {
            return <ToolStepLine key={i} item={item} />;
          }
          if (item.kind === 'notice') {
            return <NoticeItem key={i} item={item} />;
          }
          if (item.kind === 'diff') {
            return <DiffBlockView key={i} item={item} />;
          }
          return null;
        })}
      </div>

      {/* Input area */}
      <div className="agent-input-wrap">
        <textarea
          ref={inputRef}
          className="agent-input"
          placeholder="描述你想要的材質效果…"
          value={input}
          rows={2}
          disabled={streaming}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend(input);
            }
          }}
        />
        <div className="agent-input-actions">
          {streaming ? (
            <button className="btn sm" onClick={handleStop}>
              <Icon name="x" size={12} /> 停止
            </button>
          ) : (
            <>
              <button
                className="btn primary sm"
                disabled={!input.trim()}
                onClick={() => void handleSend(input)}
              >
                <Icon name="check" size={12} /> 送出
              </button>
              <button
                className="btn sm"
                disabled={streaming}
                onClick={() => void handleUndo()}
                title="還原上一步"
                aria-label="還原上一步"
              >
                <Icon name="refresh" size={12} /> 還原
              </button>
              <button
                className="btn sm"
                disabled={streaming}
                onClick={() => void handleReset()}
                title="新對話"
                aria-label="新對話"
              >
                <Icon name="x" size={12} /> 新對話
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

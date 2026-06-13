// PublicAgentView.tsx — the read-only announcement channel for team members.
// Renders the public agent session's transcript (admin writes, everyone
// reads). Re-fetches GET /api/agent/public-session whenever the server's
// `publicAgent` WS broadcast bumps the store version (designation changes,
// a turn starts streaming, a turn lands).

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { Icon } from '../Icon';
import { SYSTEM_REPORT_PREFIX } from './transcript';
import type { AgentPublicSessionResponse, AgentTranscriptEntry } from './protocol';
import './agent.css';

/** Compact display projection of a transcript entry (null = not shown). */
function entryView(e: AgentTranscriptEntry, i: number): React.ReactNode | null {
  if (e.kind === 'user') {
    const isReport = e.text.startsWith(SYSTEM_REPORT_PREFIX);
    if (isReport) {
      const title = e.text.slice(SYSTEM_REPORT_PREFIX.length).split('\n')[0].trim();
      return <div key={i} className="pubagent-sys"><Icon name="settings" size={11} /> {title}</div>;
    }
    return <div key={i} className="agent-bubble user"><span className="agent-bubble-text">{e.text}</span></div>;
  }
  const ev = e.event;
  switch (ev.type) {
    case 'text':
      return <div key={i} className="agent-bubble assistant"><span className="agent-bubble-text">{ev.text}</span></div>;
    case 'tool_start':
      return <div key={i} className="pubagent-tool"><Icon name="bolt" size={11} /> {ev.summary || ev.name}</div>;
    case 'diff':
      return (
        <div key={i} className="pubagent-diff">
          {ev.lines.map((l, j) => <div key={j}>{l}</div>)}
        </div>
      );
    case 'error':
      return <div key={i} className="pubagent-err">{ev.message}</div>;
    default:
      return null; // thinking / usage / proposals 等內部事件不對成員展示
  }
}

export function PublicAgentView() {
  const { state } = useStore();
  const { id, streaming, version } = state.publicAgent;
  const [data, setData] = useState<AgentPublicSessionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Live deltas appended between transcript re-fetches (cleared on each fetch
  // — the server transcript is authoritative).
  const [live, setLive] = useState<AgentTranscriptEntry[]>([]);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/agent/public-session', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as AgentPublicSessionResponse;
        if (!cancelled) { setData(body); setLive([]); setError(null); }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
    // version bumps on every publicAgent WS broadcast → re-fetch.
  }, [id, version]);

  // Real-time stream: append each forwarded event, coalescing consecutive
  // text/thinking chunks (same rule as the server-side transcript).
  useEffect(() => {
    const d = state.publicDelta;
    if (!d || d.seq === lastSeqRef.current || d.id !== id) return;
    lastSeqRef.current = d.seq;
    const ev = d.event as { type?: string; text?: string };
    if (!ev || typeof ev.type !== 'string') return;
    setLive(prev => {
      const last = prev[prev.length - 1];
      if (
        (ev.type === 'text' || ev.type === 'thinking') &&
        last?.kind === 'event' && last.event.type === ev.type
      ) {
        const merged = { kind: 'event' as const, event: { type: ev.type, text: (last.event as { text: string }).text + (ev.text ?? '') } };
        return [...prev.slice(0, -1), merged as AgentTranscriptEntry];
      }
      return [...prev, { kind: 'event', event: ev } as AgentTranscriptEntry];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.publicDelta, id]);

  if (error) {
    return <div className="pubagent-empty"><Icon name="x" size={18} /> 無法載入系統主Agent：{error}</div>;
  }
  if (!data || data.id === null) {
    return (
      <div className="pubagent-empty">
        <Icon name="chip" size={22} />
        <div className="pubagent-empty-title">尚無系統主Agent</div>
        <div className="pubagent-empty-sub">管理員可在 Agent 分頁將一個會話設為系統主Agent，全員即可在此即時圍觀。</div>
      </div>
    );
  }

  const entries = [...(data.transcript ?? []), ...live];
  return (
    <div className="pubagent">
      <div className="pubagent-head">
        <Icon name="chip" size={12} />
        <span className="pubagent-title">{data.title || '系統主Agent'}</span>
        {streaming
          ? <span className="pubagent-live"><span className="dot" /> 廣播中…</span>
          : <span className="pubagent-ro">唯讀</span>}
      </div>
      <div className="agent-messages pubagent-messages">
        {entries.length === 0 && <div className="pubagent-empty-sub" style={{ padding: 12 }}>（這個頻道還沒有內容）</div>}
        {entries.map(entryView)}
      </div>
    </div>
  );
}

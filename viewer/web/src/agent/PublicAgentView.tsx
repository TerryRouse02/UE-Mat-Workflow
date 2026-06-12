// PublicAgentView.tsx — the read-only announcement channel for team members.
// Renders the public agent session's transcript (admin writes, everyone
// reads). Re-fetches GET /api/agent/public-session whenever the server's
// `publicAgent` WS broadcast bumps the store version (designation changes,
// a turn starts streaming, a turn lands).

import { useEffect, useState } from 'react';
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/agent/public-session', { cache: 'no-store' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const body = (await r.json()) as AgentPublicSessionResponse;
        if (!cancelled) { setData(body); setError(null); }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
    // version bumps on every publicAgent WS broadcast → re-fetch.
  }, [id, version]);

  if (error) {
    return <div className="pubagent-empty"><Icon name="x" size={18} /> 無法載入公告：{error}</div>;
  }
  if (!data || data.id === null) {
    return (
      <div className="pubagent-empty">
        <Icon name="chip" size={22} />
        <div className="pubagent-empty-title">尚無公告頻道</div>
        <div className="pubagent-empty-sub">管理員可在 Agent 分頁將一個會話設為公告，全員即可在此圍觀。</div>
      </div>
    );
  }

  const entries = data.transcript ?? [];
  return (
    <div className="pubagent">
      <div className="pubagent-head">
        <Icon name="chip" size={12} />
        <span className="pubagent-title">{data.title || '公告頻道'}</span>
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

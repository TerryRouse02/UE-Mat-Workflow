// TeamUsage.tsx — admin usage overview (Config → 團隊): every member's agent
// sessions and token spend at a glance. Pure client-side aggregation over
// GET /api/agent/sessions (the admin's list spans all owners and carries
// owner + totalTokens + turns). Rows expand to per-session detail with
// housekeeping delete; a session can be opened for reading from the Agent
// tab's session dropdown (same [owner] labels).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import type { AgentSessionMeta } from './agent/protocol';

interface OwnerRow {
  owner: string;
  sessions: AgentSessionMeta[];
  totalTokens: number;
  turns: number;
  lastActive: string; // ISO
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtWhen(iso: string): string {
  if (!iso) return '—';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return '剛剛';
  if (mins < 60) return `${mins} 分鐘前`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)} 小時前`;
  return `${Math.floor(mins / (60 * 24))} 天前`;
}

export function TeamUsageSection() {
  const [sessions, setSessions] = useState<AgentSessionMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openOwner, setOpenOwner] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/agent/sessions', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = (await r.json()) as { sessions: AgentSessionMeta[] };
      setSessions(body.sessions);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const rows = useMemo<OwnerRow[]>(() => {
    const byOwner = new Map<string, AgentSessionMeta[]>();
    for (const s of sessions ?? []) {
      // Sessions from before team mode (or local-mode runs) carry no owner.
      const key = s.owner ?? '（本機／歷史）';
      const list = byOwner.get(key) ?? [];
      list.push(s);
      byOwner.set(key, list);
    }
    return [...byOwner.entries()]
      .map(([owner, list]) => ({
        owner,
        sessions: list,
        totalTokens: list.reduce((a, s) => a + (s.totalTokens || 0), 0),
        turns: list.reduce((a, s) => a + (s.turns || 0), 0),
        lastActive: list.reduce((a, s) => (s.updatedAt > a ? s.updatedAt : a), ''),
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);
  }, [sessions]);

  const grandTotal = rows.reduce((a, r) => a + r.totalTokens, 0);

  const deleteSession = async (id: string, title: string) => {
    if (!window.confirm(`刪除會話「${title || id}」？其對話與還原點將一併刪除。`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/agent/sessions/${id}`, { method: 'DELETE' });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        setError(e.error || `HTTP ${r.status}`);
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cfg-sec">
      <div className="sech">
        <Icon name="layers" size={13} />
        <span className="sect">會話與用量</span>
        <span className="secd">全部成員 · 累計 {fmtTokens(grandTotal)} tokens</span>
        <button className="ua-btn teamusage-refresh" onClick={() => void refresh()} title="重新整理">
          <Icon name="refresh" size={11} />
        </button>
      </div>

      {error && <div className="useradmin-err" role="alert">{error}</div>}
      {sessions !== null && rows.length === 0 && (
        <div className="note">還沒有任何 agent 會話。</div>
      )}

      <div className="teamusage-list">
        {rows.map(row => (
          <div key={row.owner} className="teamusage-owner">
            <button
              className="tu-row"
              onClick={() => setOpenOwner(openOwner === row.owner ? null : row.owner)}
            >
              <Icon name="caret" size={11} style={{ transform: openOwner === row.owner ? 'rotate(90deg)' : 'none' }} />
              <span className="tu-name">{row.owner}</span>
              <span className="tu-stat">{row.sessions.length} 會話</span>
              <span className="tu-stat">{row.turns} 輪</span>
              <span className="tu-tokens mono">{fmtTokens(row.totalTokens)} tok</span>
              <span className="tu-when">{fmtWhen(row.lastActive)}</span>
            </button>
            {openOwner === row.owner && (
              <div className="tu-sessions">
                {row.sessions
                  .slice()
                  .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
                  .map(s => (
                    <div key={s.id} className="tu-session">
                      <span className="tu-title" title={s.title || s.id}>{s.title || '（未命名）'}</span>
                      <span className="tu-stat">{s.turns} 輪</span>
                      <span className="tu-tokens mono">{fmtTokens(s.totalTokens || 0)} tok</span>
                      <span className="tu-when">{fmtWhen(s.updatedAt)}</span>
                      <button className="ua-btn danger" disabled={busy} onClick={() => void deleteSession(s.id, s.title)}>刪除</button>
                    </div>
                  ))}
                <div className="note" style={{ padding: '4px 2px 0' }}>
                  要查看內容：到 Agent 分頁的會話下拉選單（成員會話以 [帳號] 前綴標示）。
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

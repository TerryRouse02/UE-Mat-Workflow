// TeamUsage.tsx — admin usage overview (Config → 團隊): every member's agent
// sessions and token spend at a glance. Pure client-side aggregation over
// GET /api/agent/sessions (the admin's list spans all owners and carries
// owner + totalTokens + turns). Rows expand to per-session detail with
// housekeeping delete; a session can be opened for reading from the Agent
// tab's session dropdown (same [owner] labels).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';
import type { AgentSessionMeta } from './agent/protocol';
import type { TFunction } from 'i18next';

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

function fmtWhen(iso: string, t: TFunction): string {
  if (!iso) return '—';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return t('teamUsage.justNow');
  if (mins < 60) return t('teamUsage.minutesAgo', { mins });
  if (mins < 60 * 24) return t('teamUsage.hoursAgo', { hours: Math.floor(mins / 60) });
  return t('teamUsage.daysAgo', { days: Math.floor(mins / (60 * 24)) });
}

export function TeamUsageSection() {
  const { t } = useTranslation();
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
      const key = s.owner ?? t('teamUsage.localOrHistory');
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
  }, [sessions, t]);

  const grandTotal = rows.reduce((a, r) => a + r.totalTokens, 0);

  const deleteSession = async (id: string, title: string) => {
    if (!window.confirm(t('teamUsage.confirmDelete', { name: title || id }))) return;
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
        <span className="sect">{t('teamUsage.sectionTitle')}</span>
        <span className="secd">{t('teamUsage.grandTotal', { total: fmtTokens(grandTotal) })}</span>
        <button className="ua-btn teamusage-refresh" onClick={() => void refresh()} title={t('teamUsage.refresh')}>
          <Icon name="refresh" size={11} />
        </button>
      </div>

      {error && <div className="useradmin-err" role="alert">{error}</div>}
      {sessions !== null && rows.length === 0 && (
        <div className="note">{t('teamUsage.noSessions')}</div>
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
              <span className="tu-stat">{t('teamUsage.sessionCount', { count: row.sessions.length })}</span>
              <span className="tu-stat">{t('teamUsage.turnCount', { count: row.turns })}</span>
              <span className="tu-tokens mono">{fmtTokens(row.totalTokens)} tok</span>
              <span className="tu-when">{fmtWhen(row.lastActive, t)}</span>
            </button>
            {openOwner === row.owner && (
              <div className="tu-sessions">
                {row.sessions
                  .slice()
                  .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
                  .map(s => (
                    <div key={s.id} className="tu-session">
                      <span className="tu-title" title={s.title || s.id}>{s.title || t('teamUsage.untitled')}</span>
                      <span className="tu-stat">{t('teamUsage.turnCount', { count: s.turns })}</span>
                      <span className="tu-tokens mono">{fmtTokens(s.totalTokens || 0)} tok</span>
                      <span className="tu-when">{fmtWhen(s.updatedAt, t)}</span>
                      <button className="ua-btn danger" disabled={busy} onClick={() => void deleteSession(s.id, s.title)}>{t('teamUsage.delete')}</button>
                    </div>
                  ))}
                <div className="note" style={{ padding: '4px 2px 0' }}>
                  {t('teamUsage.viewHint')}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

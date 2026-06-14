// ProposalInbox.tsx — admin approval inbox (Config → 團隊): member-agent
// crawl / DB-edit proposals queue here. Approve runs the real operation
// (crawl job / applyDbEdit) and the outcome is injected back into the
// member's session server-side. Re-fetches on every `proposals` WS bump.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from './store';
import { Icon } from './Icon';

interface Proposal {
  id: string;
  kind: 'crawl' | 'db-edit';
  requester: string;
  sessionId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  status: 'pending' | 'approved' | 'denied' | 'done' | 'failed';
  note?: string;
}

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

function getStatusLabel(t: TFunc): Record<Proposal['status'], string> {
  return {
    pending: t('proposalInbox.statusPending'),
    approved: t('proposalInbox.statusApproved'),
    denied: t('proposalInbox.statusDenied'),
    done: t('proposalInbox.statusDone'),
    failed: t('proposalInbox.statusFailed'),
  };
}

function summary(p: Proposal, t: TFunc): string {
  if (p.kind === 'crawl') return t('proposalInbox.summaryCrawl', { kind: String(p.payload.kind), contentRoot: String(p.payload.contentRoot ?? '') });
  const create = p.payload.create === true;
  return t(create ? 'proposalInbox.summaryDbCreate' : 'proposalInbox.summaryDbEdit', { nodeName: String(p.payload.nodeName), ueVersion: String(p.payload.ueVersion) });
}

export function ProposalInboxSection() {
  const { t } = useTranslation();
  const { state } = useStore();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/agent/proposals', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setProposals(((await r.json()) as { proposals: Proposal[] }).proposals);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Initial load + every queue change broadcast over the WS.
  useEffect(() => { void refresh(); }, [refresh, state.proposalsPending]);

  const resolve = async (id: string, action: 'approve' | 'deny') => {
    setBusyId(id);
    setError(null);
    try {
      const r = await fetch(`/api/agent/proposals/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        setError(e.error || `HTTP ${r.status}`);
      }
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const pending = proposals.filter(p => p.status === 'pending');
  const history = proposals.filter(p => p.status !== 'pending').slice(0, 8);
  const statusLabel = getStatusLabel(t as TFunc);

  return (
    <div className="cfg-sec">
      <div className="sech">
        <Icon name="bolt" size={13} />
        <span className="sect">{t('proposalInbox.sectionTitle')}</span>
        {pending.length > 0
          ? <span className="team-state on">{t('proposalInbox.pendingCount', { count: pending.length })}</span>
          : <span className="team-state">{t('proposalInbox.noPending')}</span>}
      </div>

      {error && <div className="useradmin-err" role="alert">{error}</div>}
      {proposals.length === 0 && <div className="note">{t('proposalInbox.emptyHint')}</div>}

      <div className="pinbox-list">
        {pending.map(p => (
          <div key={p.id} className="pinbox-row">
            <div className="pinbox-main">
              <span className="pinbox-kind">{p.kind === 'crawl' ? t('proposalInbox.kindCrawl') : 'DB'}</span>
              <span className="pinbox-summary" title={JSON.stringify(p.payload, null, 2)}>{summary(p, t as TFunc)}</span>
              <span className="pinbox-who">{p.requester}</span>
            </div>
            {p.kind === 'db-edit' && typeof p.payload.rationale === 'string' && p.payload.rationale && (
              <div className="pinbox-note">{t('proposalInbox.rationale', { rationale: p.payload.rationale })}</div>
            )}
            <div className="pinbox-actions">
              <button className="ua-btn primary" disabled={busyId === p.id} onClick={() => void resolve(p.id, 'approve')}>
                {busyId === p.id ? t('proposalInbox.processing') : t('proposalInbox.approve')}
              </button>
              <button className="ua-btn danger" disabled={busyId === p.id} onClick={() => void resolve(p.id, 'deny')}>
                {t('proposalInbox.deny')}
              </button>
            </div>
          </div>
        ))}
        {history.length > 0 && (
          <div className="pinbox-history">
            {history.map(p => (
              <div key={p.id} className="pinbox-hrow">
                <span className={'pinbox-status ' + p.status}>{statusLabel[p.status]}</span>
                <span className="pinbox-summary">{summary(p, t as TFunc)}</span>
                <span className="pinbox-who">{p.requester}</span>
                {p.note && <span className="pinbox-note-inline" title={p.note}>{p.note.slice(0, 40)}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

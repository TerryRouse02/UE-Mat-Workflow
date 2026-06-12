// ProposalInbox.tsx — admin approval inbox (Config → 團隊): member-agent
// crawl / DB-edit proposals queue here. Approve runs the real operation
// (crawl job / applyDbEdit) and the outcome is injected back into the
// member's session server-side. Re-fetches on every `proposals` WS bump.

import { useCallback, useEffect, useState } from 'react';
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

const STATUS_LABEL: Record<Proposal['status'], string> = {
  pending: '待審批', approved: '執行中', denied: '已拒絕', done: '已完成', failed: '失敗',
};

function summary(p: Proposal): string {
  if (p.kind === 'crawl') return `爬取 ${String(p.payload.kind)}（${String(p.payload.contentRoot ?? '')}）`;
  const create = p.payload.create === true;
  return `${create ? '新增節點' : '修改節點 DB'}：${String(p.payload.nodeName)}（UE ${String(p.payload.ueVersion)}）`;
}

export function ProposalInboxSection() {
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

  return (
    <div className="cfg-sec">
      <div className="sech">
        <Icon name="bolt" size={13} />
        <span className="sect">成員提案審批</span>
        {pending.length > 0
          ? <span className="team-state on">{pending.length} 件待審</span>
          : <span className="team-state">無待審</span>}
      </div>

      {error && <div className="useradmin-err" role="alert">{error}</div>}
      {proposals.length === 0 && <div className="note">成員的爬取／DB 修改請求會出現在這裡，批准後結果自動回報到他們的對話。</div>}

      <div className="pinbox-list">
        {pending.map(p => (
          <div key={p.id} className="pinbox-row">
            <div className="pinbox-main">
              <span className="pinbox-kind">{p.kind === 'crawl' ? '爬取' : 'DB'}</span>
              <span className="pinbox-summary" title={JSON.stringify(p.payload, null, 2)}>{summary(p)}</span>
              <span className="pinbox-who">{p.requester}</span>
            </div>
            {p.kind === 'db-edit' && typeof p.payload.rationale === 'string' && p.payload.rationale && (
              <div className="pinbox-note">依據：{p.payload.rationale}</div>
            )}
            <div className="pinbox-actions">
              <button className="ua-btn primary" disabled={busyId === p.id} onClick={() => void resolve(p.id, 'approve')}>
                {busyId === p.id ? '處理中…' : '批准執行'}
              </button>
              <button className="ua-btn danger" disabled={busyId === p.id} onClick={() => void resolve(p.id, 'deny')}>
                拒絕
              </button>
            </div>
          </div>
        ))}
        {history.length > 0 && (
          <div className="pinbox-history">
            {history.map(p => (
              <div key={p.id} className="pinbox-hrow">
                <span className={'pinbox-status ' + p.status}>{STATUS_LABEL[p.status]}</span>
                <span className="pinbox-summary">{summary(p)}</span>
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

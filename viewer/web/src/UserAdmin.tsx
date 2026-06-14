// UserAdmin.tsx — Config-tab user management (team mode, admin only).
// Thin client over /api/auth/users: list, create, delete, reset password.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from './store';
import { Icon } from './Icon';

interface UserRow {
  username: string;
  role: 'admin' | 'user';
  createdAt: string;
}

export function UserAdminSection() {
  const { t } = useTranslation();
  const { state } = useStore();
  const me = state.auth?.username;

  const [users, setUsers] = useState<UserRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Daily token quotas + today's spend (from GET /api/team).
  const [quotas, setQuotas] = useState<Record<string, number>>({});
  const [usageToday, setUsageToday] = useState<Record<string, number>>({});
  const [quotaDraft, setQuotaDraft] = useState<Record<string, string>>({});

  // Create form
  const [newName, setNewName] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'user'>('user');

  // Per-row password reset (which row is expanded + the pending value)
  const [resetFor, setResetFor] = useState<string | null>(null);
  const [resetPw, setResetPw] = useState('');

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/auth/users', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setUsers(((await r.json()) as { users: UserRow[] }).users);
      const t = await fetch('/api/team', { cache: 'no-store' });
      if (t.ok) {
        const team = (await t.json()) as { quotas?: Record<string, number>; usageToday?: Record<string, number> };
        setQuotas(team.quotas ?? {});
        setUsageToday(team.usageToday ?? {});
      }
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const post = async (path: string, init: RequestInit): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(path, init);
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        setError(e.error || `HTTP ${r.status}`);
        return false;
      }
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createUser = async () => {
    const ok = await post('/api/auth/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: newName.trim(), password: newPw, role: newRole }),
    });
    if (ok) { setNewName(''); setNewPw(''); setNewRole('user'); }
  };

  const deleteUser = async (name: string) => {
    if (!window.confirm(t('userAdmin.confirmDelete', { name }))) return;
    await post(`/api/auth/users/${encodeURIComponent(name)}`, { method: 'DELETE' });
  };

  const saveQuota = async (name: string) => {
    const raw = (quotaDraft[name] ?? '').trim();
    const n = raw === '' ? 0 : Number(raw);
    if (raw !== '' && (!Number.isFinite(n) || n < 0)) { setError(t('userAdmin.quotaInvalid')); return; }
    await post('/api/team', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quotas: { [name]: n } }),
    });
    setQuotaDraft(d => { const next = { ...d }; delete next[name]; return next; });
  };

  const resetPassword = async (name: string) => {
    const ok = await post(`/api/auth/users/${encodeURIComponent(name)}/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: resetPw }),
    });
    if (ok) { setResetFor(null); setResetPw(''); }
  };

  return (
    <div className="cfg-sec">
      <div className="sech">
        <Icon name="chip" size={13} />
        <span className="sect">{t('userAdmin.title')}</span>
        <span className="secd">{t('userAdmin.subtitle')}</span>
      </div>

      {error && <div className="useradmin-err" role="alert">{error}</div>}

      <div className="useradmin-list">
        {users.map(u => (
          <div key={u.username} className="useradmin-row">
            <div className="ua-main">
              <span className="ua-name">{u.username}{u.username === me && <span className="ua-me">{t('userAdmin.me')}</span>}</span>
              <span className={'ua-role' + (u.role === 'admin' ? ' admin' : '')}>{u.role}</span>
              {u.role !== 'admin' && (
                <span className="ua-quota" title={t('userAdmin.quotaTooltip')}>
                  <span className="ua-used mono">{(usageToday[u.username] ?? 0).toLocaleString()}</span>
                  <span className="ua-slash">/</span>
                  <input
                    className="ua-quota-input mono"
                    placeholder={t('userAdmin.quotaUnlimited')}
                    value={quotaDraft[u.username] ?? (quotas[u.username] ? String(quotas[u.username]) : '')}
                    onChange={e => setQuotaDraft(d => ({ ...d, [u.username]: e.target.value }))}
                    onBlur={() => { if (u.username in quotaDraft) void saveQuota(u.username); }}
                    onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                  />
                </span>
              )}
              <span className="ua-actions">
                <button
                  className="ua-btn"
                  disabled={busy}
                  onClick={() => { setResetFor(resetFor === u.username ? null : u.username); setResetPw(''); }}
                >{t('userAdmin.resetPassword')}</button>
                {u.username !== me && (
                  <button className="ua-btn danger" disabled={busy} onClick={() => void deleteUser(u.username)}>{t('userAdmin.delete')}</button>
                )}
              </span>
            </div>
            {resetFor === u.username && (
              <div className="ua-reset">
                <input
                  type="password"
                  placeholder={t('userAdmin.newPasswordPlaceholder')}
                  value={resetPw}
                  onChange={e => setResetPw(e.target.value)}
                />
                <button className="ua-btn" disabled={busy || resetPw.length < 8} onClick={() => void resetPassword(u.username)}>
                  {t('userAdmin.confirmReset')}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="ua-create">
        <input
          placeholder={t('userAdmin.usernamePlaceholder')}
          value={newName}
          onChange={e => setNewName(e.target.value)}
          spellCheck={false}
        />
        <input
          type="password"
          placeholder={t('userAdmin.passwordPlaceholder')}
          value={newPw}
          onChange={e => setNewPw(e.target.value)}
        />
        <select value={newRole} onChange={e => setNewRole(e.target.value as 'admin' | 'user')}>
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
        <button
          className="ua-btn primary"
          disabled={busy || !newName.trim() || newPw.length < 8}
          onClick={() => void createUser()}
        >
          <Icon name="plus" size={11} /> {t('userAdmin.addUser')}
        </button>
      </div>
      <div className="note" style={{ marginTop: 6 }}>
        {t('userAdmin.memberNote')}
      </div>
    </div>
  );
}

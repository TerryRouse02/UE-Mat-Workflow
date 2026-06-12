// UserAdmin.tsx — Config-tab user management (team mode, admin only).
// Thin client over /api/auth/users: list, create, delete, reset password.

import { useCallback, useEffect, useState } from 'react';
import { useStore } from './store';
import { Icon } from './Icon';

interface UserRow {
  username: string;
  role: 'admin' | 'user';
  createdAt: string;
}

export function UserAdminSection() {
  const { state } = useStore();
  const me = state.auth?.username;

  const [users, setUsers] = useState<UserRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    if (!window.confirm(`確定刪除帳號「${name}」？其登入立即失效。`)) return;
    await post(`/api/auth/users/${encodeURIComponent(name)}`, { method: 'DELETE' });
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
        <span className="sect">使用者管理</span>
        <span className="secd">團隊模式 · 僅管理員可見</span>
      </div>

      {error && <div className="useradmin-err" role="alert">{error}</div>}

      <div className="useradmin-list">
        {users.map(u => (
          <div key={u.username} className="useradmin-row">
            <div className="ua-main">
              <span className="ua-name">{u.username}{u.username === me && <span className="ua-me">（你）</span>}</span>
              <span className={'ua-role' + (u.role === 'admin' ? ' admin' : '')}>{u.role}</span>
              <span className="ua-actions">
                <button
                  className="ua-btn"
                  disabled={busy}
                  onClick={() => { setResetFor(resetFor === u.username ? null : u.username); setResetPw(''); }}
                >重設密碼</button>
                {u.username !== me && (
                  <button className="ua-btn danger" disabled={busy} onClick={() => void deleteUser(u.username)}>刪除</button>
                )}
              </span>
            </div>
            {resetFor === u.username && (
              <div className="ua-reset">
                <input
                  type="password"
                  placeholder="新密碼（至少 8 字元）"
                  value={resetPw}
                  onChange={e => setResetPw(e.target.value)}
                />
                <button className="ua-btn" disabled={busy || resetPw.length < 8} onClick={() => void resetPassword(u.username)}>
                  確認重設
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="ua-create">
        <input
          placeholder="帳號"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          spellCheck={false}
        />
        <input
          type="password"
          placeholder="密碼"
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
          <Icon name="plus" size={11} /> 新增
        </button>
      </div>
      <div className="note" style={{ marginTop: 6 }}>
        成員（user）可看圖、匯入匯出、讀公告；爬取、LLM 設定與 agent 對話僅管理員可用。
      </div>
    </div>
  );
}

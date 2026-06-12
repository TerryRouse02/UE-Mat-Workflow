// Login.tsx — team-mode gate screen. Two variants on one form: first boot
// (auth.needsSetup) creates the admin account via /api/auth/setup; afterwards
// it is a plain username/password login. Local mode never renders this.

import { useState } from 'react';
import { useStore } from './store';
import { Icon } from './Icon';
import './login.css';

export function Login() {
  const { state, login, setupAdmin } = useStore();
  const needsSetup = state.auth?.needsSetup === true;

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (needsSetup && password !== confirm) {
      setError('兩次輸入的密碼不一致');
      return;
    }
    setBusy(true);
    const r = needsSetup ? await setupAdmin(username, password) : await login(username, password);
    setBusy(false);
    if (!r.ok) setError(r.error ?? '登入失敗');
    // Success: the store flips auth.authed and App swaps this screen out.
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">
          <span className="mark">M</span>
          <span className="t">UE·MAT workflow</span>
        </div>
        <div className="login-title">
          {needsSetup ? '建立管理員帳號' : '登入團隊工作區'}
        </div>
        {needsSetup && (
          <div className="login-sub">
            首次啟動團隊模式：先建立第一個管理員帳號（之後可在 Config 分頁新增成員）。
          </div>
        )}
        <label className="login-field">
          <span>帳號</span>
          <input
            autoFocus
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="username"
            placeholder="1–32 字元：英數、_ . -"
          />
        </label>
        <label className="login-field">
          <span>密碼</span>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete={needsSetup ? 'new-password' : 'current-password'}
            placeholder="至少 8 字元"
          />
        </label>
        {needsSetup && (
          <label className="login-field">
            <span>確認密碼</span>
            <input
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </label>
        )}
        {error && <div className="login-error" role="alert">{error}</div>}
        <button className="login-submit" type="submit" disabled={busy || !username || !password}>
          {busy ? '請稍候…' : needsSetup ? '建立並進入' : '登入'}
        </button>
        <div className="login-foot">
          <Icon name="settings" size={11} /> 7 天內免重複登入 · 連線由伺服器管理者設定
        </div>
      </form>
    </div>
  );
}

// Login.tsx — team-mode gate screen. Two variants on one form: first boot
// (auth.needsSetup) creates the admin account via /api/auth/setup; afterwards
// it is a plain username/password login. Local mode never renders this.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from './store';
import { Icon } from './Icon';
import './login.css';

export function Login() {
  const { t } = useTranslation();
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
      setError(t('login.errPasswordMismatch'));
      return;
    }
    setBusy(true);
    const r = needsSetup ? await setupAdmin(username, password) : await login(username, password);
    setBusy(false);
    if (!r.ok) setError(r.error ?? t('login.errLoginFailed'));
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
          {needsSetup ? t('login.titleSetup') : t('login.titleLogin')}
        </div>
        {needsSetup && (
          <div className="login-sub">
            {t('login.setupSub')}
          </div>
        )}
        <label className="login-field">
          <span>{t('login.usernameLabel')}</span>
          <input
            autoFocus
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="username"
            placeholder={t('login.usernamePlaceholder')}
          />
        </label>
        <label className="login-field">
          <span>{t('login.passwordLabel')}</span>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete={needsSetup ? 'new-password' : 'current-password'}
            placeholder={t('login.passwordPlaceholder')}
          />
        </label>
        {needsSetup && (
          <label className="login-field">
            <span>{t('login.confirmLabel')}</span>
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
          {busy ? t('login.submitBusy') : needsSetup ? t('login.submitSetup') : t('login.submitLogin')}
        </button>
        <div className="login-foot">
          <Icon name="settings" size={11} /> {t('login.foot')}
        </div>
      </form>
    </div>
  );
}

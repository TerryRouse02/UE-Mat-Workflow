// Login.tsx — team-mode gate screen. Three variants on one form: first boot
// (auth.needsSetup) creates the admin account via /api/auth/setup; otherwise a
// Login / Register toggle (Register shown only when the admin has opened
// self-registration). Local mode never renders this.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from './store';
import { Icon } from './Icon';
import './login.css';

export function Login() {
  const { t } = useTranslation();
  const { state, login, setupAdmin, register } = useStore();
  const needsSetup = state.auth?.needsSetup === true;
  const allowRegistration = state.auth?.allowRegistration === true;

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false); // registration sent, awaiting approval

  const isRegister = !needsSetup && mode === 'register';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if ((needsSetup || isRegister) && password !== confirm) {
      setError(t('login.errPasswordMismatch'));
      return;
    }
    setBusy(true);
    if (isRegister) {
      const r = await register(username, password);
      setBusy(false);
      if (r.ok) { setSubmitted(true); setPassword(''); setConfirm(''); }
      else setError(r.error ?? t('login.errRegisterFailed'));
      return;
    }
    const r = needsSetup ? await setupAdmin(username, password) : await login(username, password);
    setBusy(false);
    if (!r.ok) setError(r.error ?? t('login.errLoginFailed'));
    // Success: the store flips auth.authed and App swaps this screen out.
  };

  if (submitted) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <div className="login-logo">
            <span className="mark">M</span>
            <span className="t">UE·MAT workflow</span>
          </div>
          <div className="login-sub" role="status">{t('login.registerSubmitted')}</div>
          <button className="login-submit" onClick={() => { setSubmitted(false); setMode('login'); }}>
            {t('login.tabLogin')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">
          <span className="mark">M</span>
          <span className="t">UE·MAT workflow</span>
        </div>

        {!needsSetup && allowRegistration && (
          <div className="login-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'login'}
              className={'login-tab' + (mode === 'login' ? ' on' : '')}
              onClick={() => { setMode('login'); setError(null); }}>
              {t('login.tabLogin')}
            </button>
            <button type="button" role="tab" aria-selected={mode === 'register'}
              className={'login-tab' + (mode === 'register' ? ' on' : '')}
              onClick={() => { setMode('register'); setError(null); }}>
              {t('login.tabRegister')}
            </button>
          </div>
        )}

        <div className="login-title">
          {needsSetup ? t('login.titleSetup') : isRegister ? t('login.titleRegister') : t('login.titleLogin')}
        </div>
        {needsSetup && <div className="login-sub">{t('login.setupSub')}</div>}
        {isRegister && <div className="login-sub">{t('login.registerSub')}</div>}

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
            autoComplete={needsSetup || isRegister ? 'new-password' : 'current-password'}
            placeholder={t('login.passwordPlaceholder')}
          />
        </label>
        {(needsSetup || isRegister) && (
          <label className="login-field">
            <span>{isRegister ? t('login.confirmRegisterLabel') : t('login.confirmLabel')}</span>
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
          {busy ? t('login.submitBusy') : needsSetup ? t('login.submitSetup') : isRegister ? t('login.submitRegister') : t('login.submitLogin')}
        </button>
        <div className="login-foot">
          <Icon name="settings" size={11} /> {t('login.foot')}
        </div>
      </form>
    </div>
  );
}

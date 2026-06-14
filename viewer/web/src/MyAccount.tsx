// MyAccount.tsx — self-service password change (team mode, every role).
// POST /api/auth/password verifies the old password, rotates the hash, and
// re-issues this browser's token so the user stays logged in.

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from './store';
import { Icon } from './Icon';

export function MyAccountSection() {
  const { t } = useTranslation();
  const { state } = useStore();
  const username = state.auth?.username;

  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async () => {
    if (newPw !== confirm) { setMsg({ ok: false, text: t('myAccount.pwMismatch') }); return; }
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch('/api/auth/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oldPassword: oldPw, newPassword: newPw }),
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        setMsg({ ok: false, text: e.error || `HTTP ${r.status}` });
        return;
      }
      setMsg({ ok: true, text: t('myAccount.pwUpdated') });
      setOldPw(''); setNewPw(''); setConfirm('');
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cfg-sec">
      <div className="sech">
        <Icon name="chip" size={13} />
        <span className="sect">{t('myAccount.title')}</span>
        {username && <span className="secd">{username}</span>}
      </div>
      <div className="myacct-form">
        <input type="password" placeholder={t('myAccount.placeholderCurrentPw')} value={oldPw} onChange={e => setOldPw(e.target.value)} autoComplete="current-password" />
        <input type="password" placeholder={t('myAccount.placeholderNewPw')} value={newPw} onChange={e => setNewPw(e.target.value)} autoComplete="new-password" />
        <input type="password" placeholder={t('myAccount.placeholderConfirmPw')} value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
        <button
          className="ua-btn primary"
          disabled={busy || !oldPw || newPw.length < 8}
          onClick={() => void submit()}
        >
          {busy ? t('myAccount.btnUpdating') : t('myAccount.btnChangePw')}
        </button>
      </div>
      {msg && <div className={msg.ok ? 'myacct-ok' : 'useradmin-err'} role="status">{msg.text}</div>}
    </div>
  );
}

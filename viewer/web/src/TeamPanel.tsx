// TeamPanel.tsx — Config-tab 團隊 sub-tab: switch the server between local
// and team mode from the browser (POST /api/team, live re-bind — no terminal,
// no restart). Enabling on a fresh box creates the admin account in the SAME
// request, so the server is never exposed without auth.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from './store';
import { Icon } from './Icon';

interface MemberLock { thinking: 'off' | 'low' | 'medium' | 'high'; webSearch: boolean }

type TeamLanguage = 'zh-Hant' | 'en';

interface TeamInfo {
  mode: 'local' | 'team';
  envLocked: boolean;
  bindHost: string;
  secureCookies: boolean;
  memberAgent?: boolean;
  memberLock?: MemberLock | null;
  /** Team-wide DEFAULT UI language; members may override locally. */
  language?: TeamLanguage;
  port: number;
  hasUsers: boolean;
  urls: string[];
}

const THINKING_LEVELS: MemberLock['thinking'][] = ['off', 'low', 'medium', 'high'];

export function TeamPanel() {
  const { t } = useTranslation();
  const { state, refreshAuth } = useStore();
  const [info, setInfo] = useState<TeamInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Enable form
  const [bindHost, setBindHost] = useState('0.0.0.0');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [secure, setSecure] = useState(false);
  const [memberAgent, setMemberAgent] = useState(false);
  const [memberLock, setMemberLock] = useState<MemberLock | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/team', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as TeamInfo;
      setInfo(data);
      setSecure(data.secureCookies);
      setMemberAgent(data.memberAgent === true);
      setMemberLock(data.memberLock ?? null);
      if (data.mode === 'local') setBindHost(data.bindHost === '127.0.0.1' ? '0.0.0.0' : data.bindHost);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const post = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch('/api/team', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        setError(e.error || `HTTP ${r.status}`);
        return false;
      }
      await refreshAuth(); // mode may have flipped — Chrome chip / gates follow
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    if (info && !info.hasUsers) {
      if (password !== confirm) { setError(t('teamPanel.passwordMismatch')); return; }
      await post({ enabled: true, bindHost, secureCookies: secure, username: username.trim(), password });
    } else {
      await post({ enabled: true, bindHost, secureCookies: secure });
    }
  };

  const disable = async () => {
    if (!window.confirm(t('teamPanel.disableConfirm'))) return;
    await post({ enabled: false });
  };

  const copyUrl = async (u: string) => {
    try { await navigator.clipboard.writeText(u); setCopied(u); window.setTimeout(() => setCopied(null), 1400); }
    catch { /* clipboard unavailable */ }
  };

  if (!info) {
    return (
      <div className="cfg-sec">
        <div className="sech"><Icon name="link" size={13} /><span className="sect">{t('teamPanel.title')}</span></div>
        {error ? <div className="useradmin-err">{t('teamPanel.loadFailed', { error })}</div> : <div className="note">{t('teamPanel.loading')}</div>}
      </div>
    );
  }

  return (
    <div className="cfg-sec">
      <div className="sech">
        <Icon name="link" size={13} />
        <span className="sect">{t('teamPanel.title')}</span>
        {info.mode === 'team'
          ? <span className="team-state on">{t('teamPanel.stateOn')}</span>
          : <span className="team-state">{t('teamPanel.stateOff')}</span>}
      </div>

      {info.envLocked && (
        <div className="note" style={{ marginBottom: 8 }}>
          {t('teamPanel.envLockedPrefix')}<code>BIND_HOST</code>{t('teamPanel.envLockedSuffix')}
        </div>
      )}

      {error && <div className="useradmin-err" role="alert">{error}</div>}

      {info.mode === 'team' ? (
        <>
          <div className="team-urls">
            <div className="note">{t('teamPanel.shareUrls', { host: info.bindHost, port: info.port })}</div>
            {info.urls.map(u => (
              <div key={u} className="team-url">
                <span className="mono">{u}</span>
                <button className="ua-btn" onClick={() => void copyUrl(u)}>
                  {copied === u ? t('teamPanel.copied') : t('teamPanel.copy')}
                </button>
              </div>
            ))}
          </div>
          {state.onlineUsers.length > 0 && (
            <div className="note" style={{ marginBottom: 6 }}>
              {t('teamPanel.online', { users: state.onlineUsers.join(t('teamPanel.listSep')) })}
            </div>
          )}
          <div className="field team-lang">
            <label>{t('teamPanel.langLabel')}</label>
            <div className="inp">
              <select
                value={info.language ?? 'zh-Hant'}
                disabled={busy}
                onChange={e => { void post({ language: e.target.value as TeamLanguage }); }}
              >
                <option value="zh-Hant">{t('teamPanel.langZhHant')}</option>
                <option value="en">{t('teamPanel.langEn')}</option>
              </select>
            </div>
            <div className="note">{t('teamPanel.langHint')}</div>
          </div>
          <label className="team-check">
            <input
              type="checkbox"
              checked={memberAgent}
              disabled={busy}
              onChange={e => { setMemberAgent(e.target.checked); void post({ memberAgent: e.target.checked }); }}
            />
            {t('teamPanel.memberAgent')}
          </label>
          <label className="team-check">
            <input
              type="checkbox"
              checked={memberLock !== null}
              disabled={busy}
              onChange={e => {
                const next = e.target.checked ? { thinking: 'off' as const, webSearch: true } : null;
                setMemberLock(next);
                void post({ memberLock: next });
              }}
            />
            {t('teamPanel.memberLock')}
          </label>
          {memberLock !== null && (
            <div className="team-lock-fields">
              <label>
                {t('teamPanel.thinkingLabel')}
                <select
                  value={memberLock.thinking}
                  disabled={busy}
                  onChange={e => {
                    const next = { ...memberLock, thinking: e.target.value as MemberLock['thinking'] };
                    setMemberLock(next);
                    void post({ memberLock: next });
                  }}
                >
                  {THINKING_LEVELS.map(lv => (
                    <option key={lv} value={lv}>{t(`teamPanel.thinking_${lv}`)}</option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={memberLock.webSearch}
                  disabled={busy}
                  onChange={e => {
                    const next = { ...memberLock, webSearch: e.target.checked };
                    setMemberLock(next);
                    void post({ memberLock: next });
                  }}
                />
                {t('teamPanel.allowWebSearch')}
              </label>
            </div>
          )}
          <label className="team-check">
            <input
              type="checkbox"
              checked={secure}
              disabled={busy || info.envLocked}
              onChange={e => { setSecure(e.target.checked); void post({ secureCookies: e.target.checked }); }}
            />
            {t('teamPanel.secureCookieTeam')}
          </label>
          {!info.envLocked && (
            <button className="ua-btn danger team-toggle-btn" disabled={busy} onClick={() => void disable()}>
              {busy ? t('teamPanel.switching') : t('teamPanel.disableBtn')}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="note" style={{ marginBottom: 8 }}>
            {t('teamPanel.enableIntro')}
          </div>
          <div className="field">
            <label>{t('teamPanel.bindHostLabel')}</label>
            <div className="inp">
              <span className="pfx">host</span>
              <input value={bindHost} onChange={e => setBindHost(e.target.value)} spellCheck={false} disabled={info.envLocked} />
            </div>
          </div>
          {info.hasUsers ? (
            <div className="note">{t('teamPanel.existingUsers')}</div>
          ) : (
            <>
              <div className="field">
                <label>{t('teamPanel.adminAccountLabel')} <span style={{ color: 'var(--text-mute)' }}>{t('teamPanel.adminAccountHint')}</span></label>
                <div className="inp"><input placeholder={t('teamPanel.usernamePlaceholder')} value={username} onChange={e => setUsername(e.target.value)} spellCheck={false} /></div>
              </div>
              <div className="team-pwrow">
                <input type="password" placeholder={t('teamPanel.passwordPlaceholder')} value={password} onChange={e => setPassword(e.target.value)} />
                <input type="password" placeholder={t('teamPanel.confirmPlaceholder')} value={confirm} onChange={e => setConfirm(e.target.value)} />
              </div>
            </>
          )}
          <label className="team-check">
            <input type="checkbox" checked={secure} onChange={e => setSecure(e.target.checked)} />
            {t('teamPanel.secureCookieLocal')}
          </label>
          {!info.envLocked && (
            <button
              className="ua-btn primary team-toggle-btn"
              disabled={busy || (!info.hasUsers && (!username.trim() || password.length < 8))}
              onClick={() => void enable()}
            >
              {busy ? t('teamPanel.switching') : t('teamPanel.enableBtn')}
            </button>
          )}
        </>
      )}
    </div>
  );
}

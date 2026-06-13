// TeamPanel.tsx — Config-tab 團隊 sub-tab: switch the server between local
// and team mode from the browser (POST /api/team, live re-bind — no terminal,
// no restart). Enabling on a fresh box creates the admin account in the SAME
// request, so the server is never exposed without auth.

import { useCallback, useEffect, useState } from 'react';
import { useStore } from './store';
import { Icon } from './Icon';

interface MemberLock { thinking: 'off' | 'low' | 'medium' | 'high'; webSearch: boolean }

interface TeamInfo {
  mode: 'local' | 'team';
  envLocked: boolean;
  bindHost: string;
  secureCookies: boolean;
  memberAgent?: boolean;
  memberLock?: MemberLock | null;
  port: number;
  hasUsers: boolean;
  urls: string[];
}

const LOCK_THINKING_LABELS: Record<MemberLock['thinking'], string> = {
  off: '關', low: '低', medium: '中', high: '高',
};

export function TeamPanel() {
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
      if (password !== confirm) { setError('兩次輸入的密碼不一致'); return; }
      await post({ enabled: true, bindHost, secureCookies: secure, username: username.trim(), password });
    } else {
      await post({ enabled: true, bindHost, secureCookies: secure });
    }
  };

  const disable = async () => {
    if (!window.confirm('關閉團隊模式？伺服器將只接受本機連線（帳號資料會保留，之後可再開啟）。')) return;
    await post({ enabled: false });
  };

  const copyUrl = async (u: string) => {
    try { await navigator.clipboard.writeText(u); setCopied(u); window.setTimeout(() => setCopied(null), 1400); }
    catch { /* clipboard unavailable */ }
  };

  if (!info) {
    return (
      <div className="cfg-sec">
        <div className="sech"><Icon name="link" size={13} /><span className="sect">團隊模式</span></div>
        {error ? <div className="useradmin-err">無法載入：{error}</div> : <div className="note">載入中…</div>}
      </div>
    );
  }

  return (
    <div className="cfg-sec">
      <div className="sech">
        <Icon name="link" size={13} />
        <span className="sect">團隊模式</span>
        {info.mode === 'team'
          ? <span className="team-state on">運作中</span>
          : <span className="team-state">未啟用</span>}
      </div>

      {info.envLocked && (
        <div className="note" style={{ marginBottom: 8 }}>
          綁定位址由 <code>BIND_HOST</code> 環境變數鎖定（Docker／腳本部署），此處僅供檢視。
        </div>
      )}

      {error && <div className="useradmin-err" role="alert">{error}</div>}

      {info.mode === 'team' ? (
        <>
          <div className="team-urls">
            <div className="note">分享給隊友的網址（綁定 {info.bindHost}:{info.port}）：</div>
            {info.urls.map(u => (
              <div key={u} className="team-url">
                <span className="mono">{u}</span>
                <button className="ua-btn" onClick={() => void copyUrl(u)}>
                  {copied === u ? '已複製' : '複製'}
                </button>
              </div>
            ))}
          </div>
          {state.onlineUsers.length > 0 && (
            <div className="note" style={{ marginBottom: 6 }}>
              在線：{state.onlineUsers.join('、')}
            </div>
          )}
          <label className="team-check">
            <input
              type="checkbox"
              checked={memberAgent}
              disabled={busy}
              onChange={e => { setMemberAgent(e.target.checked); void post({ memberAgent: e.target.checked }); }}
            />
            允許成員使用 AI 助手（各自的私人會話；花費伺服器持有的共享 LLM key。爬取與節點 DB 修改仍僅限管理員）
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
            鎖定成員的思考程度與聯網開關（成員的控制項變灰、強制使用以下設定；伺服器端同步強制）
          </label>
          {memberLock !== null && (
            <div className="team-lock-fields">
              <label>
                思考程度
                <select
                  value={memberLock.thinking}
                  disabled={busy}
                  onChange={e => {
                    const next = { ...memberLock, thinking: e.target.value as MemberLock['thinking'] };
                    setMemberLock(next);
                    void post({ memberLock: next });
                  }}
                >
                  {(Object.keys(LOCK_THINKING_LABELS) as MemberLock['thinking'][]).map(lv => (
                    <option key={lv} value={lv}>{LOCK_THINKING_LABELS[lv]}</option>
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
                允許聯網搜尋
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
            Secure cookie（掛 HTTPS 反向代理後勾選；純 http LAN 請勿勾，會登不進去）
          </label>
          {!info.envLocked && (
            <button className="ua-btn danger team-toggle-btn" disabled={busy} onClick={() => void disable()}>
              {busy ? '切換中…' : '關閉團隊模式（回到僅本機）'}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="note" style={{ marginBottom: 8 }}>
            開啟後伺服器改綁對外位址（不換 port、不用重啟），隊友以帳號密碼登入：
            admin 擁有完整功能；成員可看圖、匯入匯出、讀公告。
          </div>
          <div className="field">
            <label>綁定位址</label>
            <div className="inp">
              <span className="pfx">host</span>
              <input value={bindHost} onChange={e => setBindHost(e.target.value)} spellCheck={false} disabled={info.envLocked} />
            </div>
          </div>
          {info.hasUsers ? (
            <div className="note">偵測到既有團隊帳號——啟用後沿用，無需重建（用原帳密登入）。</div>
          ) : (
            <>
              <div className="field">
                <label>管理員帳號 <span style={{ color: 'var(--text-mute)' }}>— 啟用即建立，避免「先曝露再搶註冊」</span></label>
                <div className="inp"><input placeholder="帳號（1–32 字元）" value={username} onChange={e => setUsername(e.target.value)} spellCheck={false} /></div>
              </div>
              <div className="team-pwrow">
                <input type="password" placeholder="密碼（至少 8 字元）" value={password} onChange={e => setPassword(e.target.value)} />
                <input type="password" placeholder="確認密碼" value={confirm} onChange={e => setConfirm(e.target.value)} />
              </div>
            </>
          )}
          <label className="team-check">
            <input type="checkbox" checked={secure} onChange={e => setSecure(e.target.checked)} />
            Secure cookie（之後會掛 HTTPS 反代才勾）
          </label>
          {!info.envLocked && (
            <button
              className="ua-btn primary team-toggle-btn"
              disabled={busy || (!info.hasUsers && (!username.trim() || password.length < 8))}
              onClick={() => void enable()}
            >
              {busy ? '切換中…' : '啟用團隊模式'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

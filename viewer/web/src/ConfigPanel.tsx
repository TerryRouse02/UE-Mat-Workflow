import { useEffect, useState } from 'react';
import { useStore } from './store';
import type { CrawlKind } from './crawlRequest';

// Friendly labels for the env-probe checks (server keys -> what an artist reads).
const CHECK_LABELS: Record<string, string> = {
  platform: 'Windows 平台',
  config: 'local.config.json 路徑',
  engine: 'UE 引擎 (UnrealEditor-Cmd.exe)',
  project: '.uproject 專案檔',
  plugin: '已編譯外掛',
  noShadow: '無遮蔽的專案內外掛副本',
};
const CHECK_ORDER = ['platform', 'config', 'engine', 'project', 'plugin', 'noShadow'];

// The Config tab: set the crawl's project paths, see exactly what's still missing,
// and run the crawls — all button-driven, no JSON editing. Writes the same
// local.config.json the PowerShell scripts read, via POST /api/config.
export function ConfigPanel() {
  const { state, saveConfig, refreshEnv, startCrawl } = useStore();
  const { env, crawl, connection } = state;
  const live = connection === 'live';
  const ready = live && !!env?.ready;
  const running = crawl.status === 'running';

  const [projectPath, setProjectPath] = useState('');
  const [engineRoot, setEngineRoot] = useState('');
  const [workmfRoot, setWorkmfRoot] = useState(() => localStorage.getItem('ue-workmf-root') || '/Game');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Seed the path fields from the probed config once it arrives; never clobber an
  // edit in progress (only fill an empty field).
  useEffect(() => { if (env?.projectPath) setProjectPath(p => p || env.projectPath!); }, [env?.projectPath]);
  useEffect(() => { if (env?.engineRoot) setEngineRoot(p => p || env.engineRoot!); }, [env?.engineRoot]);

  if (connection === 'snapshot') {
    return <div className="cfg-note">這是匯出快照，沒有本機 server，無法設定或爬取。</div>;
  }
  if (!live) {
    return <div className="cfg-note">正在連線本機 viewer server… 連上後即可設定爬取。</div>;
  }

  const onSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    const r = await saveConfig(projectPath.trim(), engineRoot.trim());
    setSaving(false);
    setSaveMsg(r.ok ? { ok: true, text: '已儲存，已重新檢查環境。' } : { ok: false, text: r.error || '儲存失敗' });
  };

  const doCrawl = (kind: CrawlKind) =>
    kind === 'workmf' ? startCrawl('workmf', workmfRoot.trim() || '/Game') : startCrawl(kind);

  return (
    <div className="cfg">
      <div className="cfg-sec">
        <div className="cfg-sec-title">專案路徑</div>
        <p className="cfg-note">填好存檔，下方環境檢查會即時更新。爬取會在這台 Windows + UE 機器上執行。</p>
        <label className="cfg-field">
          <span>.uproject 路徑</span>
          <input className="cfg-input" value={projectPath} spellCheck={false}
            placeholder="C:\Path\To\Project.uproject"
            onChange={e => setProjectPath(e.target.value)} />
        </label>
        <label className="cfg-field">
          <span>UE 引擎根目錄</span>
          <input className="cfg-input" value={engineRoot} spellCheck={false}
            placeholder="C:\Program Files\Epic Games\UE_5.7"
            onChange={e => setEngineRoot(e.target.value)} />
        </label>
        <button className="cfg-btn" onClick={onSave}
          disabled={saving || (!projectPath.trim() && !engineRoot.trim())}>
          {saving ? '儲存中…' : '儲存設定'}
        </button>
        {saveMsg && <div className={`cfg-msg ${saveMsg.ok ? 'ok' : 'bad'}`}>{saveMsg.text}</div>}
      </div>

      <div className="cfg-sec">
        <div className="cfg-sec-title">環境檢查</div>
        <div className={`cfg-banner ${ready ? 'ok' : 'bad'}`}>
          {ready ? '✓ 環境就緒，可以爬取' : '尚未就緒——完成下列項目即可爬取'}
        </div>
        {env && CHECK_ORDER.map(k => {
          const c = env.checks[k];
          if (!c) return null;
          return (
            <div key={k} className={`cfg-check ${c.ok ? 'ok' : 'bad'}`}>
              <span className="cfg-check-ico">{c.ok ? '✓' : '✗'}</span>
              <span className="cfg-check-body">
                <span className="cfg-check-label">{CHECK_LABELS[k] ?? k}</span>
                {!c.ok && <span className="cfg-check-detail">{c.detail}</span>}
              </span>
            </div>
          );
        })}
        <p className="cfg-note">
          外掛已內附在 repo（<code>compiled/</code>），不需放進你的專案。若爬取因引擎版本不符而
          載入失敗，在終端機用 <code>-ForcePackage</code> 對你的引擎重新打包一次即可。
        </p>
        <button className="cfg-btn secondary" onClick={() => void refreshEnv()}>重新檢查</button>
      </div>

      <div className="cfg-sec">
        <div className="cfg-sec-title">爬取 UE 元資料</div>
        <button className="cfg-btn" disabled={!ready || running} onClick={() => doCrawl('export')}>重爬節點匯出 (export)</button>
        <button className="cfg-btn" disabled={!ready || running} onClick={() => doCrawl('enginemf')}>重爬引擎 MF (enginemf)</button>
        <div className="cfg-divider" />
        <label className="cfg-field">
          <span>專案 MF Content Root（逗號分隔多個）</span>
          <input className="cfg-input" value={workmfRoot} spellCheck={false} placeholder="/Game"
            onChange={e => { setWorkmfRoot(e.target.value); localStorage.setItem('ue-workmf-root', e.target.value); }} />
        </label>
        <button className="cfg-btn" disabled={!ready || running} onClick={() => doCrawl('workmf')}>重爬專案 MF (workmf)</button>
        {!ready && <p className="cfg-note">完成上方環境檢查後，按鈕就會啟用。</p>}
        {running && <p className="cfg-note">{crawl.kind} 執行中…（編輯器啟動需數分鐘）</p>}
        {crawl.logs.length > 0 && <pre className="cfg-log">{crawl.logs.slice(-12).join('\n')}</pre>}
      </div>
    </div>
  );
}

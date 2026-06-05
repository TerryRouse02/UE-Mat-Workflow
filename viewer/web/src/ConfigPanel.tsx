import { useEffect, useState } from 'react';
import { useStore } from './store';
import type { CrawlKind } from './crawlRequest';
import { diagnoseCrawl, crawlFoundNothing } from './crawlDiagnosis';

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
export interface ConfigPanelProps {
  /** MF root passed from App (lifted state). When omitted, ConfigPanel owns it internally. */
  mfRoot?: string;
  setMfRoot?: (v: string) => void;
}

export function ConfigPanel({ mfRoot: mfRootProp, setMfRoot: setMfRootProp }: ConfigPanelProps = {}) {
  const { state, saveConfig, refreshEnv, startCrawl } = useStore();
  const { env, crawl, connection } = state;
  const live = connection === 'live';
  const ready = live && !!env?.ready;
  const running = crawl.status === 'running';

  const [projectPath, setProjectPath] = useState('');
  const [engineRoot, setEngineRoot] = useState('');
  // One MF content root, shared by the WorkMF crawl (scan scope) and the T3D export
  // (asset path for local MFs). Falls back to the legacy crawl key so an existing
  // setting carries over. When App passes mfRoot as a prop, use that; otherwise own it.
  const [mfRootLocal, setMfRootLocal] = useState(() => localStorage.getItem('ue-mf-root') || localStorage.getItem('ue-workmf-root') || '/Game');
  const mfRoot = mfRootProp !== undefined ? mfRootProp : mfRootLocal;
  const setMfRoot = (v: string) => {
    localStorage.setItem('ue-mf-root', v);
    if (setMfRootProp) setMfRootProp(v);
    else setMfRootLocal(v);
  };
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Seed the path fields from the probed config once it arrives; never clobber an
  // edit in progress (only fill an empty field).
  useEffect(() => { if (env?.projectPath) setProjectPath(p => p || env.projectPath!); }, [env?.projectPath]);
  useEffect(() => { if (env?.engineRoot) setEngineRoot(p => p || env.engineRoot!); }, [env?.engineRoot]);

  const onSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    const r = await saveConfig(projectPath.trim(), engineRoot.trim());
    setSaving(false);
    setSaveMsg(r.ok ? { ok: true, text: '已儲存，已重新檢查環境。' } : { ok: false, text: r.error || '儲存失敗' });
  };

  const doCrawl = (kind: CrawlKind) =>
    (kind === 'workmf' || kind === 'projectmat')
      ? startCrawl(kind, mfRoot.trim() || '/Game')
      : startCrawl(kind);

  const [advancedOpen, setAdvancedOpen] = useState(false);

  // One content root, two uses — always shown (export works offline too, so this must
  // be reachable even in snapshot/reconnecting where the crawl sections are hidden).
  const mfRootSection = (
    <div className="cfg-sec">
      <div className="cfg-sec-title">MF content root</div>
      <label className="cfg-field">
        <span>你的 MaterialFunction 在 UE 的根目錄</span>
        <input className="cfg-input" value={mfRoot} spellCheck={false} placeholder="/Game"
          onChange={e => setMfRoot(e.target.value)} />
      </label>
      <p className="cfg-note">
        一個資料夾兩用：<b>爬取專案 MF</b> 掃描這裡，<b>導出到 UE</b> 也用它把本地
        {' '}<code>./xxx.matgraph.json</code> 解析成 UE 資產路徑。以 <code>/Game/…</code> 絕對路徑引用的 MF
        則直接沿用、不看這裡。（依大廠規範，專案 MF 集中在單一資料夾。）
      </p>
    </div>
  );

  return (
    <div className="cfg">
      {connection === 'snapshot' ? (
        <div className="cfg-note">這是匯出快照，沒有本機 server，無法設定專案或爬取（下方 MF 路徑仍可設，供導出用）。</div>
      ) : !live ? (
        <div className="cfg-note">正在連線本機 viewer server… 連上後即可設定爬取。</div>
      ) : (
        <>
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
            <div className="cfg-crawl-group">
              <div className="cfg-crawl-group-label">主要（專案）</div>
              <button className="cfg-btn" disabled={!ready || running} onClick={() => doCrawl('workmf')}>重爬專案 Material Function</button>
              <button className="cfg-btn" disabled={!ready || running} onClick={() => doCrawl('projectmat')}>重爬專案母材質</button>
            </div>
            <div className="cfg-crawl-group cfg-crawl-group-advanced">
              <button className="cfg-crawl-advanced-toggle" onClick={() => setAdvancedOpen(o => !o)}>
                {advancedOpen ? '▼' : '▶'} 進階／維護（官方原生，一般用不到）
              </button>
              {advancedOpen && (
                <div className="cfg-crawl-advanced-body">
                  <button className="cfg-btn" disabled={!ready || running} onClick={() => doCrawl('export')}>重爬節點導出</button>
                  <button className="cfg-btn" disabled={!ready || running} onClick={() => doCrawl('enginemf')}>重爬引擎 Material Function</button>
                </div>
              )}
            </div>
            {!ready && crawl.status === 'idle' && <p className="cfg-note">完成上方環境檢查後，按鈕就會啟用。</p>}

            {running && (
              <div className="cfg-report running">
                <div className="cfg-report-head">⏳ {crawl.kind} 執行中…（編輯器啟動需數分鐘）</div>
                {crawl.logs.length > 0 && <pre className="cfg-log">{crawl.logs.slice(-12).join('\n')}</pre>}
              </div>
            )}

            {!running && crawl.status === 'success' && (
              <div className="cfg-report ok">
                <div className="cfg-report-head">✓ {crawl.kind} 完成，已即時刷新。</div>
                {crawl.kind === 'workmf' && crawlFoundNothing(crawl.logs) && (
                  <div className="cfg-report-note">⚠ 索引到 0 個專案 MF —— 確認上方 MF content root 對到放 MF 的資料夾。</div>
                )}
              </div>
            )}

            {!running && crawl.status === 'error' && (() => {
              const d = diagnoseCrawl(crawl.logs);
              return (
                <div className="cfg-report bad">
                  <div className="cfg-report-head">✗ {crawl.kind} 失敗{crawl.exitCode != null ? `（exit ${crawl.exitCode}）` : ''}</div>
                  {d ? (
                    <div className="cfg-report-diag">
                      <div><b>可能原因：</b>{d.cause}</div>
                      <div><b>解決方法：</b>{d.fix}</div>
                      <span className={`cfg-who ${d.who}`}>{d.who === 'you' ? '你可以自己處理' : '需要工具維護者'}</span>
                    </div>
                  ) : (
                    <div className="cfg-report-diag">無法自動判斷原因，請看下方 log；必要時附完整 log 回報維護者。</div>
                  )}
                  {crawl.logs.length > 0 && (
                    <details className="cfg-log-details">
                      <summary>log（最後 {Math.min(crawl.logs.length, 200)} 行）</summary>
                      <pre className="cfg-log">{crawl.logs.join('\n')}</pre>
                    </details>
                  )}
                </div>
              );
            })()}
          </div>
        </>
      )}
      {mfRootSection}
    </div>
  );
}

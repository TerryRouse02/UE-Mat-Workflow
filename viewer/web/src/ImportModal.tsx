import { useState } from 'react';
import { parseUET3D } from './export/ueT3D';
import { useStore } from './store';
import type { ExportMeta } from './export/export-meta-types';
import type { ToastItem } from './Toast';
import './import.css';

export interface ImportModalProps {
  exportMeta: ExportMeta;
  /** Open (navigate to) a graph by its graphs-relative path. */
  open: (path: string) => void;
  pushToast: (t: Omit<ToastItem, 'id'>) => void;
  onClose: () => void;
}

// Reverse-import dialog: paste a UE material selection (T3D clipboard text),
// parse it locally with parseUET3D, then ask the server to write it as a new
// project folder under graphs/. The existing file watcher renders it and we
// navigate to it. The textarea is used instead of navigator.clipboard.readText()
// because browsers routinely block programmatic clipboard reads.
export function ImportModal({ exportMeta, open, pushToast, onClose }: ImportModalProps) {
  const { state, askAgent } = useStore();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // Post-import AI walkthrough — only offered in live mode with a server.
  const [explain, setExplain] = useState(false);
  const canExplain = state.connection === 'live';

  const doImport = async () => {
    if (busy) return;
    if (!text.trim()) {
      pushToast({ variant: 'error', title: 'Nothing to import', message: 'Paste the copied UE material text first.' });
      return;
    }
    setBusy(true);
    try {
      const { graph, warnings } = parseUET3D(text, exportMeta, { name: name.trim() || undefined });
      if (!graph.nodes.length) {
        pushToast({ variant: 'error', title: 'Import failed', message: 'No nodes were recognised in the pasted text.', detail: warnings });
        setBusy(false);
        return;
      }
      const resp = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() || graph.name, graph }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        pushToast({ variant: 'error', title: 'Import failed', message: err.error ?? `HTTP ${resp.status}`, detail: warnings });
        setBusy(false);
        return;
      }
      const { path, name: finalName } = await resp.json() as { path: string; name: string };
      const message = graph.type === 'MaterialFunction'
        ? `Imported as "${finalName}" (a MaterialFunction — it appears under "Unorganized").`
        : `Imported ${graph.nodes.length} nodes as "${finalName}".`;
      pushToast({ variant: warnings.length ? 'warning' : 'success', title: 'Imported from UE', message, detail: warnings });
      open(path);
      if (explain && canExplain) {
        askAgent(`我剛從 UE 匯入了 ${path}，請讀取它並用白話解說這張材質圖的結構、關鍵節點與預期視覺效果。`, true);
      }
      onClose();
    } catch (e) {
      pushToast({ variant: 'error', title: 'Import failed', message: (e as Error).message });
      setBusy(false);
    }
  };

  return (
    <div className="import-overlay" onClick={onClose}>
      <div className="import-modal" onClick={e => e.stopPropagation()}>
        <div className="import-head">
          <h3>從 UE 導入</h3>
          <button className="import-x" onClick={onClose} title="關閉">✕</button>
        </div>
        <p className="import-hint">
          在 UE 材質編輯器<b>全選</b> <kbd>Ctrl</kbd>+<kbd>A</kbd>、複製 <kbd>Ctrl</kbd>+<kbd>C</kbd>，把內容貼到下方。
          （全選才會包含根節點，最終輸出連線才不會掉。）解析版本：UE {exportMeta.ueVersion}。
        </p>
        <label className="import-field">
          <span>名稱 <em>（資料夾名 = 材質名；留空則自動命名，衝突會自動加後綴）</em></span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="例如 my_material" />
        </label>
        <label className="import-field">
          <span>UE 剪貼板內容（T3D）</span>
          <textarea value={text} onChange={e => setText(e.target.value)} placeholder="Begin Object Class=/Script/UnrealEd.MaterialGraphNode ..." spellCheck={false} />
        </label>
        <div className="import-actions">
          {canExplain && (
            <label className="import-explain" title="導入成功後自動切到 Agent 分頁，請 AI 解說這張圖">
              <input type="checkbox" checked={explain} onChange={e => setExplain(e.target.checked)} />
              導入後請 AI 解說
            </label>
          )}
          <button className="import-cancel" onClick={onClose} disabled={busy}>取消</button>
          <button className="import-go" onClick={doImport} disabled={busy}>{busy ? '導入中…' : '導入'}</button>
        </div>
      </div>
    </div>
  );
}

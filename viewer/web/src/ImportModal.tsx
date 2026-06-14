import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const { state, askAgent } = useStore();
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // Post-import AI walkthrough — only offered in live mode with a server.
  const [explain, setExplain] = useState(false);
  const canExplain = state.connection === 'live';
  // Team mode: import into the shared root or your own graphs/users/<me>/.
  const isTeam = state.auth?.mode === 'team' && state.auth.authed;
  // Members default into their own workspace; admins default shared.
  const [dest, setDest] = useState<'shared' | 'personal'>(
    state.auth?.mode === 'team' && state.auth.role !== 'admin' ? 'personal' : 'shared');

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
        body: JSON.stringify({ name: name.trim() || graph.name, graph, ...(isTeam ? { dest } : {}) }),
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
        askAgent(t('importModal.explainPrompt', { path }), true);
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
          <h3>{t('importModal.title')}</h3>
          <button className="import-x" onClick={onClose} title={t('importModal.closeTitle')}>✕</button>
        </div>
        <p className="import-hint">
          {t('importModal.hintPre')}<b>{t('importModal.hintSelectAll')}</b> <kbd>Ctrl</kbd>+<kbd>A</kbd>{t('common.listSep')}{t('importModal.hintCopy')} <kbd>Ctrl</kbd>+<kbd>C</kbd>{t('importModal.hintPaste')}
          {t('importModal.hintNote', { ueVersion: exportMeta.ueVersion })}
        </p>
        <label className="import-field">
          <span>{t('importModal.nameLabel')} <em>{t('importModal.nameHint')}</em></span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder={t('importModal.namePlaceholder')} />
        </label>
        <label className="import-field">
          <span>{t('importModal.clipboardLabel')}</span>
          <textarea value={text} onChange={e => setText(e.target.value)} placeholder="Begin Object Class=/Script/UnrealEd.MaterialGraphNode ..." spellCheck={false} />
        </label>
        {isTeam && (
          <label className="import-field">
            <span>{t('importModal.destLabel')}</span>
            <select value={dest} onChange={e => setDest(e.target.value as 'shared' | 'personal')}>
              <option value="shared">{t('importModal.destShared')}</option>
              <option value="personal">{t('importModal.destPersonal', { username: state.auth?.username })}</option>
            </select>
          </label>
        )}
        <div className="import-actions">
          {canExplain && (
            <label className="import-explain" title={t('importModal.explainCheckboxTitle')}>
              <input type="checkbox" checked={explain} onChange={e => setExplain(e.target.checked)} />
              {t('importModal.explainCheckboxLabel')}
            </label>
          )}
          <button className="import-cancel" onClick={onClose} disabled={busy}>{t('importModal.cancelBtn')}</button>
          <button className="import-go" onClick={doImport} disabled={busy}>{busy ? t('importModal.importingBtn') : t('importModal.importBtn')}</button>
        </div>
      </div>
    </div>
  );
}

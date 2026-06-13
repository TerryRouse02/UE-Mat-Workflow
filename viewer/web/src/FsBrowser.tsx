import { useCallback, useEffect, useState } from 'react';
import { Icon } from './Icon';

// Host directory picker for the Config tab's UE-path fields. Talks to the
// LOCAL-mode-only GET /api/fs/list; the buttons that open it are hidden in
// team mode (and the endpoint 403s there regardless).

interface FsEntry { name: string; dir: boolean }
interface FsListing {
  path: string;
  parent: string | null;
  sep: string;
  roots: string[];
  entries: FsEntry[];
}

interface FsBrowserProps {
  /** 'file' picks a file (matching `fileExt`); 'dir' picks the current folder. */
  pick: 'file' | 'dir';
  /** Extension (no dot) a pickable file must end with, e.g. "uproject". */
  fileExt?: string;
  /** Where to start; empty → server picks the home dir. */
  initialPath?: string;
  title: string;
  onPick: (absPath: string) => void;
  onClose: () => void;
}

function joinPath(dir: string, name: string, sep: string): string {
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

export function FsBrowser({ pick, fileExt, initialPath, title, onPick, onClose }: FsBrowserProps) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/fs/list?path=${encodeURIComponent(path)}`, { cache: 'no-store' });
      const data = (await r.json().catch(() => ({}))) as FsListing & { error?: string };
      if (!r.ok) { setError(data.error || `HTTP ${r.status}`); return; }
      setListing(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Seed from the field's current value (falls back to the server's home dir).
  useEffect(() => { void load(initialPath ?? ''); }, [load, initialPath]);

  // Escape closes; mirrors the other modals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const matchesExt = (name: string) =>
    !fileExt || name.toLowerCase().endsWith('.' + fileExt.toLowerCase());

  const onEntry = (e: FsEntry) => {
    if (!listing) return;
    const abs = joinPath(listing.path, e.name, listing.sep);
    if (e.dir) { void load(abs); return; }
    if (pick === 'file' && matchesExt(e.name)) onPick(abs);
  };

  return (
    <div className="fsb-overlay" onMouseDown={onClose}>
      <div className="fsb" onMouseDown={ev => ev.stopPropagation()}>
        <div className="fsb-head">
          <span className="fsb-title">{title}</span>
          <button className="iconbtn" title="關閉" onClick={onClose}><Icon name="x" size={15} /></button>
        </div>

        <div className="fsb-bar">
          <button
            className="btn sm"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && void load(listing.parent)}
            title="上一層"
          >
            <Icon name="caret" size={12} style={{ transform: 'rotate(90deg)' }} /> 上一層
          </button>
          <span className="fsb-path" title={listing?.path}>{listing?.path ?? '…'}</span>
        </div>

        {listing && listing.roots.length > 0 && (
          <div className="fsb-roots">
            {listing.roots.map(r => (
              <button key={r} className="btn sm ghost" onClick={() => void load(r)}>
                <Icon name="chip" size={11} /> {r}
              </button>
            ))}
          </div>
        )}

        <div className="fsb-list">
          {loading && <div className="fsb-empty">讀取中…</div>}
          {error && <div className="fsb-empty err">{error}</div>}
          {!loading && !error && listing && listing.entries.length === 0 && (
            <div className="fsb-empty">（此資料夾沒有可顯示的項目）</div>
          )}
          {!loading && !error && listing?.entries.map(e => {
            const pickable = e.dir || (pick === 'file' && matchesExt(e.name));
            return (
              <div
                key={e.name}
                className={'fsb-row' + (e.dir ? ' dir' : '') + (pickable ? '' : ' dim')}
                onClick={() => onEntry(e)}
                role="button"
                tabIndex={pickable ? 0 : -1}
                onKeyDown={ev => (ev.key === 'Enter' || ev.key === ' ') && onEntry(e)}
              >
                <Icon name={e.dir ? 'folder' : 'layers'} size={13} />
                <span className="fsb-name">{e.name}</span>
                {e.dir && <Icon name="caret" size={11} className="fsb-go" style={{ transform: 'rotate(-90deg)' }} />}
              </div>
            );
          })}
        </div>

        <div className="fsb-foot">
          {pick === 'dir' ? (
            <button
              className="btn primary"
              disabled={!listing}
              onClick={() => listing && onPick(listing.path)}
            >
              <Icon name="check" size={13} /> 選擇此資料夾
            </button>
          ) : (
            <span className="note">點選 .{fileExt} 檔案即選取</span>
          )}
          <button className="btn" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

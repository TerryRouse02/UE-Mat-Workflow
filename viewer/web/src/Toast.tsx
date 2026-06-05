import { useEffect } from 'react';
import './toast.css';
import { Icon } from './Icon';

export interface ToastItem {
  id: number;
  variant: 'loading' | 'success' | 'warning' | 'error' | 'info';
  title: string;
  message?: string;
  detail?: string[];
}

// Map variant to .toast modifier class and icon.
// success → ok; error/warning → err; info/loading → neutral (accent border, no extra class)
type ToastClass = 'ok' | 'err' | '';

function variantClass(v: ToastItem['variant']): ToastClass {
  if (v === 'success') return 'ok';
  if (v === 'error' || v === 'warning') return 'err';
  return '';
}

function ToastItemComponent({ t, onClose }: { t: ToastItem; onClose: (id: number) => void }) {
  useEffect(() => {
    if (t.variant === 'loading') return;
    const id = setTimeout(() => onClose(t.id), 6000);
    return () => clearTimeout(id);
  }, [t.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const cls = variantClass(t.variant);

  return (
    <div className={'toast' + (cls ? ' ' + cls : '')}>
      <span className="ti">
        {t.variant === 'success' || t.variant === 'info'
          ? <Icon name="check" size={13} />
          : t.variant === 'loading'
          ? <Icon name="refresh" size={13} />
          : <Icon name="warn" size={13} />}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="tt">{t.title}</div>
        {t.message && <div className="td">{t.message}</div>}
        {t.detail && t.detail.length > 0 && (
          <ul className="td" style={{ margin: '4px 0 0', paddingLeft: 14, listStyle: 'disc' }}>
            {t.detail.map((d, i) => <li key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{d}</li>)}
          </ul>
        )}
      </div>
      {t.variant !== 'loading' && (
        <button className="tx" onClick={() => onClose(t.id)}>
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}

export function ToastStack({ toasts, onClose }: { toasts: ToastItem[]; onClose: (id: number) => void }) {
  return (
    <div className="toast-wrap">
      {toasts.map(t => <ToastItemComponent key={t.id} t={t} onClose={onClose} />)}
    </div>
  );
}

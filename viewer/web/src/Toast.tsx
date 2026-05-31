import { useEffect } from 'react';
import './toast.css';

export interface ToastItem {
  id: number;
  variant: 'loading' | 'success' | 'warning' | 'error' | 'info';
  title: string;
  message?: string;
  detail?: string[];
}

const ICON: Record<ToastItem['variant'], string> = { loading: '↻', success: '✓', warning: '!', error: '✕', info: '↻' };

function Toast({ t, onClose }: { t: ToastItem; onClose: (id: number) => void }) {
  useEffect(() => {
    if (t.variant === 'loading') return;
    const id = setTimeout(() => onClose(t.id), 6000);
    return () => clearTimeout(id);
  }, [t.id]);
  return (
    <div className={`toast toast-${t.variant}`}>
      <span className="toast-ico">{ICON[t.variant]}</span>
      <div className="toast-content">
        <div className="toast-title">{t.title}</div>
        {t.message && <div className="toast-msg">{t.message}</div>}
        {t.detail && t.detail.length > 0 && (
          <ul className="toast-detail">{t.detail.map((d, i) => <li key={i} className="mono">{d}</li>)}</ul>
        )}
      </div>
      {t.variant !== 'loading' && <button className="toast-x" onClick={() => onClose(t.id)}>×</button>}
    </div>
  );
}

export function ToastStack({ toasts, onClose }: { toasts: ToastItem[]; onClose: (id: number) => void }) {
  return <div className="toast-stack">{toasts.map(t => <Toast key={t.id} t={t} onClose={onClose} />)}</div>;
}

import './toast.css';

export interface ToastItem {
  id: number;
  variant: 'loading' | 'success' | 'warning' | 'error' | 'info';
  title: string;
  message?: string;
  detail?: string[];
}

// Stub — real implementation in a later task.
export function ToastStack(_: { toasts: ToastItem[]; onClose: (id: number) => void }) {
  return null;
}

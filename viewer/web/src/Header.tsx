import type { MatGraph, DerivedPins } from './protocol';
import type { ToastItem } from './Toast';

export interface HeaderProps {
  graph?: MatGraph;
  derivedPins?: Record<string, DerivedPins>;
  positions: Record<string, { x: number; y: number }>;
  pushToast: (t: Omit<ToastItem, 'id'>) => void;
}

// Stub — real implementation in a later task.
export function Header(_: HeaderProps) {
  return <header className="hdr">UE·MAT</header>;
}

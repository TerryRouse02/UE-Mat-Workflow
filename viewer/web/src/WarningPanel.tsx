import { useStore } from './store';

export function WarningPanel() {
  const { state } = useStore();
  const current = state.breadcrumb[state.breadcrumb.length - 1];
  if (!current) return null;
  const warnings = state.graphs[current]?.warnings ?? [];
  const errors = state.errors[current] ?? [];
  if (warnings.length === 0 && errors.length === 0) return null;
  return (
    <div style={{ padding: '6px 12px', background: '#4a2020', color: '#fbb', fontSize: 12 }}>
      {errors.map((e, i) => <div key={`e${i}`}>⛔ {e}</div>)}
      {warnings.map((w, i) => <div key={`w${i}`}>⚠ {w}</div>)}
    </div>
  );
}

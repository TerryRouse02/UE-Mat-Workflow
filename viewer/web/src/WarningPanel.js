import { jsxs as _jsxs } from "react/jsx-runtime";
import { useStore } from './store';
export function WarningPanel() {
    const { state } = useStore();
    const current = state.breadcrumb[state.breadcrumb.length - 1];
    if (!current)
        return null;
    const warnings = state.graphs[current]?.warnings ?? [];
    const errors = state.errors[current] ?? [];
    if (warnings.length === 0 && errors.length === 0)
        return null;
    return (_jsxs("div", { style: { padding: '6px 12px', background: '#4a2020', color: '#fbb', fontSize: 12 }, children: [errors.map((e, i) => _jsxs("div", { children: ["\u26D4 ", e] }, `e${i}`)), warnings.map((w, i) => _jsxs("div", { children: ["\u26A0 ", w] }, `w${i}`))] }));
}

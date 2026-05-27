import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useStore } from './store';
export function FileList() {
    const { state, open } = useStore();
    return (_jsxs("div", { style: { padding: 8, background: '#1e1e1e', color: '#ddd', overflowY: 'auto', height: '100%' }, children: [_jsx("div", { style: { fontWeight: 600, marginBottom: 8 }, children: "Graphs" }), state.files.map(f => (_jsx("div", { onClick: () => open(f), style: {
                    padding: '4px 6px', cursor: 'pointer',
                    background: state.breadcrumb[0] === f ? '#3a3a3a' : 'transparent',
                    fontSize: 12, color: f.startsWith('functions/') ? '#8ab' : '#ddd',
                }, children: f }, f)))] }));
}

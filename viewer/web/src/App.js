import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect } from 'react';
import { StoreProvider, useStore } from './store';
import { Breadcrumb } from './Breadcrumb';
import { FileList } from './FileList';
import { WarningPanel } from './WarningPanel';
import { Graph } from './Graph';
import { DB } from './db';
function Body() {
    const { state, open, enterMF } = useStore();
    useEffect(() => {
        if (!state.currentPath && state.files.length > 0) {
            open(state.files[0]);
        }
    }, [state.files, state.currentPath, open]);
    const current = state.breadcrumb[state.breadcrumb.length - 1];
    const payload = current ? state.graphs[current] : undefined;
    return (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', height: '100vh', background: '#1a1a1a' }, children: [_jsx(Breadcrumb, {}), _jsx(WarningPanel, {}), _jsxs("div", { style: { flex: 1, display: 'flex' }, children: [_jsx("div", { style: { width: 220 }, children: _jsx(FileList, {}) }), _jsx("div", { style: { flex: 1 }, children: payload ? _jsx(Graph, { payload: payload, basePath: current, db: DB, onEnterMF: enterMF }) :
                            _jsx("div", { style: { color: '#888', padding: 20 }, children: "Select a graph from the left." }) })] })] }));
}
export function App() {
    return _jsx(StoreProvider, { children: _jsx(Body, {}) });
}

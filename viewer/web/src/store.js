import { jsx as _jsx } from "react/jsx-runtime";
import React, { createContext, useContext, useReducer, useEffect } from 'react';
import { connect } from './ws-client';
const initial = {
    files: [], currentPath: null, breadcrumb: [], graphs: {}, errors: {},
};
function reducer(s, a) {
    switch (a.type) {
        case 'hello':
        case 'fileList':
            return { ...s, files: a.files };
        case 'graph':
            return { ...s, graphs: { ...s.graphs, [a.path]: a.payload }, errors: { ...s.errors, [a.path]: [] } };
        case 'graphError':
            return { ...s, errors: { ...s.errors, [a.path]: a.errors } };
        case 'open':
            return { ...s, currentPath: a.path, breadcrumb: [a.path] };
        case 'enterMF':
            return { ...s, breadcrumb: [...s.breadcrumb, a.mfPath] };
        case 'popBreadcrumb':
            return { ...s, breadcrumb: s.breadcrumb.slice(0, a.toIndex + 1) };
        default: return s;
    }
}
const C = createContext(null);
export function StoreProvider({ children }) {
    const [state, dispatch] = useReducer(reducer, initial);
    const wsRef = React.useRef(null);
    useEffect(() => {
        const exportData = window.__UE_MAT_EXPORT__;
        if (exportData) {
            dispatch({ type: 'hello', files: Object.keys(exportData.files) });
            for (const [path, graph] of Object.entries(exportData.files)) {
                dispatch({
                    type: 'graph', path,
                    payload: {
                        graph: graph,
                        derivedPins: exportData.derivedPins,
                        warnings: exportData.warnings,
                    },
                });
            }
            dispatch({ type: 'open', path: exportData.entry });
            return;
        }
        const ws = connect((m) => {
            if (m.kind === 'hello')
                dispatch({ type: 'hello', files: m.files });
            else if (m.kind === 'fileList')
                dispatch({ type: 'fileList', files: m.files });
            else if (m.kind === 'graph')
                dispatch({ type: 'graph', path: m.path, payload: m.payload });
            else if (m.kind === 'graphError')
                dispatch({ type: 'graphError', path: m.path, errors: m.errors });
        });
        wsRef.current = ws;
        return () => ws.close();
    }, []);
    return (_jsx(C.Provider, { value: {
            state,
            open(path) { wsRef.current?.send({ kind: 'open', path }); dispatch({ type: 'open', path }); },
            enterMF(path) { wsRef.current?.send({ kind: 'open', path }); dispatch({ type: 'enterMF', mfPath: path }); },
            popBreadcrumb(i) { dispatch({ type: 'popBreadcrumb', toIndex: i }); },
        }, children: children }));
}
export function useStore() {
    const c = useContext(C);
    if (!c)
        throw new Error('useStore outside StoreProvider');
    return c;
}

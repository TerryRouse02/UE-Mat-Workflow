import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React from 'react';
import { useStore } from './store';
export function Breadcrumb() {
    const { state, popBreadcrumb } = useStore();
    return (_jsx("div", { style: { padding: '8px 12px', background: '#252525', color: '#ddd', display: 'flex', gap: 6 }, children: state.breadcrumb.map((p, i) => (_jsxs(React.Fragment, { children: [i > 0 && _jsx("span", { style: { color: '#666' }, children: "\u25B8" }), _jsx("span", { style: { cursor: 'pointer', textDecoration: i === state.breadcrumb.length - 1 ? 'none' : 'underline' }, onClick: () => popBreadcrumb(i), children: niceName(p) })] }, i))) }));
}
function niceName(p) {
    return p.replace(/^functions\//, '').replace('.matgraph.json', '');
}

import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Handle, Position } from 'reactflow';
import './styles.css';
export function MaterialNode({ data }) {
    const cls = ['mat-node'];
    if (data.warning)
        cls.push('mat-warn');
    if (data.isReserved)
        cls.push('mat-reserved');
    return (_jsxs("div", { className: cls.join(' '), children: [_jsx("div", { className: "mat-node-title", children: data.label }), _jsxs("div", { className: "mat-node-body", children: [_jsx("div", { className: "mat-node-pins mat-inputs", children: data.inputs.map((p, i) => (_jsxs("div", { className: "mat-pin", children: [_jsx(Handle, { id: p.name, type: "target", position: Position.Left, style: { top: 30 + i * 18 } }), _jsx("span", { className: "mat-pin-name", children: p.name })] }, p.name))) }), _jsx("div", { className: "mat-node-pins mat-outputs", children: data.outputs.map((p, i) => (_jsxs("div", { className: "mat-pin mat-pin-right", children: [_jsx("span", { className: "mat-pin-name", children: p.name }), _jsx(Handle, { id: p.name, type: "source", position: Position.Right, style: { top: 30 + i * 18 } })] }, p.name))) })] }), data.params && Object.keys(data.params).length > 0 && (_jsx("div", { className: "mat-node-params", children: Object.entries(data.params).map(([k, v]) => (_jsxs("div", { className: "mat-param", children: [_jsxs("span", { children: [k, ":"] }), " ", _jsx("code", { children: JSON.stringify(v) })] }, k))) })), data.warning && _jsx("div", { className: "mat-warn-msg", children: data.warning })] }));
}

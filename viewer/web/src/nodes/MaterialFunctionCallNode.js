import { jsx as _jsx } from "react/jsx-runtime";
import { MaterialNode } from './MaterialNode';
export function MaterialFunctionCallNode({ data }) {
    const md = {
        id: data.id, label: `f() ${data.label}`,
        inputs: data.inputs, outputs: data.outputs,
        params: data.params, warning: data.warning, isReserved: true,
    };
    return _jsx("div", { onDoubleClick: data.onDoubleClick, style: { cursor: 'pointer' }, children: _jsx(MaterialNode, { data: md }) });
}

import { jsx as _jsx } from "react/jsx-runtime";
import { MaterialNode } from './MaterialNode';
export function FunctionInputNode(props) {
    const name = props.data.params?.InputName ?? '(unnamed)';
    const data = {
        id: props.data.id, label: `FunctionInput: ${name}`,
        inputs: [], outputs: [{ name: 'Input', type: 'Float' }],
        params: props.data.params, isReserved: true,
    };
    return _jsx(MaterialNode, { data: data });
}
export function FunctionOutputNode(props) {
    const name = props.data.params?.OutputName ?? '(unnamed)';
    const data = {
        id: props.data.id, label: `FunctionOutput: ${name}`,
        inputs: [{ name: 'Input', type: 'Float' }], outputs: [],
        params: props.data.params, isReserved: true,
    };
    return _jsx(MaterialNode, { data: data });
}

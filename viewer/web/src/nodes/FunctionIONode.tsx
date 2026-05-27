import { MaterialNode, type MaterialNodeData } from './MaterialNode';

export function FunctionInputNode(props: { data: Pick<MaterialNodeData, 'id' | 'params'> }) {
  const name = (props.data.params?.InputName as string) ?? '(unnamed)';
  const data: MaterialNodeData = {
    id: props.data.id, label: `FunctionInput: ${name}`,
    inputs: [], outputs: [{ name: 'Input', type: 'Float' }],
    params: props.data.params, isReserved: true,
  };
  return <MaterialNode data={data} />;
}

export function FunctionOutputNode(props: { data: Pick<MaterialNodeData, 'id' | 'params'> }) {
  const name = (props.data.params?.OutputName as string) ?? '(unnamed)';
  const data: MaterialNodeData = {
    id: props.data.id, label: `FunctionOutput: ${name}`,
    inputs: [{ name: 'Input', type: 'Float' }], outputs: [],
    params: props.data.params, isReserved: true,
  };
  return <MaterialNode data={data} />;
}

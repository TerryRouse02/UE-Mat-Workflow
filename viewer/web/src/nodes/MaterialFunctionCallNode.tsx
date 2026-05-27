import { MaterialNode, type MaterialNodeData } from './MaterialNode';

export interface MFCData {
  id: string;
  label: string;
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
  params?: Record<string, unknown>;
  onDoubleClick(): void;
  warning?: string;
}

export function MaterialFunctionCallNode({ data }: { data: MFCData }) {
  const md: MaterialNodeData = {
    id: data.id, label: `f() ${data.label}`,
    inputs: data.inputs, outputs: data.outputs,
    params: data.params, warning: data.warning, isReserved: true,
  };
  return <div onDoubleClick={data.onDoubleClick} style={{ cursor: 'pointer' }}><MaterialNode data={md} /></div>;
}

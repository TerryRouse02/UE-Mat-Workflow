import { MaterialNode, type MaterialNodeData } from './MaterialNode';
import { MATERIAL_OUTPUT_PINS } from '../material-attributes';

// A MaterialOutput root node's input pins are the MaterialAttributes set, plus the
// single "MaterialAttributes" pin used in "Use Material Attributes" mode (the root's
// 材质属性 input). The canonical lists live in server/material-attributes.ts
// (re-exported via ../material-attributes) so the agent's write gate stays in sync.
export { MATERIAL_OUTPUT_PINS };

export function MaterialOutputNode(props: { data: Pick<MaterialNodeData, 'id' | 'params' | 'warning'> }) {
  const data: MaterialNodeData = {
    id: props.data.id,
    label: 'Material Output',
    inputs: MATERIAL_OUTPUT_PINS.map(n => ({ name: n, type: 'Float' })),
    outputs: [],
    params: props.data.params,
    warning: props.data.warning,
    isReserved: true,
  };
  return <MaterialNode data={data} />;
}

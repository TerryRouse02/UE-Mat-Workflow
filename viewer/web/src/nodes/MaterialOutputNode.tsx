import { MaterialNode, type MaterialNodeData } from './MaterialNode';
import { MATERIAL_ATTRIBUTE_PINS } from '../material-attributes';

// A MaterialOutput root node's input pins are exactly the MaterialAttributes set.
export const MATERIAL_OUTPUT_PINS = MATERIAL_ATTRIBUTE_PINS;

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

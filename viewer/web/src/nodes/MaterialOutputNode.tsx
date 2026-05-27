import { MaterialNode, type MaterialNodeData } from './MaterialNode';

export const MATERIAL_OUTPUT_PINS = [
  'BaseColor', 'Metallic', 'Specular', 'Roughness', 'EmissiveColor',
  'Opacity', 'OpacityMask', 'Normal', 'WorldPositionOffset',
  'Refraction', 'AmbientOcclusion', 'PixelDepthOffset',
  'SubsurfaceColor', 'ClearCoat', 'ClearCoatRoughness',
];

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

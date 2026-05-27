import { jsx as _jsx } from "react/jsx-runtime";
import { MaterialNode } from './MaterialNode';
export const MATERIAL_OUTPUT_PINS = [
    'BaseColor', 'Metallic', 'Specular', 'Roughness', 'EmissiveColor',
    'Opacity', 'OpacityMask', 'Normal', 'WorldPositionOffset',
    'Refraction', 'AmbientOcclusion', 'PixelDepthOffset',
    'SubsurfaceColor', 'ClearCoat', 'ClearCoatRoughness',
];
export function MaterialOutputNode(props) {
    const data = {
        id: props.data.id,
        label: 'Material Output',
        inputs: MATERIAL_OUTPUT_PINS.map(n => ({ name: n, type: 'Float' })),
        outputs: [],
        params: props.data.params,
        warning: props.data.warning,
        isReserved: true,
    };
    return _jsx(MaterialNode, { data: data });
}

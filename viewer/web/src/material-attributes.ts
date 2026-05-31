// The 15 MaterialAttributes pin names — the inputs of UE's MakeMaterialAttributes
// node and, identically, the attribute inputs of a MaterialOutput root node. This
// is the single canonical list; the export emitter (ueT3D) and the editor node
// (MaterialOutputNode) both import it so the two cannot drift apart.
export const MATERIAL_ATTRIBUTE_PINS = [
  'BaseColor', 'Metallic', 'Specular', 'Roughness', 'EmissiveColor', 'Opacity', 'OpacityMask',
  'Normal', 'WorldPositionOffset', 'Refraction', 'AmbientOcclusion', 'PixelDepthOffset',
  'SubsurfaceColor', 'ClearCoat', 'ClearCoatRoughness',
];

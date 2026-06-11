// The 15 MaterialAttributes pin names — the inputs of UE's MakeMaterialAttributes
// node and, identically, the attribute inputs of a MaterialOutput root node. This
// is the single canonical list (node-free so the web can import it too); the
// export emitter (web ueT3D), the editor node (MaterialOutputNode), and the
// server-side write gate (agent/pin-validate) all consume it so none can drift.
export const MATERIAL_ATTRIBUTE_PINS = [
  'BaseColor', 'Metallic', 'Specular', 'Roughness', 'EmissiveColor', 'Opacity', 'OpacityMask',
  'Normal', 'WorldPositionOffset', 'Refraction', 'AmbientOcclusion', 'PixelDepthOffset',
  'SubsurfaceColor', 'ClearCoat', 'ClearCoatRoughness',
];

// MaterialOutput accepts every attribute pin plus the single bundled
// MaterialAttributes input (used when "Use Material Attributes" is on).
export const MATERIAL_OUTPUT_PINS = [...MATERIAL_ATTRIBUTE_PINS, 'MaterialAttributes'];

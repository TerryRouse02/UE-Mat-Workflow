// Internal MaterialAttributes name -> { display, guid } for the dynamic-pin
// MaterialAttributes family (Set/GetMaterialAttributes). UE identifies each
// set/got attribute by an FMaterialAttributeDefinitionMap FGuid emitted as
// AttributeSetTypes(n)/AttributeGetTypes(n); the InputName/OutputName carries
// the human display name. Both are UE-internal data, so per the tool's
// "never invent UE format" rule we populate ONLY rows captured verbatim from
// real UE 5.7 clipboard fixtures — never hand-guessed.
//
// Captured from (GUIDs identical across both, confirming the definition map):
//   viewer/tests/fixtures/ue-set-material-attributes.t3d  (AttributeSetTypes)
//   viewer/tests/fixtures/ue-get-material-attributes.t3d  (AttributeGetTypes)
//
// This is the FALLBACK. The exporter prefers the full, commandlet-generated map in
// nodes-ue5.7.export.json (`materialAttributes`) when present — see buildAttributeTable in
// export/ueT3D.ts — and only uses these three when that section is absent. To get full
// coverage, regenerate export.json via tools/node-t3d-metadata/Invoke-NodeT3DMetadataMaintenance.ps1
// on the UE host. An attribute in neither source is dropped with a warning, not invented.
export interface MaterialAttributeGuid { display: string; guid: string; }

export const MATERIAL_ATTRIBUTE_GUIDS: Record<string, MaterialAttributeGuid> = {
  BaseColor: { display: 'Base Color', guid: '69B8D33616ED4D499AA497292F050F7A' },
  Roughness: { display: 'Roughness', guid: 'D1DD967C4CAD47D39E6346FB08ECF210' },
  Metallic: { display: 'Metallic', guid: '57C3A1617F064296B00B24A5A496F34C' },
};

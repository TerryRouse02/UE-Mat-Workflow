// Single source of truth: canonical UE T3D array-element properties for the
// material-expression nodes whose authoring-DB pin names map onto a UE array
// property (FExpressionInput Inputs[] / FVector2MaterialInput CustomizedUVs[]).
//
// Why this exists. The export commandlet resolves an input pin's T3D property via
// ResolveInputProperty, which only has a hardcoded override table covering a
// subset of these switch pins (QualitySwitch Low/High, FeatureLevelSwitch
// ES2..SM5). For the pins it does NOT cover (QualitySwitch Medium/Epic,
// FeatureLevelSwitch SM6) and for every MakeMaterialAttributes.CustomizedUVs_*
// pin, a fresh crawl emits the raw DB pin name instead of the "(N)"
// array-element form that UE paste requires. The parity audit only checks pin
// NAMES, not property VALUES, so it never caught the regression. heal-export-meta.js
// re-applies these values after every crawl; audit-export-meta.js now flags drift.
//
// These are stock Epic UE 5.7 expression properties (no project-specific data).
// Keep this list in lockstep with the matching pins in agent-pack/nodes-ue5.7.json.
//
// The index inside each "(N)" is the UE array slot, NOT the DB pin order: the switch
// values follow UE's own enums (EMaterialQualityLevel: Low=0, High=1, Medium=2,
// Epic=3; ERHIFeatureLevel slots for FeatureLevelSwitch: ES2=0, ES3.1=1, SM4=2, SM5=3,
// SM6=4), and CustomizedUVs(0..7) is the MakeMaterialAttributes array index. The full
// set per node is enforced (not just the pins that currently regress) so the heal stays
// correct no matter which pins a future commandlet build happens to emit raw; if a UE
// version ever reorders an enum, update both these indices and the override table in
// plugin-src/.../UEMatExportMetadataCommandlet.cpp (ResolveInputProperty) together.

const ARRAY_PIN_PROPERTIES = {
  MakeMaterialAttributes: {
    CustomizedUVs_0: 'CustomizedUVs(0)',
    CustomizedUVs_1: 'CustomizedUVs(1)',
    CustomizedUVs_2: 'CustomizedUVs(2)',
    CustomizedUVs_3: 'CustomizedUVs(3)',
    CustomizedUVs_4: 'CustomizedUVs(4)',
    CustomizedUVs_5: 'CustomizedUVs(5)',
    CustomizedUVs_6: 'CustomizedUVs(6)',
    CustomizedUVs_7: 'CustomizedUVs(7)',
  },
  QualitySwitch: {
    Low: 'Inputs(0)',
    High: 'Inputs(1)',
    Medium: 'Inputs(2)',
    Epic: 'Inputs(3)',
  },
  FeatureLevelSwitch: {
    ES2: 'Inputs(0)',
    'ES3.1': 'Inputs(1)',
    SM4: 'Inputs(2)',
    SM5: 'Inputs(3)',
    SM6: 'Inputs(4)',
  },
};

// Report every canonical array pin that is PRESENT in the export object but whose
// `property` differs from the canonical "(N)" form. Returns
// [{ node, pin, expected, actual }]. Pins absent from an export node are ignored
// here — absence is the audit's `missing`/`missingMaps` concern, not drift.
function findArrayPinDrift(exportObj) {
  const drift = [];
  const nodes = exportObj && typeof exportObj.nodes === 'object' && exportObj.nodes !== null
    ? exportObj.nodes
    : {};
  for (const [node, pins] of Object.entries(ARRAY_PIN_PROPERTIES)) {
    const meta = nodes[node];
    const inputs = meta && typeof meta.inputs === 'object' && meta.inputs !== null
      ? meta.inputs
      : null;
    if (!inputs) continue;
    for (const [pin, expected] of Object.entries(pins)) {
      const entry = inputs[pin];
      if (!entry || typeof entry !== 'object') continue;
      const actual = entry.property;
      if (typeof actual !== 'string') continue;
      if (actual !== expected) {
        drift.push({ node, pin, expected, actual });
      }
    }
  }
  return drift;
}

module.exports = { ARRAY_PIN_PROPERTIES, findArrayPinDrift };

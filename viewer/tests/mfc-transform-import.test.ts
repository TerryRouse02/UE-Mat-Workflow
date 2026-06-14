import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseUET3D, graphToUET3D } from '../web/src/export/ueT3D';
import type { ExportMeta } from '../web/src/export/export-meta-types';
import type { DerivedPins } from '../web/src/protocol';

const META = JSON.parse(
  readFileSync(resolve(__dirname, '../../agent-pack/nodes-ue5.7.export.json'), 'utf-8'),
) as ExportMeta;

const ROOT = '/Engine/Transient.X:MaterialGraph_0';

// ---------------------------------------------------------------------------
// Regression: MaterialExpressionTransform serialises its input as `Input=`, and
// the export metadata must map a graph pin named "Input" to that property. A
// stale entry (the old "VectorInput") makes the importer's property→pin lookup
// miss, silently dropping the wire (this is what broke GetMaterialAttributes →
// Transform round-trips). Constant -> Transform.Input must survive.
// ---------------------------------------------------------------------------
const transformFixture = `
Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_0" ExportPath="/Script/UnrealEd.MaterialGraphNode'${ROOT}.MaterialGraphNode_0'"
   Begin Object Class=/Script/Engine.MaterialExpressionConstant Name="MaterialExpressionConstant_0" ExportPath="/Script/Engine.MaterialExpressionConstant'${ROOT}.MaterialGraphNode_0.MaterialExpressionConstant_0'"
   End Object
   Begin Object Name="MaterialExpressionConstant_0" ExportPath="/Script/Engine.MaterialExpressionConstant'${ROOT}.MaterialGraphNode_0.MaterialExpressionConstant_0'"
      R=0.500000
   End Object
   MaterialExpression="/Script/Engine.MaterialExpressionConstant'MaterialExpressionConstant_0'"
   NodePosX=0
   NodePosY=0
   CustomProperties Pin (PinId=00000000000000000000000000000001,PinName="Output",Direction="EGPD_Output",)
End Object
Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_1" ExportPath="/Script/UnrealEd.MaterialGraphNode'${ROOT}.MaterialGraphNode_1'"
   Begin Object Class=/Script/Engine.MaterialExpressionTransform Name="MaterialExpressionTransform_0" ExportPath="/Script/Engine.MaterialExpressionTransform'${ROOT}.MaterialGraphNode_1.MaterialExpressionTransform_0'"
   End Object
   Begin Object Name="MaterialExpressionTransform_0" ExportPath="/Script/Engine.MaterialExpressionTransform'${ROOT}.MaterialGraphNode_1.MaterialExpressionTransform_0'"
      Input=(Expression="/Script/Engine.MaterialExpressionConstant'MaterialGraphNode_0.MaterialExpressionConstant_0'")
   End Object
   MaterialExpression="/Script/Engine.MaterialExpressionTransform'MaterialExpressionTransform_0'"
   NodePosX=200
   NodePosY=0
   CustomProperties Pin (PinId=00000000000000000000000000000002,PinName="Input",PinFriendlyName=NSLOCTEXT("MaterialGraphNode", "Space", " "),)
   CustomProperties Pin (PinId=00000000000000000000000000000003,PinName="Output",Direction="EGPD_Output",)
End Object
`.trim();

describe('parseUET3D — Transform input property', () => {
  it('keeps the wire into Transform.Input (regression: was dropped when meta said "VectorInput")', () => {
    const { graph, warnings } = parseUET3D(transformFixture, META, { name: 't' });
    expect(graph.connections).toContainEqual({ from: 'Constant_0:Value', to: 'Transform_0:Input' });
    expect(warnings.filter(w => /no pin mapping in metadata/.test(w))).toEqual([]);
  });

  it('re-exports Transform with the UE `Input=` property, not the stale VectorInput', () => {
    const { graph } = parseUET3D(transformFixture, META, { name: 't' });
    const layout = Object.fromEntries(graph.nodes.map(n => [n.id, { x: 0, y: 0 }]));
    const { text, warnings } = graphToUET3D(graph, layout, META, {});
    expect(text).toMatch(/Input=\(Expression=/);
    expect(text).not.toMatch(/VectorInput=\(Expression=/);
    expect(warnings.filter(w => /has no UE mapping - connection skipped/.test(w))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regression: a MaterialFunctionCall's graph pins carry UE type-tags
// ("UVs (V2)", "Rotation Angle (0-1) (S)"), but the function's real input names
// (in the MF index / FunctionInputs InputName) are plain. The importer must
// record the plain name so multi-input MFs don't all collapse to
// FunctionInputs(0) on re-export. Two distinct inputs must stay distinct.
// ---------------------------------------------------------------------------
const CUSTOM_ROTATOR = '/Engine/Functions/Engine_MaterialFunctions02/Texturing/CustomRotator.CustomRotator';
const mfcFixture = `
Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_0" ExportPath="/Script/UnrealEd.MaterialGraphNode'${ROOT}.MaterialGraphNode_0'"
   Begin Object Class=/Script/Engine.MaterialExpressionConstant Name="MaterialExpressionConstant_0" ExportPath="/Script/Engine.MaterialExpressionConstant'${ROOT}.MaterialGraphNode_0.MaterialExpressionConstant_0'"
   End Object
   Begin Object Name="MaterialExpressionConstant_0" ExportPath="/Script/Engine.MaterialExpressionConstant'${ROOT}.MaterialGraphNode_0.MaterialExpressionConstant_0'"
      R=0.500000
   End Object
   MaterialExpression="/Script/Engine.MaterialExpressionConstant'MaterialExpressionConstant_0'"
   NodePosX=0
   NodePosY=0
   CustomProperties Pin (PinId=000000000000000000000000000000A0,PinName="Output",Direction="EGPD_Output",)
End Object
Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_1" ExportPath="/Script/UnrealEd.MaterialGraphNode'${ROOT}.MaterialGraphNode_1'"
   Begin Object Class=/Script/Engine.MaterialExpressionConstant Name="MaterialExpressionConstant_1" ExportPath="/Script/Engine.MaterialExpressionConstant'${ROOT}.MaterialGraphNode_1.MaterialExpressionConstant_1'"
   End Object
   Begin Object Name="MaterialExpressionConstant_1" ExportPath="/Script/Engine.MaterialExpressionConstant'${ROOT}.MaterialGraphNode_1.MaterialExpressionConstant_1'"
      R=0.250000
   End Object
   MaterialExpression="/Script/Engine.MaterialExpressionConstant'MaterialExpressionConstant_1'"
   NodePosX=0
   NodePosY=100
   CustomProperties Pin (PinId=000000000000000000000000000000A1,PinName="Output",Direction="EGPD_Output",)
End Object
Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_2" ExportPath="/Script/UnrealEd.MaterialGraphNode'${ROOT}.MaterialGraphNode_2'"
   Begin Object Class=/Script/Engine.MaterialExpressionMaterialFunctionCall Name="MaterialExpressionMaterialFunctionCall_0" ExportPath="/Script/Engine.MaterialExpressionMaterialFunctionCall'${ROOT}.MaterialGraphNode_2.MaterialExpressionMaterialFunctionCall_0'"
   End Object
   Begin Object Name="MaterialExpressionMaterialFunctionCall_0" ExportPath="/Script/Engine.MaterialExpressionMaterialFunctionCall'${ROOT}.MaterialGraphNode_2.MaterialExpressionMaterialFunctionCall_0'"
      MaterialFunction="/Script/Engine.MaterialFunction'${CUSTOM_ROTATOR}'"
      FunctionInputs(0)=(ExpressionInputId=45DE7CC04BCC975C664A2AA5DA134FEF,Input=(Expression="/Script/Engine.MaterialExpressionConstant'MaterialGraphNode_0.MaterialExpressionConstant_0'",InputName="UVs"))
      FunctionInputs(1)=(ExpressionInputId=9B6953874136DCE4D8E4E8878152CCCE,Input=(OutputIndex=-1,InputName="Rotation Center"))
      FunctionInputs(2)=(ExpressionInputId=D58F67D84CFD4C9D289810AEE4A3EBC8,Input=(Expression="/Script/Engine.MaterialExpressionConstant'MaterialGraphNode_1.MaterialExpressionConstant_1'",InputName="Rotation Angle (0-1)"))
   End Object
   MaterialExpression="/Script/Engine.MaterialExpressionMaterialFunctionCall'MaterialExpressionMaterialFunctionCall_0'"
   NodePosX=200
   NodePosY=0
   CustomProperties Pin (PinId=000000000000000000000000000000B0,PinName="UVs (V2)",)
   CustomProperties Pin (PinId=000000000000000000000000000000B1,PinName="Rotation Center (V2)",)
   CustomProperties Pin (PinId=000000000000000000000000000000B2,PinName="Rotation Angle (0-1) (S)",)
   CustomProperties Pin (PinId=000000000000000000000000000000B3,PinName="Result",Direction="EGPD_Output",)
End Object
`.trim();

describe('parseUET3D — MaterialFunctionCall input pin names', () => {
  it('records plain FunctionInputs names, not the type-tagged graph pins', () => {
    const { graph } = parseUET3D(mfcFixture, META, { name: 'm' });
    // Both wires land on distinct, plain-named pins — not collapsed onto one suffixed pin.
    expect(graph.connections).toContainEqual({ from: 'Constant_0:Value', to: 'MaterialFunctionCall_0:UVs' });
    expect(graph.connections).toContainEqual({ from: 'Constant_1:Value', to: 'MaterialFunctionCall_0:Rotation Angle (0-1)' });
    // No connection terminates on a UE type-tagged pin name.
    expect(graph.connections.some(c => /\((V2|V3|V4|S|B|MA)\)$/.test(c.to))).toBe(false);
  });

  it('re-exports both inputs to distinct FunctionInputs indices when the MF pins are derived', () => {
    const { graph } = parseUET3D(mfcFixture, META, { name: 'm' });
    const layout = Object.fromEntries(graph.nodes.map(n => [n.id, { x: 0, y: 0 }]));
    // Engine-index pins for CustomRotator (plain names, UE order).
    const derived: Record<string, DerivedPins> = {
      MaterialFunctionCall_0: {
        inputs: [
          { name: 'UVs', type: 'Float2' },
          { name: 'Rotation Center', type: 'Float2' },
          { name: 'Rotation Angle (0-1)', type: 'Float1' },
        ],
        outputs: [{ name: 'Result', type: 'Float2' }],
      },
    };
    const { text, warnings } = graphToUET3D(graph, layout, META, derived);
    // UVs -> index 0, Rotation Angle (0-1) -> index 2 (distinct, not both 0); the unwired
    // Rotation Center fills index 1 as OutputIndex=-1 so the full signature rides the clipboard.
    expect(text).toMatch(/FunctionInputs\(0\)=\(ExpressionInputId=[0-9A-F]{32},Input=\(Expression=/);
    expect(text).toMatch(/FunctionInputs\(1\)=\(ExpressionInputId=[0-9A-F]{32},Input=\(OutputIndex=-1,InputName="Rotation Center"\)\)/);
    expect(text).toMatch(/FunctionInputs\(2\)=\(ExpressionInputId=[0-9A-F]{32},Input=\(Expression=/);
    expect(warnings.filter(w => /defaulting to FunctionInputs\(0\)/.test(w))).toEqual([]);
  });
});

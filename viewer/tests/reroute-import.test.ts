import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseUET3D } from '../web/src/export/ueT3D';
import type { ExportMeta } from '../web/src/export/export-meta-types';

const META = JSON.parse(readFileSync(resolve(__dirname, '../../agent-pack/nodes-ue5.7.export.json'), 'utf-8')) as ExportMeta;

// A reroute (Knot) is a pure passthrough: Constant -> Reroute -> Multiply.A.
// UE writes the destination's wire as pointing at the reroute, so without
// collapse the wire dangles ("source not found"). The importer must re-point it
// at the reroute's own upstream (the Constant).
const ROOT = '/Engine/Transient.X:MaterialGraph_0';
const knotFixture = `
Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_0" ExportPath="/Script/UnrealEd.MaterialGraphNode'${ROOT}.MaterialGraphNode_0'"
   Begin Object Class=/Script/Engine.MaterialExpressionConstant Name="MaterialExpressionConstant_0" ExportPath="/Script/Engine.MaterialExpressionConstant'${ROOT}.MaterialGraphNode_0.MaterialExpressionConstant_0'"
   End Object
   Begin Object Name="MaterialExpressionConstant_0" ExportPath="/Script/Engine.MaterialExpressionConstant'${ROOT}.MaterialGraphNode_0.MaterialExpressionConstant_0'"
      R=0.500000
      MaterialExpressionEditorX=0
      MaterialExpressionEditorY=0
   End Object
   MaterialExpression="/Script/Engine.MaterialExpressionConstant'MaterialExpressionConstant_0'"
   NodePosX=0
   NodePosY=0
   CustomProperties Pin (PinId=00000000000000000000000000000001,PinName="Output",Direction="EGPD_Output",)
End Object
Begin Object Class=/Script/UnrealEd.MaterialGraphNode_Knot Name="MaterialGraphNode_Knot_0" ExportPath="/Script/UnrealEd.MaterialGraphNode_Knot'${ROOT}.MaterialGraphNode_Knot_0'"
   Begin Object Class=/Script/Engine.MaterialExpressionReroute Name="MaterialExpressionReroute_0" ExportPath="/Script/Engine.MaterialExpressionReroute'${ROOT}.MaterialGraphNode_Knot_0.MaterialExpressionReroute_0'"
   End Object
   Begin Object Name="MaterialExpressionReroute_0" ExportPath="/Script/Engine.MaterialExpressionReroute'${ROOT}.MaterialGraphNode_Knot_0.MaterialExpressionReroute_0'"
      Input=(Expression="/Script/Engine.MaterialExpressionConstant'MaterialGraphNode_0.MaterialExpressionConstant_0'")
   End Object
   MaterialExpression="/Script/Engine.MaterialExpressionReroute'MaterialExpressionReroute_0'"
   NodePosX=100
   NodePosY=0
End Object
Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_1" ExportPath="/Script/UnrealEd.MaterialGraphNode'${ROOT}.MaterialGraphNode_1'"
   Begin Object Class=/Script/Engine.MaterialExpressionMultiply Name="MaterialExpressionMultiply_0" ExportPath="/Script/Engine.MaterialExpressionMultiply'${ROOT}.MaterialGraphNode_1.MaterialExpressionMultiply_0'"
   End Object
   Begin Object Name="MaterialExpressionMultiply_0" ExportPath="/Script/Engine.MaterialExpressionMultiply'${ROOT}.MaterialGraphNode_1.MaterialExpressionMultiply_0'"
      A=(Expression="/Script/Engine.MaterialExpressionReroute'MaterialGraphNode_Knot_0.MaterialExpressionReroute_0'")
      MaterialExpressionEditorX=200
      MaterialExpressionEditorY=0
   End Object
   MaterialExpression="/Script/Engine.MaterialExpressionMultiply'MaterialExpressionMultiply_0'"
   NodePosX=200
   NodePosY=0
   CustomProperties Pin (PinId=00000000000000000000000000000002,PinName="A",)
   CustomProperties Pin (PinId=00000000000000000000000000000003,PinName="B",)
End Object
`.trim();

describe('parseUET3D — reroute (Knot) collapse', () => {
  it('re-points a wire sourced from a reroute at the reroute\'s upstream', () => {
    const { graph, warnings } = parseUET3D(knotFixture, META, { name: 'r' });

    // The reroute itself is collapsed (not emitted as a node).
    expect(graph.nodes.map(n => n.type)).toEqual(['Constant', 'Multiply']);
    // The Multiply.A wire now comes straight from the Constant, not the reroute.
    expect(graph.connections).toContainEqual({ from: 'Constant_0:Value', to: 'Multiply_0:A' });
    // No dangling-source warning — the wire was recovered, not dropped.
    expect(warnings.filter(w => /not found - wire dropped/.test(w))).toEqual([]);
  });

  it('collapses a chain of reroutes transitively', () => {
    // Constant -> Reroute_0 -> Reroute_1 -> Multiply.A
    const chained = knotFixture.replace(
      'A=(Expression="/Script/Engine.MaterialExpressionReroute\'MaterialGraphNode_Knot_0.MaterialExpressionReroute_0\'")',
      'A=(Expression="/Script/Engine.MaterialExpressionReroute\'MaterialGraphNode_Knot_1.MaterialExpressionReroute_1\'")',
    ).replace('End Object\nBegin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_1"',
      `End Object
Begin Object Class=/Script/UnrealEd.MaterialGraphNode_Knot Name="MaterialGraphNode_Knot_1" ExportPath="/Script/UnrealEd.MaterialGraphNode_Knot'${ROOT}.MaterialGraphNode_Knot_1'"
   Begin Object Class=/Script/Engine.MaterialExpressionReroute Name="MaterialExpressionReroute_1" ExportPath="/Script/Engine.MaterialExpressionReroute'${ROOT}.MaterialGraphNode_Knot_1.MaterialExpressionReroute_1'"
   End Object
   Begin Object Name="MaterialExpressionReroute_1" ExportPath="/Script/Engine.MaterialExpressionReroute'${ROOT}.MaterialGraphNode_Knot_1.MaterialExpressionReroute_1'"
      Input=(Expression="/Script/Engine.MaterialExpressionReroute'MaterialGraphNode_Knot_0.MaterialExpressionReroute_0'")
   End Object
   MaterialExpression="/Script/Engine.MaterialExpressionReroute'MaterialExpressionReroute_1'"
   NodePosX=150
   NodePosY=0
End Object
Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_1"`);

    const { graph, warnings } = parseUET3D(chained, META, { name: 'r' });
    expect(graph.connections).toContainEqual({ from: 'Constant_0:Value', to: 'Multiply_0:A' });
    expect(warnings.filter(w => /not found - wire dropped/.test(w))).toEqual([]);
  });

  // The knot fixture is expression-only (Constant -> Multiply), no MaterialGraphNode_Root —
  // i.e. a partial selection where the final output wires were never copied. Surface that.
  it('warns when the paste has no material output (root not selected)', () => {
    const { graph, warnings } = parseUET3D(knotFixture, META, { name: 'r' });
    expect(graph.nodes.some(n => n.type === 'MaterialOutput')).toBe(false);
    expect(warnings.some(w => /No material output was in the pasted selection/.test(w))).toBe(true);
  });
});

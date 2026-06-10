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

// A full material dump (e.g. the projectmat crawl) always includes the MaterialGraphNode_Root.
// When the material's final output is routed through a reroute (Knot) — extremely common for
// "Use Material Attributes" materials — the root pin's LinkedTo points at the knot's *output*
// pin, not the upstream expression's. Knot output pins are not indexed as expression sources,
// so the synthesis used to drop the wire and emit zero MaterialOutput nodes, tripping the
// "Material must have exactly one MaterialOutput" diagnostic. These fixtures carry the root +
// its pin-id wiring exactly as UE's FEdGraphUtilities::ExportNodesToText writes it.
const ROOT_DECL = (pins: string) => `
Begin Object Class=/Script/UnrealEd.MaterialGraphNode_Root Name="MaterialGraphNode_Root_0" ExportPath="/Script/UnrealEd.MaterialGraphNode_Root'${ROOT}.MaterialGraphNode_Root_0'"
   NodeGuid=00000000000000000000000000000099
${pins}
End Object`;

// Constant -> Knot -> Root."Material Attributes". The knot carries its connectivity on its own
// graph pins (InputPin LinkedTo the Constant's output pin; OutputPin LinkedTo the root pin),
// which is how UE serialises a reroute that sits on the material's final wire.
const rootViaKnotFixture = `
Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_0" ExportPath="/Script/UnrealEd.MaterialGraphNode'${ROOT}.MaterialGraphNode_0'"
   Begin Object Class=/Script/Engine.MaterialExpressionConstant Name="MaterialExpressionConstant_0" ExportPath="/Script/Engine.MaterialExpressionConstant'${ROOT}.MaterialGraphNode_0.MaterialExpressionConstant_0'"
   End Object
   Begin Object Name="MaterialExpressionConstant_0" ExportPath="/Script/Engine.MaterialExpressionConstant'${ROOT}.MaterialGraphNode_0.MaterialExpressionConstant_0'"
      R=0.500000
   End Object
   MaterialExpression="/Script/Engine.MaterialExpressionConstant'MaterialExpressionConstant_0'"
   NodePosX=0
   NodePosY=0
   CustomProperties Pin (PinId=000000000000000000000000000000C1,PinName="Output",Direction="EGPD_Output",)
End Object
Begin Object Class=/Script/UnrealEd.MaterialGraphNode_Knot Name="MaterialGraphNode_Knot_0" ExportPath="/Script/UnrealEd.MaterialGraphNode_Knot'${ROOT}.MaterialGraphNode_Knot_0'"
   Begin Object Class=/Script/Engine.MaterialExpressionReroute Name="MaterialExpressionReroute_0" ExportPath="/Script/Engine.MaterialExpressionReroute'${ROOT}.MaterialGraphNode_Knot_0.MaterialExpressionReroute_0'"
   End Object
   Begin Object Name="MaterialExpressionReroute_0" ExportPath="/Script/Engine.MaterialExpressionReroute'${ROOT}.MaterialGraphNode_Knot_0.MaterialExpressionReroute_0'"
   End Object
   MaterialExpression="/Script/Engine.MaterialExpressionReroute'MaterialExpressionReroute_0'"
   NodePosX=100
   NodePosY=0
   CustomProperties Pin (PinId=000000000000000000000000000000A1,PinName="InputPin",PinType.PinCategory="wildcard",LinkedTo=(MaterialGraphNode_0 000000000000000000000000000000C1,),)
   CustomProperties Pin (PinId=000000000000000000000000000000B1,PinName="OutputPin",Direction="EGPD_Output",PinType.PinCategory="wildcard",LinkedTo=(MaterialGraphNode_Root_0 000000000000000000000000000000D1,),)
End Object${ROOT_DECL('   CustomProperties Pin (PinId=000000000000000000000000000000D1,PinName="Material Attributes",PinType.PinCategory="materialinput",PinType.PinSubCategory="rgba",LinkedTo=(MaterialGraphNode_Knot_0 000000000000000000000000000000B1,),)')}
`.trim();

// A material whose root node is present but has no connected pins (e.g. all values set as
// constants in the details panel). The full dump still includes the root, so this is NOT a
// partial paste — synthesize one empty MaterialOutput rather than warn about an un-copied
// selection.
const emptyRootFixture = ROOT_DECL(
  '   CustomProperties Pin (PinId=000000000000000000000000000000D1,PinName="Base Color",PinType.PinCategory="materialinput",PinType.PinSubCategory="rgba",DefaultValue="(R=0.5,G=0.5,B=0.5,A=1.0)",)',
).trim();

describe('parseUET3D — material output through a reroute / fully-dumped root', () => {
  it('recovers the material output when the root is wired through a reroute (knot)', () => {
    const { graph, warnings } = parseUET3D(rootViaKnotFixture, META, { name: 'r' });
    expect(graph.type).toBe('Material');
    const outs = graph.nodes.filter(n => n.type === 'MaterialOutput');
    expect(outs).toHaveLength(1);
    // The Material Attributes wire is recovered straight from the Constant, through the knot.
    expect(graph.connections).toContainEqual({ from: 'Constant_0:Value', to: `${outs[0].id}:MaterialAttributes` });
    expect(warnings.filter(w => /not found - wire dropped/.test(w))).toEqual([]);
  });

  it('emits a single empty MaterialOutput for a fully-dumped material with no wired root pins', () => {
    const { graph, warnings } = parseUET3D(emptyRootFixture, META, { name: 'r' });
    expect(graph.type).toBe('Material');
    expect(graph.nodes.filter(n => n.type === 'MaterialOutput')).toHaveLength(1);
    // Root was present in the dump → not a partial paste → no "Select All" warning.
    expect(warnings.some(w => /No material output was in the pasted selection/.test(w))).toBe(false);
  });
});

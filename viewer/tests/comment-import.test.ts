import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseUET3D } from '../web/src/export/ueT3D';
import type { ExportMeta } from '../web/src/export/export-meta-types';

const META = JSON.parse(
  readFileSync(resolve(__dirname, '../../agent-pack/nodes-ue5.7.export.json'), 'utf-8'),
) as ExportMeta;

const ROOT = '/Engine/Transient.X:MaterialGraph_0';

// ---------------------------------------------------------------------------
// Regression: UE omits the graph-node NodeWidth/NodeHeight when they equal the
// comment CDO default (default width 400). A default-WIDTH comment therefore ships
// with NO NodeWidth line — only the inner MaterialExpressionComment's SizeX. The
// importer used to default the missing NodeWidth to 0, collapsing the box to zero
// width so its geometric `contains` came back empty and the entire comment frame
// disappeared on import (real case: M_RayMarchCloud2D's "Six-way lighting方案",
// width exactly 400). The importer must fall back to the inner SizeX/SizeY.
// ---------------------------------------------------------------------------
const node = (i: number, x: number, y: number) => `
Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name="MaterialGraphNode_${i}" ExportPath="/Script/UnrealEd.MaterialGraphNode'${ROOT}.MaterialGraphNode_${i}'"
   Begin Object Class=/Script/Engine.MaterialExpressionConstant Name="MaterialExpressionConstant_${i}" ExportPath="/Script/Engine.MaterialExpressionConstant'${ROOT}.MaterialGraphNode_${i}.MaterialExpressionConstant_${i}'"
   End Object
   Begin Object Name="MaterialExpressionConstant_${i}" ExportPath="/Script/Engine.MaterialExpressionConstant'${ROOT}.MaterialGraphNode_${i}.MaterialExpressionConstant_${i}'"
      R=0.500000
   End Object
   MaterialExpression="/Script/Engine.MaterialExpressionConstant'MaterialExpressionConstant_${i}'"
   NodePosX=${x}
   NodePosY=${y}
   CustomProperties Pin (PinId=0000000000000000000000000000000${i},PinName="Output",Direction="EGPD_Output",)
End Object`;

// Comment whose graph-node block OMITS NodeWidth (default width 400) — only the
// inner expression carries SizeX. NodeHeight is present (non-default), as UE does.
const defaultWidthComment = `
Begin Object Class=/Script/UnrealEd.MaterialGraphNode_Comment Name="MaterialGraphNode_Comment_0" ExportPath="/Script/UnrealEd.MaterialGraphNode_Comment'${ROOT}.MaterialGraphNode_Comment_0'"
   Begin Object Class=/Script/Engine.MaterialExpressionComment Name="MaterialExpressionComment_0" ExportPath="/Script/Engine.MaterialExpressionComment'${ROOT}.MaterialGraphNode_Comment_0.MaterialExpressionComment_0'"
   End Object
   Begin Object Name="MaterialExpressionComment_0" ExportPath="/Script/Engine.MaterialExpressionComment'${ROOT}.MaterialGraphNode_Comment_0.MaterialExpressionComment_0'"
      SizeX=400
      SizeY=300
      Text="Default Width"
   End Object
   MaterialExpressionComment="/Script/Engine.MaterialExpressionComment'MaterialExpressionComment_0'"
   NodePosX=0
   NodePosY=0
   NodeHeight=300
   NodeComment="Default Width"
End Object`;

describe('parseUET3D — comment box size', () => {
  it('recovers a comment box width from inner SizeX when graph-node NodeWidth is omitted', () => {
    // Node at (100,100) sits inside the box [0,400]x[0,300] — but ONLY if width is read
    // from SizeX (400). With the old NodeWidth??0 default the box was [0,0] and captured nothing.
    const t3d = `${node(0, 100, 100)}\n${defaultWidthComment}`.trim();
    const { graph } = parseUET3D(t3d, META, { name: 'm' });
    expect(graph.comments).toBeDefined();
    expect(graph.comments!).toHaveLength(1);
    const constantId = graph.nodes.find(n => n.type === 'Constant')!.id;
    expect(graph.comments![0].text).toBe('Default Width');
    expect(graph.comments![0].contains).toContain(constantId);
  });

  it('still honours an explicit NodeWidth over the inner SizeX', () => {
    // A narrow box (NodeWidth=120) must NOT capture a node at x=300, even though SizeX would.
    const wide = defaultWidthComment.replace('NodeHeight=300', 'NodeWidth=120\n   NodeHeight=300');
    const t3d = `${node(0, 300, 100)}\n${wide}`.trim();
    const { graph } = parseUET3D(t3d, META, { name: 'm' });
    expect(graph.comments![0].contains).toHaveLength(0);
  });
});

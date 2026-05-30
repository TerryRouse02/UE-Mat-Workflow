import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { graphToUET3D, parseUET3D } from '../web/src/export/ueT3D';
import type { ExportMeta } from '../web/src/export/export-meta-types';
import type { MatGraph, DerivedPins } from '../web/src/protocol';

const META: ExportMeta = {
  schemaVersion: '1.0', ueVersion: '5.7', nodes: {
    Multiply: { ueClass: '/Script/Engine.MaterialExpressionMultiply',
      inputs: { A: { property: 'A' }, B: { property: 'B' } }, outputs: { Result: { index: 0 } },
      params: { ConstB: { property: 'ConstB', kind: 'float' } } },
    Constant: { ueClass: '/Script/Engine.MaterialExpressionConstant',
      inputs: {}, outputs: { Value: { index: 0 } }, params: { R: { property: 'R', kind: 'float' } } },
    TextureSampleParameter2D: { ueClass: '/Script/Engine.MaterialExpressionTextureSampleParameter2D',
      inputs: { UVs: { property: 'Coordinates' } },
      outputs: { RGB: { index: 0 }, R: { index: 1 } },
      params: { SamplerType: { property: 'SamplerType', kind: 'enum', valueMap: { Normal: 'SAMPLERTYPE_Normal' } } } },
    BlendAngleCorrectedNormals: { ueClass: '/Script/Engine.MaterialExpressionMaterialFunctionCall',
      functionRefProperty: 'MaterialFunction',
      functionAsset: '/Engine/Functions/Engine_MaterialFunctions02/Utility/BlendAngleCorrectedNormals.BlendAngleCorrectedNormals',
      inputs: { BaseNormal: { property: 'FunctionInputs(0)' }, AdditionalNormal: { property: 'FunctionInputs(1)' } },
      outputs: { Result: { index: 0 } },
      params: {} },
  },
  reserved: {
    MaterialFunctionCall: { ueClass: '/Script/Engine.MaterialExpressionMaterialFunctionCall',
      functionRefProperty: 'MaterialFunction', inputs: {}, outputs: {}, params: {} },
    FunctionInput: { ueClass: '/Script/Engine.MaterialExpressionFunctionInput',
      inputs: {}, outputs: { Input: { index: 0 } },
      params: { InputName: { property: 'InputName', kind: 'name' } } },
    FunctionOutput: { ueClass: '/Script/Engine.MaterialExpressionFunctionOutput',
      inputs: { Input: { property: 'A' } }, outputs: {},
      params: { OutputName: { property: 'OutputName', kind: 'name' } } },
  },
};

const NO_PINS: Record<string, DerivedPins> = {};
const layout = (m: Record<string, [number, number]>) =>
  Object.fromEntries(Object.entries(m).map(([k, [x, y]]) => [k, { x, y }]));

describe('graphToUET3D', () => {
  it('emits two-pass objects with params, positions, and a connection', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 'c', type: 'Constant', params: { R: 2 } },
        { id: 'm', type: 'Multiply', params: { ConstB: 3 } },
      ],
      connections: [{ from: 'c:Value', to: 'm:A' }],
    };
    const { text, warnings } = graphToUET3D(graph, layout({ c: [-100, 0], m: [100, 0] }), META, NO_PINS);
    expect(warnings).toEqual([]);
    // pass 1 declares both classes
    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionConstant Name="MaterialExpressionConstant_0"');
    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionMultiply Name="MaterialExpressionMultiply_1"');
    // pass 2 fills properties
    expect(text).toContain('R=2.0');
    expect(text).toContain('ConstB=3.0');
    expect(text).toContain('A=(Expression=MaterialExpressionConstant_0,OutputIndex=0)');
    expect(text).toContain('MaterialExpressionEditorX=100');
    expect(text).toContain('MaterialExpressionEditorY=0');
  });

  it('emits a channel-mask connection for a sub-channel output', () => {
    const META2: ExportMeta = JSON.parse(JSON.stringify(META));
    META2.nodes.TextureSampleParameter2D.outputs.R = { index: 0, mask: 'R' };
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 't', type: 'TextureSampleParameter2D', params: { SamplerType: 'Normal' } },
        { id: 'm', type: 'Multiply' },
      ],
      connections: [{ from: 't:R', to: 'm:A' }],
    };
    const { text } = graphToUET3D(graph, layout({ t: [0, 0], m: [200, 0] }), META2, NO_PINS);
    expect(text).toContain('SamplerType=SAMPLERTYPE_Normal');
    expect(text).toContain('A=(Expression=MaterialExpressionTextureSampleParameter2D_0,OutputIndex=0,Mask=1,MaskR=1,MaskG=0,MaskB=0,MaskA=0)');
  });

  it('skips MaterialOutput with a warning and drops connections into it', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 'c', type: 'Constant', params: { R: 1 } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [{ from: 'c:Value', to: 'OUT:BaseColor' }],
    };
    const { text, warnings } = graphToUET3D(graph, layout({ c: [0, 0], OUT: [300, 0] }), META, NO_PINS);
    expect(text).not.toContain('MaterialOutput');
    expect(text).not.toContain('BaseColor');
    expect(warnings.some(w => /MaterialOutput.*manually/i.test(w))).toBe(true);
  });

  it('warns and skips a node type with no metadata', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [{ id: 'x', type: 'Fresnel' }],
      connections: [],
    };
    const { text, warnings } = graphToUET3D(graph, layout({ x: [0, 0] }), META, NO_PINS);
    expect(text.trim()).toBe('');
    expect(warnings.some(w => /Fresnel.*not exportable/i.test(w))).toBe(true);
  });

  it('emits a comment box sized around its contained nodes', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [{ id: 'c', type: 'Constant', params: { R: 1 } }],
      connections: [],
      comments: [{ id: 'k', text: 'group', color: '#ff0000', contains: ['c'] }],
    };
    const { text } = graphToUET3D(graph, layout({ c: [100, 50] }), META, NO_PINS);
    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionComment');
    expect(text).toContain('Text="group"');
    expect(text).toContain('CommentColor=(R=1.0,G=0.0,B=0.0,A=1.0)');
  });

  it('emits a MaterialFunctionCall with auto-link path + warning for a local MF', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 'src', type: 'Constant', params: { R: 1 } },
        { id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: './blend_normals.matgraph.json' } },
      ],
      connections: [{ from: 'src:Value', to: 'mfc:BaseNormal' }],
    };
    const derived: Record<string, DerivedPins> = {
      mfc: { inputs: [{ name: 'BaseNormal', type: 'Float3' }], outputs: [{ name: 'Result', type: 'Float3' }] },
    };
    const { text, warnings } = graphToUET3D(graph, layout({ src: [0, 0], mfc: [200, 0] }), META, derived, { mfContentRoot: '/Game/' });
    expect(text).toContain("MaterialFunction=MaterialFunction'\"/Game/blend_normals.blend_normals\"'");
    expect(text).toContain('FunctionInputs(0)=(Input=(Expression=MaterialExpressionConstant_0,OutputIndex=0))');
    expect(warnings.some(w => /blend_normals.*auto-link|create.*blend_normals/i.test(w))).toBe(true);
  });

  it('passes through an engine-path MaterialFunction without a warning', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [{ id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: '/Engine/Functions/Engine_MaterialFunctions02/Utility/Foo.Foo' } }],
      connections: [],
    };
    const { text, warnings } = graphToUET3D(graph, layout({ mfc: [0, 0] }), META, { mfc: { inputs: [], outputs: [] } });
    expect(text).toContain("MaterialFunction=MaterialFunction'\"/Engine/Functions/Engine_MaterialFunctions02/Utility/Foo.Foo\"'");
    expect(warnings).toEqual([]);
  });

  it('emits a built-in Material Function wrapper from metadata', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 'src', type: 'Constant', params: { R: 1 } },
        { id: 'blend', type: 'BlendAngleCorrectedNormals' },
      ],
      connections: [{ from: 'src:Value', to: 'blend:AdditionalNormal' }],
    };
    const { text, warnings } = graphToUET3D(graph, layout({ src: [0, 0], blend: [200, 0] }), META, NO_PINS);
    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionMaterialFunctionCall');
    expect(text).toContain("MaterialFunction=MaterialFunction'\"/Engine/Functions/Engine_MaterialFunctions02/Utility/BlendAngleCorrectedNormals.BlendAngleCorrectedNormals\"'");
    expect(text).toContain('FunctionInputs(1)=(Input=(Expression=MaterialExpressionConstant_0,OutputIndex=0))');
    expect(warnings).toEqual([]);
  });

  it('emits FunctionInput/FunctionOutput for an MF graph', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'MaterialFunction', name: 'fn',
      nodes: [
        { id: 'i', type: 'FunctionInput', params: { InputName: 'A', InputType: 'VectorFloat3' } },
        { id: 'o', type: 'FunctionOutput', params: { OutputName: 'Result' } },
      ],
      connections: [{ from: 'i:Input', to: 'o:Input' }],
    };
    const { text, warnings } = graphToUET3D(graph, layout({ i: [0, 0], o: [200, 0] }), META, NO_PINS);
    expect(warnings).toEqual([]);
    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionFunctionInput');
    expect(text).toContain('InputName="A"');
    expect(text).toContain('OutputName="Result"');
    expect(text).toContain('A=(Expression=MaterialExpressionFunctionInput_0,OutputIndex=0)');
  });

  it('exports the raymarch cloud graph with MaterialGraphNode framing and no default-constant connection targets', () => {
    const graph = JSON.parse(readFileSync(
      resolve(__dirname, '../../agent-pack/examples/raymarch_cloud_six_way/raymarch_cloud_six_way_fix.matgraph.json'),
      'utf-8',
    )) as MatGraph;
    const exportMeta = JSON.parse(readFileSync(
      resolve(__dirname, '../../agent-pack/nodes-ue5.7.export.json'),
      'utf-8',
    )) as ExportMeta;
    const positions = Object.fromEntries(graph.nodes.map((node, i) => [node.id, { x: i * 240, y: 0 }]));

    const { text, warnings } = graphToUET3D(graph, positions, exportMeta, {});

    expect(text).toContain('Begin Object Class=/Script/UnrealEd.MaterialGraphNode');
    expect(text).toContain('MaterialExpression=');
    expect(text).toContain('CustomProperties Pin');
    expect(text).not.toMatch(/\bConst[AB]=\(Expression=/);
    expect(warnings).toEqual(['MaterialOutput "OUT" skipped - connect final pins manually in UE.']);
  });

  it('reproduces the real UE clipboard format tokens for the core calibration graph', () => {
    // Ground-truth regression guard. Drive the emitter with the REAL calibrated
    // metadata and a graph mirroring the node set captured in
    // fixtures/ue-clipboard-core.t3d (a genuine UE 5.7 clipboard sample). Every
    // asserted token is first verified to exist in that real fixture, then required
    // in the emitter output - so a regression that reverts the calibration fails
    // here, unlike the hand-authored golden tests above which only echo the
    // emitter's own output and would silently follow such a regression.
    const exportMeta = JSON.parse(readFileSync(
      resolve(__dirname, '../../agent-pack/nodes-ue5.7.export.json'),
      'utf-8',
    )) as ExportMeta;
    const fixture = readFileSync(resolve(__dirname, 'fixtures/ue-clipboard-core.t3d'), 'utf-8');

    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'core',
      nodes: [
        { id: 'c', type: 'Constant', params: { R: 1 } },
        { id: 'add', type: 'Add' },
        { id: 'vp', type: 'VectorParameter', params: { ParameterName: 'Color', DefaultValue: [1, 1, 1, 1] } },
        { id: 'tex', type: 'TextureSampleParameter2D', params: { ParameterName: 'MaskTexture', Texture: '/Game/Textures/T_Mask.T_Mask', SamplerType: 'Masks' } },
        { id: 'xf', type: 'Transform', params: { Source: 'World', Destination: 'Tangent' } },
        { id: 'mask', type: 'ComponentMask', params: { R: true, G: false, B: false, A: false } },
      ],
      connections: [
        { from: 'c:Value', to: 'add:A' },
        { from: 'vp:RGB', to: 'add:B' },
        { from: 'tex:RGB', to: 'mask:Input' },
      ],
      comments: [{ id: 'cm', text: 'Core clipboard calibration', color: '#808080', contains: ['c', 'add', 'vp', 'tex', 'xf', 'mask'] }],
    };
    const positions = layout({
      c: [0, 0], add: [260, 0], vp: [0, 180], tex: [560, 0], xf: [560, 220], mask: [820, 0],
    });

    const { text, warnings } = graphToUET3D(graph, positions, exportMeta, NO_PINS);
    expect(warnings).toEqual([]);

    // Each token is real UE 5.7 clipboard syntax present in the captured fixture and
    // must be reproduced by the emitter. The two assertions together prove the
    // emitter output matches genuine UE ground truth, not a self-snapshot.
    const realUEInvariants = [
      'Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name=',
      "ExportPath=\"/Script/UnrealEd.MaterialGraphNode'/Engine/Transient.UEMatWorkflowClipboard:MaterialGraph_0.",
      'CustomProperties Pin (PinId=',
      'Direction="EGPD_Output"',
      'Direction="EGPD_Input"',
      "Texture=Texture2D'\"/Game/Textures/T_Mask.T_Mask\"'",
      'SamplerType=SAMPLERTYPE_Masks',
      'TransformSourceType=TRANSFORMSOURCE_World',
      'TransformType=TRANSFORM_Tangent',
      'DefaultValue=(R=1.0,G=1.0,B=1.0,A=1.0)',
      'R=True',
      'G=False',
      'Begin Object Class=/Script/UnrealEd.MaterialGraphNode_Comment',
      "MaterialExpression=MaterialExpressionConstant'",
    ];
    for (const token of realUEInvariants) {
      expect(fixture, `fixture must contain ${token}`).toContain(token);
      expect(text, `emitter must reproduce ${token}`).toContain(token);
    }

    // Connected inputs map to real UE FExpressionInput properties, never to the
    // default-constant params (the bug class the raymarch guard also covers).
    expect(text).toContain('A=(Expression=MaterialExpressionConstant_0,OutputIndex=0)');
    expect(text).toContain('B=(Expression=MaterialExpressionVectorParameter_2,OutputIndex=1)');
    expect(text).not.toMatch(/\bConst[AB]=\(Expression=/);
  });

  it('exports a Custom node with dynamic inputs and additional outputs matching the UE fixture', () => {
    const exportMeta = JSON.parse(readFileSync(
      resolve(__dirname, '../../agent-pack/nodes-ue5.7.export.json'), 'utf-8',
    )) as ExportMeta;
    const fixture = readFileSync(resolve(__dirname, 'fixtures/ue-custom-node.t3d'), 'utf-8');

    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'customprobe',
      nodes: [
        { id: 'uv', type: 'TextureCoordinate' },
        { id: 'k', type: 'Constant', params: { R: 1 } },
        { id: 'cust', type: 'Custom', params: {
          Description: 'WF_CustomProbe',
          OutputType: 'CMOT_Float3',
          Code: '// probe\nfloat v = UV.x * Mask;\nreturn float3(v, v, "x" == 0 ? 0.0 : v);',
          Inputs: [{ InputName: 'UV' }, { InputName: 'Mask' }],
          AdditionalOutputs: [{ OutputName: 'Extra', OutputType: 'CMOT_Float1' }],
        } },
        { id: 'm1', type: 'Multiply' },
        { id: 'm2', type: 'Multiply' },
      ],
      connections: [
        { from: 'uv:UVs', to: 'cust:UV' },
        { from: 'k:Value', to: 'cust:Mask' },
        { from: 'cust:Output', to: 'm1:A' },
        { from: 'cust:Extra', to: 'm2:A' },
      ],
    };
    const positions = layout({ uv: [0, 0], k: [0, 200], cust: [240, 0], m1: [480, 0], m2: [480, 200] });

    const { text, warnings } = graphToUET3D(graph, positions, exportMeta, NO_PINS);

    // Custom is no longer skipped:
    expect(warnings.some(w => /cust.*not exportable/i.test(w))).toBe(false);

    // Tokens present in BOTH the real UE fixture and the emitter output (ground truth):
    const tokens = [
      'Begin Object Class=/Script/Engine.MaterialExpressionCustom',
      'OutputType=CMOT_Float3',
      'Description="WF_CustomProbe"',
      'Inputs(0)=(InputName="UV",Input=(Expression=MaterialExpressionTextureCoordinate_0,OutputIndex=0))',
      'Inputs(1)=(InputName="Mask",Input=(Expression=MaterialExpressionConstant_1,OutputIndex=0))',
      'AdditionalOutputs(0)=(OutputName="Extra",OutputType=CMOT_Float1)',
    ];
    for (const tk of tokens) {
      expect(fixture, `fixture must contain ${tk}`).toContain(tk);
      expect(text, `emitter must reproduce ${tk}`).toContain(tk);
    }

    // Exact Code escaping taken from the real fixture (newlines -> \n, quotes -> \"):
    const codeLine = fixture.split('\n').find(l => l.trim().startsWith('Code='))!.trim();
    expect(codeLine).toBe('Code="// probe\\nfloat v = UV.x * Mask;\\nreturn float3(v, v, \\"x\\" == 0 ? 0.0 : v);"');
    expect(text).toContain(codeLine);

    // Dynamic pins declared; the additional output (Extra) indexes at 1:
    expect(text).toContain('PinName="UV"');
    expect(text).toContain('PinName="Mask"');
    expect(text).toContain('PinName="Output"');
    expect(text).toContain('PinName="Extra"');
    expect(text).toMatch(/A=\(Expression=MaterialExpressionCustom_\d+,OutputIndex=1\)/);
  });
});

describe('parseUET3D', () => {
  it('is a stub that throws not-implemented', () => {
    expect(() => parseUET3D('anything')).toThrow(/not implemented/i);
  });
});

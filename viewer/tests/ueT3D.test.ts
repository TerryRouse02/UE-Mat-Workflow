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
      params: {
        Texture: { property: 'Texture', kind: 'texture' },
        SamplerType: { property: 'SamplerType', kind: 'enum', valueMap: { Normal: 'SAMPLERTYPE_Normal' } },
      } },
    BlendAngleCorrectedNormals: { ueClass: '/Script/Engine.MaterialExpressionMaterialFunctionCall',
      functionRefProperty: 'MaterialFunction',
      functionAsset: '/Engine/Functions/Engine_MaterialFunctions02/Utility/BlendAngleCorrectedNormals.BlendAngleCorrectedNormals',
      inputs: { BaseNormal: { property: 'FunctionInputs(0)' }, AdditionalNormal: { property: 'FunctionInputs(1)' } },
      outputs: { Result: { index: 0 } },
      params: {} },
    MakeMaterialAttributes: { ueClass: '/Script/Engine.MaterialExpressionMakeMaterialAttributes',
      inputs: Object.fromEntries(['BaseColor', 'Metallic', 'Specular', 'Roughness', 'EmissiveColor', 'Opacity',
        'OpacityMask', 'Normal', 'WorldPositionOffset', 'Refraction', 'AmbientOcclusion', 'PixelDepthOffset',
        'SubsurfaceColor', 'ClearCoat', 'ClearCoatRoughness'].map(a => [a, { property: a }])),
      outputs: { MaterialAttributes: { index: 0 } }, params: {} },
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

  it('uses meta.materialAttributes (full map) for Set attributes, matching names space-insensitively', () => {
    // The commandlet-generated path: a full attribute map lets Set/Get export attributes beyond
    // the fixture-captured fallback. Names may carry spaces ("Emissive Color") while the matgraph
    // pin uses the no-space form ("EmissiveColor"); they must still resolve, and the spaced UE
    // display name must be what lands in InputName.
    const META_MAP: ExportMeta = {
      schemaVersion: '1.0', ueVersion: '5.7',
      nodes: {
        Constant: { ueClass: '/Script/Engine.MaterialExpressionConstant', inputs: {}, outputs: { Value: { index: 0 } }, params: {} },
        SetMaterialAttributes: { ueClass: '/Script/Engine.MaterialExpressionSetMaterialAttributes', inputs: {}, outputs: {}, params: {}, dynamicExport: true },
      },
      reserved: {},
      materialAttributes: [
        { name: 'Base Color', guid: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        { name: 'Normal', guid: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
        { name: 'Emissive Color', guid: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' },
      ],
    };
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 'c', type: 'Constant', params: { R: 1 } },
        { id: 'set', type: 'SetMaterialAttributes', params: { AttributeNames: ['BaseColor', 'Normal', 'EmissiveColor'] } },
      ],
      connections: [
        { from: 'c:Value', to: 'set:BaseColor' },
        { from: 'c:Value', to: 'set:Normal' },
        { from: 'c:Value', to: 'set:EmissiveColor' },
      ],
    };
    const { text, warnings } = graphToUET3D(graph, layout({ c: [-100, 0], set: [100, 0] }), META_MAP, NO_PINS);

    // All three resolve from the map — none invented, none dropped.
    expect(warnings.filter(w => /has no captured GUID/.test(w))).toEqual([]);
    // GUIDs come from the map, in AttributeNames order.
    const setTypes = [...text.matchAll(/AttributeSetTypes\(\d+\)=([0-9A-F]{32})/g)].map(m => m[1]);
    expect(setTypes).toEqual([
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    ]);
    // InputName uses the map's display name verbatim (spaces preserved) even though the matgraph
    // pin was the no-space "EmissiveColor".
    expect(text).toContain('InputName="Base Color"');
    expect(text).toContain('InputName="Normal"');
    expect(text).toContain('InputName="Emissive Color"');
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

  it('formats texture parameters as UE object references', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        {
          id: 't',
          type: 'TextureSampleParameter2D',
          params: {
            Texture: '/Game/Textures/T_Mask.T_Mask',
            SamplerType: 'Normal',
          },
        },
      ],
      connections: [],
    };
    const { text } = graphToUET3D(graph, layout({ t: [0, 0] }), META, NO_PINS);
    expect(text).toContain(`Texture="/Script/Engine.Texture2D'/Game/Textures/T_Mask.T_Mask'"`);
    expect(text).not.toContain(`Texture2D'"/Game/Textures/T_Mask.T_Mask"'`);
  });

  it('passes an already-formed texture object ref through unchanged', () => {
    const fullRef = `/Script/Engine.TextureCube'/Game/Textures/T_Cube.T_Cube'`;
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        {
          id: 't',
          type: 'TextureSampleParameter2D',
          params: {
            Texture: fullRef,
            SamplerType: 'Normal',
          },
        },
      ],
      connections: [],
    };
    const { text } = graphToUET3D(graph, layout({ t: [0, 0] }), META, NO_PINS);
    // A fully-formed ref (already contains the class'path' form) is emitted verbatim,
    // never re-wrapped in another Texture2D'...' layer.
    expect(text).toContain(`Texture="${fullRef}"`);
    expect(text).not.toContain(`Texture2D'/Script/Engine.TextureCube'`);
  });

  it('emits float constants in plain decimal, never scientific notation', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 'tiny', type: 'Constant', params: { R: 0.0000001 } },
        { id: 'huge', type: 'Constant', params: { R: 1e21 } },
      ],
      connections: [],
    };
    const { text } = graphToUET3D(graph, layout({ tiny: [0, 0], huge: [0, 200] }), META, NO_PINS);
    const constLines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('R='));
    expect(constLines.length).toBe(2);
    for (const line of constLines) {
      // UE's T3D parser rejects exponential notation; every float must be plain decimal.
      expect(line).not.toMatch(/[eE]/);
    }
    // The tiny value still round-trips as a faithful decimal, not "0".
    expect(constLines.some(l => l === 'R=0.0000001')).toBe(true);
  });

  it('matches UE 5.7 captured texture reference syntax for TextureSample nodes', () => {
    const exportMeta = JSON.parse(readFileSync(
      resolve(__dirname, '../../agent-pack/nodes-ue5.7.export.json'), 'utf-8',
    )) as ExportMeta;
    const fixture = readFileSync(resolve(__dirname, 'fixtures/ue-texture-sample-sources.t3d'), 'utf-8');
    const textureLineFor = (text: string, ueClass: string): string => {
      const lines = text.split(/\r?\n/);
      const start = lines.findIndex(line => line.includes(`Begin Object Class=/Script/Engine.${ueClass} `));
      if (start < 0) throw new Error(`missing ${ueClass}`);
      const line = lines.slice(start).find(candidate => candidate.trim().startsWith('Texture='));
      if (!line) throw new Error(`missing ${ueClass} Texture= line`);
      return line.trim();
    };
    const assetPathFrom = (line: string): string => {
      const match = /\/Game\/[^"']+/.exec(line);
      if (!match) throw new Error(`missing /Game texture asset path in: ${line}`);
      return match[0];
    };
    const emittedTextureLine = (type: 'TextureSample' | 'TextureSampleParameter2D', textureLine: string): string => {
      const graph: MatGraph = {
        schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'textureprobe',
        nodes: [{
          id: 't',
          type,
          params: {
            Texture: assetPathFrom(textureLine),
            ...(type === 'TextureSampleParameter2D' ? { ParameterName: 'WF_TextureProbe' } : {}),
          },
        }],
        connections: [],
      };
      return textureLineFor(graphToUET3D(graph, layout({ t: [0, 0] }), exportMeta, NO_PINS).text, `MaterialExpression${type}`);
    };

    const textureSampleLine = textureLineFor(fixture, 'MaterialExpressionTextureSample');
    const textureSampleParameterLine = textureLineFor(fixture, 'MaterialExpressionTextureSampleParameter2D');

    expect(emittedTextureLine('TextureSample', textureSampleLine)).toBe(textureSampleLine);
    expect(emittedTextureLine('TextureSampleParameter2D', textureSampleParameterLine)).toBe(textureSampleParameterLine);
  });

  it('auto-collects MaterialOutput attribute wires into a synthesized MakeMaterialAttributes node', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 'c', type: 'Constant', params: { R: 1 } },
        { id: 'r', type: 'Constant', params: { R: 0.5 } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [
        { from: 'c:Value', to: 'OUT:BaseColor' },
        { from: 'r:Value', to: 'OUT:Roughness' },
      ],
    };
    const { text, warnings } = graphToUET3D(graph, layout({ c: [0, 0], r: [0, 200], OUT: [300, 0] }), META, NO_PINS);
    // The MaterialOutput root itself is never emitted (its pin is wired manually in UE).
    expect(text).not.toContain('MaterialExpressionMaterialOutput');
    // Exactly one MakeMaterialAttributes expression is synthesized to collect every attribute wire.
    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionMakeMaterialAttributes');
    expect((text.match(/MaterialExpressionMakeMaterialAttributes Name=/g) ?? []).length).toBe(1);
    // Both attribute connections feed the collector's matching input properties, using
    // the fully-qualified Expression reference the MaterialAttributes family requires.
    expect(text).toContain(`BaseColor=(Expression="/Script/Engine.MaterialExpressionConstant'MaterialGraphNode_0.MaterialExpressionConstant_0'")`);
    expect(text).toContain(`Roughness=(Expression="/Script/Engine.MaterialExpressionConstant'MaterialGraphNode_1.MaterialExpressionConstant_1'")`);
    // And never the bare-name form that fails to resolve on paste for this node family.
    expect(text).not.toMatch(/BaseColor=\(Expression=MaterialExpressionConstant_0,/);
    // The collector exposes UE's real single output pin name (the one manual wire in UE).
    expect(text).toContain('PinName="Output",Direction="EGPD_Output"');
    // Guidance points at the single-wire workflow.
    expect(warnings.some(w => /MakeMaterialAttributes|Material Attributes/i.test(w))).toBe(true);
  });

  it('serializes nested expression identity like real UE clipboard T3D', () => {
    const fixture = readFileSync(resolve(__dirname, 'fixtures/ue-make-material-attributes.t3d'), 'utf-8');
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 'c', type: 'Constant', params: { R: 1 } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [{ from: 'c:Value', to: 'OUT:Roughness' }],
    };
    const { text } = graphToUET3D(graph, layout({ c: [0, 0], OUT: [300, 0] }), META, NO_PINS);

    const fillExportPath = `Begin Object Name="MaterialExpressionConstant_0" ExportPath="/Script/Engine.MaterialExpressionConstant'`;
    const materialExpressionRef = `MaterialExpression="/Script/Engine.MaterialExpressionConstant'MaterialExpressionConstant_0'"`;
    expect(fixture, 'real UE fixture includes ExportPath on the fill object').toContain(fillExportPath);
    expect(fixture, 'real UE fixture uses a quoted class-path MaterialExpression ref').toContain(materialExpressionRef);
    expect(text).toContain(fillExportPath);
    expect(text).toContain(materialExpressionRef);
    expect(text).not.toContain(`MaterialExpression=MaterialExpressionConstant'MaterialExpressionConstant_0'`);
  });

  it('drops duplicate wires into the same MaterialOutput attribute pin and warns', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 'a', type: 'Constant', params: { R: 1 } },
        { id: 'b', type: 'Constant', params: { R: 2 } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [
        { from: 'a:Value', to: 'OUT:BaseColor' },
        { from: 'b:Value', to: 'OUT:BaseColor' },
      ],
    };
    const { text, warnings } = graphToUET3D(graph, layout({ a: [0, 0], b: [0, 200], OUT: [300, 0] }), META, NO_PINS);
    // First wire wins; the collector's BaseColor input appears exactly once and points
    // at the first source (node 0), never the dropped second source.
    const baseColorInputs = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('BaseColor=(Expression='));
    expect(baseColorInputs).toHaveLength(1);
    expect(baseColorInputs[0]).toContain('MaterialGraphNode_0.MaterialExpressionConstant_0');
    expect(warnings.some(w => /BaseColor.*(duplicate|wired more than once)/i.test(w))).toBe(true);
  });

  it('uses a fully-qualified Expression reference for MakeMaterialAttributes inputs (ground truth)', () => {
    const exportMeta = JSON.parse(readFileSync(
      resolve(__dirname, '../../agent-pack/nodes-ue5.7.export.json'), 'utf-8',
    )) as ExportMeta;
    const fixture = readFileSync(resolve(__dirname, 'fixtures/ue-make-material-attributes.t3d'), 'utf-8');

    // Ground truth: genuine UE 5.7 serializes MakeMaterialAttributes inputs with a
    // fully-qualified object reference, NOT the bare-name form ordinary nodes use.
    const fqBaseColor = `BaseColor=(Expression="/Script/Engine.MaterialExpressionConstant3Vector'MaterialGraphNode_0.MaterialExpressionConstant3Vector_0'"`;
    expect(fixture, 'real UE fixture uses the full-path form').toContain(fqBaseColor);
    expect(fixture).not.toContain('BaseColor=(Expression=MaterialExpressionConstant3Vector_0');

    // Our emitter must reproduce that full-path form for the same graph (auto-collected).
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'mma',
      nodes: [
        { id: 'c3', type: 'Constant3Vector', params: { Constant: [1, 0, 0, 1] } },
        { id: 'k', type: 'Constant', params: { R: 0.5 } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [
        { from: 'c3:RGB', to: 'OUT:BaseColor' },
        { from: 'k:Value', to: 'OUT:Roughness' },
      ],
    };
    const positions = layout({ c3: [-520, -120], k: [-520, 120], OUT: [0, 0] });
    const { text } = graphToUET3D(graph, positions, exportMeta, NO_PINS);

    expect(text, 'emitter reproduces the ground-truth full-path ref').toContain(fqBaseColor);
    expect(text).toMatch(/Roughness=\(Expression="\/Script\/Engine\.MaterialExpressionConstant'MaterialGraphNode_1\.MaterialExpressionConstant_\d+'"\)/);
    // The ordinary-node bare form must NOT appear for the collector's inputs.
    expect(text).not.toMatch(/BaseColor=\(Expression=MaterialExpressionConstant3Vector_\d+,OutputIndex/);
  });

  it('reproduces the per-source-type channel mask/OutputIndex for MakeMaterialAttributes inputs (ground truth)', () => {
    const exportMeta = JSON.parse(readFileSync(
      resolve(__dirname, '../../agent-pack/nodes-ue5.7.export.json'), 'utf-8',
    )) as ExportMeta;
    const fixture = readFileSync(resolve(__dirname, 'fixtures/ue-make-material-attributes-sources.t3d'), 'utf-8');

    // Pull the suffix after the Expression object ref straight from the genuine UE 5.7
    // sample. Node numbers differ between the fixture and our emitter, so we compare the
    // channel suffix (Mask / OutputIndex), which is what the source output type determines.
    const suffix = (text: string, prop: string): string => {
      const line = text.split(/\r?\n/).map(l => l.trim()).find(l => l.startsWith(`${prop}=(Expression=`));
      if (!line) throw new Error(`no ${prop} input line`);
      return line.replace(/^.*?'"/, ''); // drop everything up to the Expression ref's closing '"
    };

    // Bind the expectation to real UE ground truth, then guard the exact strings so a
    // silent capture regression can't quietly weaken the test.
    const real = {
      BaseColor: suffix(fixture, 'BaseColor'),         // Constant3Vector RGB
      Normal: suffix(fixture, 'Normal'),               // TextureSample RGB
      Roughness: suffix(fixture, 'Roughness'),         // TextureSample R (index 1)
      EmissiveColor: suffix(fixture, 'EmissiveColor'), // Multiply Result (single output)
      Metallic: suffix(fixture, 'Metallic'),           // Constant Value (single output)
    };
    expect(real.BaseColor).toBe(',Mask=1,MaskR=1,MaskG=1,MaskB=1)');
    expect(real.Normal).toBe(',Mask=1,MaskR=1,MaskG=1,MaskB=1)');
    expect(real.Roughness).toBe(',OutputIndex=1,Mask=1,MaskR=1)');
    expect(real.EmissiveColor).toBe(')');
    expect(real.Metallic).toBe(')');

    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'mma2',
      nodes: [
        { id: 'c3', type: 'Constant3Vector', params: { Constant: [1, 0, 0, 1] } },
        { id: 'tex', type: 'TextureSample', params: {} },
        { id: 'mul', type: 'Multiply' },
        { id: 'k', type: 'Constant', params: { R: 0.5 } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [
        { from: 'c3:RGB', to: 'OUT:BaseColor' },
        { from: 'tex:RGB', to: 'OUT:Normal' },
        { from: 'tex:R', to: 'OUT:Roughness' },
        { from: 'mul:Result', to: 'OUT:EmissiveColor' },
        { from: 'k:Value', to: 'OUT:Metallic' },
      ],
    };
    const positions = layout({ c3: [0, 0], tex: [0, 200], mul: [0, 400], k: [0, 600], OUT: [400, 0] });
    const { text } = graphToUET3D(graph, positions, exportMeta, NO_PINS);

    for (const prop of ['BaseColor', 'Normal', 'Roughness', 'EmissiveColor', 'Metallic'] as const) {
      expect(suffix(text, prop), `${prop} suffix must match real UE`).toBe(real[prop]);
    }
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

  it('emits a work-project MaterialFunctionCall (UE asset path) from index-derived pins, no auto-link warning', () => {
    // A user's OWN project MF, referenced by UE asset path. The server's mf-resolver
    // fills derivedPins from agent-pack/workmf-index.json; the exporter is unchanged.
    // This locks in that asset-path MFC export already works end to end.
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 'src', type: 'Constant', params: { R: 1 } },
        { id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: '/Game/Functions/MF_Foo.MF_Foo' } },
      ],
      connections: [{ from: 'src:Value', to: 'mfc:UV' }],
    };
    const derived: Record<string, DerivedPins> = {
      mfc: { inputs: [{ name: 'UV', type: 'Float2' }], outputs: [{ name: 'Result', type: 'Float3' }] },
    };
    const { text, warnings } = graphToUET3D(graph, layout({ src: [0, 0], mfc: [200, 0] }), META, derived, { mfContentRoot: '/Game/' });
    expect(text).toContain("MaterialFunction=MaterialFunction'\"/Game/Functions/MF_Foo.MF_Foo\"'");
    expect(text).toContain('FunctionInputs(0)=(Input=(Expression=MaterialExpressionConstant_0,OutputIndex=0))');
    expect(text).toContain('PinName="Result"');
    // Asset path already starts with '/', so the "create MF in UE for auto-link" warning must NOT fire.
    expect(warnings.some(w => /auto-link/i.test(w))).toBe(false);
  });

  it('resolves a MaterialFunctionCall input pin index from FunctionInputs(n) metadata', () => {
    // BlendAngleCorrectedNormals carries explicit FunctionInputs(n) mappings, so the
    // index comes from metadata (the authoritative path) - not from derived-pin order.
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 'src', type: 'Constant', params: { R: 1 } },
        { id: 'blend', type: 'BlendAngleCorrectedNormals' },
      ],
      connections: [{ from: 'src:Value', to: 'blend:AdditionalNormal' }],
    };
    const { text, warnings } = graphToUET3D(graph, layout({ src: [0, 0], blend: [200, 0] }), META, NO_PINS);
    // AdditionalNormal -> FunctionInputs(1) from metadata, even with no derived pins present.
    expect(text).toContain('FunctionInputs(1)=(Input=(Expression=MaterialExpressionConstant_0,OutputIndex=0))');
    expect(warnings).toEqual([]);
  });

  it('warns when a MaterialFunctionCall input pin is not found in the fallback', () => {
    // Reserved MaterialFunctionCall meta has no input mappings, so the index falls back
    // to derived-pin order. If the wired pin isn't in derivedPins, we keep a safe default
    // (index 0) but surface a warning so the silent mis-wire becomes visible.
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 'src', type: 'Constant', params: { R: 1 } },
        { id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: './blend_normals.matgraph.json' } },
      ],
      connections: [{ from: 'src:Value', to: 'mfc:MissingPin' }],
    };
    const derived: Record<string, DerivedPins> = {
      mfc: { inputs: [{ name: 'BaseNormal', type: 'Float3' }], outputs: [{ name: 'Result', type: 'Float3' }] },
    };
    const { text, warnings } = graphToUET3D(graph, layout({ src: [0, 0], mfc: [200, 0] }), META, derived, { mfContentRoot: '/Game/' });
    // Safe default index 0 is still emitted (the wire is not dropped silently).
    expect(text).toContain('FunctionInputs(0)=(Input=(Expression=MaterialExpressionConstant_0,OutputIndex=0))');
    // ...but the unresolved pin is now visible as a warning.
    expect(warnings.some(w => /MissingPin/.test(w))).toBe(true);
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
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/MaterialOutput "OUT".*MakeMaterialAttributes/);
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

    // These are stable clipboard framing tokens shared by the real UE 5.7
    // fixture and the emitter. More specific scalar/default-pin formatting is
    // asserted below against each side because UE omits default input Direction
    // fields and serializes captured float defaults with six decimals.
    const sharedClipboardInvariants = [
      'Begin Object Class=/Script/UnrealEd.MaterialGraphNode Name=',
      "ExportPath=\"/Script/UnrealEd.MaterialGraphNode'/Engine/Transient.UEMatWorkflowClipboard:MaterialGraph_0.",
      'CustomProperties Pin (PinId=',
      'Direction="EGPD_Output"',
      'SamplerType=SAMPLERTYPE_Masks',
      'TransformSourceType=TRANSFORMSOURCE_World',
      'TransformType=TRANSFORM_Tangent',
      'R=True',
      'Begin Object Class=/Script/UnrealEd.MaterialGraphNode_Comment',
    ];
    for (const token of sharedClipboardInvariants) {
      expect(fixture, `fixture must contain ${token}`).toContain(token);
      expect(text, `emitter must reproduce ${token}`).toContain(token);
    }

    expect(fixture).toContain('DefaultValue=(R=1.000000,G=1.000000,B=1.000000,A=1.000000)');
    expect(fixture).toContain('PinName="G",PinType.PinCategory="optional",PinType.PinSubCategory="bool"');
    expect(fixture).toContain('DefaultValue="false"');
    expect(fixture).not.toContain('Direction="EGPD_Input"');
    expect(text).toContain('Direction="EGPD_Input"');
    expect(text).toContain('DefaultValue=(R=1.0,G=1.0,B=1.0,A=1.0)');
    expect(text).toContain('G=False');

    // Connected inputs map to real UE FExpressionInput properties, never to the
    // default-constant params (the bug class the raymarch guard also covers).
    expect(text).toContain('A=(Expression=MaterialExpressionConstant_0,OutputIndex=0)');
    expect(text).toContain('B=(Expression=MaterialExpressionVectorParameter_2,OutputIndex=1)');
    expect(text).toContain(`Texture="/Script/Engine.Texture2D'/Game/Textures/T_Mask.T_Mask'"`);
    expect(text).not.toMatch(/\bConst[AB]=\(Expression=/);
  });

  it('preserves the captured MakeMaterialAttributes source mask fixture', () => {
    const fixture = readFileSync(resolve(__dirname, 'fixtures/ue-make-material-attributes-sources.t3d'), 'utf-8');

    for (const attribute of ['BaseColor', 'Normal', 'Roughness', 'EmissiveColor', 'Metallic']) {
      expect(fixture, `fixture must contain ${attribute}`).toMatch(new RegExp(`^\\s+${attribute}=\\(Expression=`, 'm'));
    }
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

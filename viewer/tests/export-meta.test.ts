import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExportMeta } from '../web/src/export/export-meta-types';

const ROOT = resolve(__dirname, '../../agent-pack');
const exp: ExportMeta = JSON.parse(readFileSync(resolve(ROOT, 'nodes-ue5.7.export.json'), 'utf-8'));
const db = JSON.parse(readFileSync(resolve(ROOT, 'nodes-ue5.7.json'), 'utf-8'));

describe('nodes-ue5.7.export.json', () => {
  it('declares ue 5.7', () => {
    expect(exp.ueVersion).toBe('5.7');
  });

  it('has no orphan node entries (every export key exists in the authoring DB)', () => {
    const orphans = Object.keys(exp.nodes).filter(k => !(k in db.nodes));
    expect(orphans).toEqual([]);
  });

  it('includes the hand-authored subset', () => {
    for (const t of ['Multiply', 'Add', 'Subtract', 'Saturate', 'Lerp', 'Constant',
                     'ScalarParameter', 'StaticSwitchParameter', 'QualitySwitch',
                     'FeatureLevelSwitch', 'TextureSampleParameter2D']) {
      expect(exp.nodes[t], `missing export meta for ${t}`).toBeTruthy();
      expect(exp.nodes[t].ueClass).toMatch(/^\/Script\/Engine\.MaterialExpression/);
    }
  });

  it('covers the reserved types that are exportable', () => {
    for (const t of ['MaterialFunctionCall', 'FunctionInput', 'FunctionOutput']) {
      expect(exp.reserved[t], `missing reserved export meta for ${t}`).toBeTruthy();
    }
    expect(exp.reserved['MaterialOutput']).toBeUndefined(); // never exported
  });

  it('every node/reserved entry has well-formed outputs and params maps', () => {
    for (const m of [...Object.values(exp.nodes), ...Object.values(exp.reserved)]) {
      expect(typeof m.ueClass).toBe('string');
      expect(typeof m.inputs).toBe('object');
      expect(typeof m.outputs).toBe('object');
      expect(typeof m.params).toBe('object');
    }
  });

  it('does not map connectable arithmetic inputs to default constant params', () => {
    for (const type of ['Add', 'Multiply', 'Max']) {
      const entry = exp.nodes[type];
      expect(entry.inputs.A?.property, `${type}.A`).toBe('A');
      expect(entry.inputs.B?.property, `${type}.B`).toBe('B');
      expect(entry.params.ConstA?.property, `${type}.ConstA`).toBe('ConstA');
      expect(entry.params.ConstB?.property, `${type}.ConstB`).toBe('ConstB');
    }
  });

  it('maps Transform enum params to UE property names and enum literals', () => {
    const entry = exp.nodes.Transform;
    expect(entry.params.Source?.property).toBe('TransformSourceType');
    expect(entry.params.Destination?.property).toBe('TransformType');
    expect(entry.params.Source?.valueMap?.World).toBe('TRANSFORMSOURCE_World');
    expect(entry.params.Destination?.valueMap?.Tangent).toBe('TRANSFORM_Tangent');
  });

  it('keeps a clipboard framing fixture for the core calibration node set', () => {
    const fixturePath = resolve(__dirname, 'fixtures/ue-clipboard-core.t3d');
    expect(existsSync(fixturePath)).toBe(true);
    const fixture = readFileSync(fixturePath, 'utf-8');
    for (const token of [
      '/Script/UnrealEd.MaterialGraphNode',
      '/Script/UnrealEd.MaterialGraphNode_Comment',
      '/Script/Engine.MaterialExpressionConstant',
      '/Script/Engine.MaterialExpressionAdd',
      '/Script/Engine.MaterialExpressionVectorParameter',
      '/Script/Engine.MaterialExpressionTextureSampleParameter2D',
      '/Script/Engine.MaterialExpressionTransform',
      '/Script/Engine.MaterialExpressionComponentMask',
      'CustomProperties Pin',
      'PinType.PinCategory=',
      'PersistentGuid=00000000000000000000000000000000',
      'PinFriendlyName=',
      'MaterialExpression="/Script/Engine.MaterialExpression',
    ]) {
      expect(fixture, token).toContain(token);
    }
    expect(fixture).not.toContain('11111111111111111111111111111111');
  });

  it('exports Custom as a non-dynamic node with only structural scalar params', () => {
    const c = exp.nodes.Custom;
    expect(c, 'Custom export meta missing').toBeTruthy();
    expect(c.dynamicExport ?? false).toBe(false);
    expect(c.ueClass).toBe('/Script/Engine.MaterialExpressionCustom');
    // Code/OutputType/Description flow through the generic param loop:
    expect(Object.keys(c.params).sort()).toEqual(['Code', 'Description', 'OutputType']);
    // Inputs/AdditionalOutputs are handled structurally, NOT as generic string params:
    expect(c.params.Inputs).toBeUndefined();
    expect(c.params.AdditionalOutputs).toBeUndefined();
  });

  it('includes UE Named Reroute declaration and usage nodes with a real clipboard fixture', () => {
    for (const t of ['NamedRerouteDeclaration', 'NamedRerouteUsage']) {
      expect(db.nodes[t], `missing authoring DB entry for ${t}`).toBeTruthy();
      expect(exp.nodes[t], `missing export meta for ${t}`).toBeTruthy();
      expect(exp.nodes[t].ueClass).toBe(`/Script/Engine.MaterialExpression${t}`);
      expect(exp.nodes[t].verified).toBe(true);
    }

    expect(exp.nodes.NamedRerouteDeclaration.inputs.Input.property).toBe('Input');
    expect(exp.nodes.NamedRerouteDeclaration.params.Name.kind).toBe('name');
    expect(exp.nodes.NamedRerouteDeclaration.params.NodeColor.kind).toBe('vector4');
    expect(exp.nodes.NamedRerouteUsage.outputs.Value.index).toBe(0);

    const fixturePath = resolve(__dirname, 'fixtures/ue-named-reroute.t3d');
    expect(existsSync(fixturePath)).toBe(true);
    const fixture = readFileSync(fixturePath, 'utf-8');
    for (const token of [
      '/Script/Engine.MaterialExpressionNamedRerouteDeclaration',
      '/Script/Engine.MaterialExpressionNamedRerouteUsage',
      'Name="WF_Name"',
      'Input=(Expression=',
      'Declaration=',
      'DeclarationGuid=',
    ]) {
      expect(fixture, token).toContain(token);
    }
  });
});

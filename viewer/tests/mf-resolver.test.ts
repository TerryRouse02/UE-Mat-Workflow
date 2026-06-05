import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveMaterialFunctions } from '../server/mf-resolver';
import { loadGraph } from '../server/graph-loader';
import type { MatGraph } from '../server/types';
import type { WorkMfIndex } from '../server/workmf-index';

function makeRepo() {
  const root = mkdtempSync(resolve(tmpdir(), 'mfres-'));
  mkdirSync(resolve(root, 'functions'), { recursive: true });
  return root;
}

function write(p: string, obj: unknown) { writeFileSync(p, JSON.stringify(obj, null, 2)); }

describe('resolveMaterialFunctions', () => {
  it('derives MFC pins from the referenced function', async () => {
    const root = makeRepo();
    write(resolve(root, 'functions/foo.matgraph.json'), {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'MaterialFunction', name: 'foo',
      nodes: [
        { id: 'i', type: 'FunctionInput',  params: { InputName: 'A' } },
        { id: 'o', type: 'FunctionOutput', params: { OutputName: 'R' } },
      ],
      connections: [{ from: 'i:Input', to: 'o:Input' }],
    });
    write(resolve(root, 'main.matgraph.json'), {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'main',
      nodes: [
        { id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: './functions/foo.matgraph.json' } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [{ from: 'mfc:R', to: 'OUT:BaseColor' }],
    });
    const r = await loadGraph(resolve(root, 'main.matgraph.json'));
    const resolved = await resolveMaterialFunctions(r.graph!, root);
    expect(resolved.derivedPins['mfc']).toEqual({
      inputs: [{ name: 'A', type: 'Float3' }],
      outputs: [{ name: 'R', type: 'Float3' }],
    });
    expect(resolved.warnings).toEqual([]);
  });

  it('maps a non-Float3 output type from the FunctionOutput OutputType param', async () => {
    const root = makeRepo();
    write(resolve(root, 'functions/foo.matgraph.json'), {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'MaterialFunction', name: 'foo',
      nodes: [
        { id: 'i', type: 'FunctionInput',  params: { InputName: 'A', InputType: 'Scalar' } },
        { id: 'o', type: 'FunctionOutput', params: { OutputName: 'R', OutputType: 'Scalar' } },
      ],
      connections: [{ from: 'i:Input', to: 'o:Input' }],
    });
    write(resolve(root, 'main.matgraph.json'), {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'main',
      nodes: [
        { id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: './functions/foo.matgraph.json' } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [{ from: 'mfc:R', to: 'OUT:BaseColor' }],
    });
    const r = await loadGraph(resolve(root, 'main.matgraph.json'));
    const resolved = await resolveMaterialFunctions(r.graph!, root);
    expect(resolved.derivedPins['mfc']).toEqual({
      inputs: [{ name: 'A', type: 'Float1' }],
      outputs: [{ name: 'R', type: 'Float1' }],
    });
  });

  it('warns when MF file is missing', async () => {
    const root = makeRepo();
    write(resolve(root, 'main.matgraph.json'), {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'main',
      nodes: [{ id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: './ghost.matgraph.json' } }],
      connections: [],
    });
    const r = await loadGraph(resolve(root, 'main.matgraph.json'));
    const resolved = await resolveMaterialFunctions(r.graph!, root);
    expect(resolved.warnings[0]).toMatch(/not found/i);
    expect(resolved.derivedPins['mfc']).toEqual({ inputs: [], outputs: [] });
  });

  it('detects circular references', async () => {
    const root = makeRepo();
    write(resolve(root, 'functions/a.matgraph.json'), {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'MaterialFunction', name: 'a',
      nodes: [
        { id: 'in', type: 'FunctionInput', params: { InputName: 'X' } },
        { id: 'call', type: 'MaterialFunctionCall', params: { MaterialFunction: './b.matgraph.json' } },
        { id: 'out', type: 'FunctionOutput', params: { OutputName: 'Y' } },
      ],
      connections: [],
    });
    write(resolve(root, 'functions/b.matgraph.json'), {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'MaterialFunction', name: 'b',
      nodes: [
        { id: 'in', type: 'FunctionInput', params: { InputName: 'X' } },
        { id: 'call', type: 'MaterialFunctionCall', params: { MaterialFunction: './a.matgraph.json' } },
        { id: 'out', type: 'FunctionOutput', params: { OutputName: 'Y' } },
      ],
      connections: [],
    });
    write(resolve(root, 'main.matgraph.json'), {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'main',
      nodes: [{ id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: './functions/a.matgraph.json' } }],
      connections: [],
    });
    const r = await loadGraph(resolve(root, 'main.matgraph.json'));
    const resolved = await resolveMaterialFunctions(r.graph!, root);
    expect(resolved.warnings.some(w => /circular/i.test(w))).toBe(true);
  });
});

describe('resolveMaterialFunctions — work-project MF asset paths', () => {
  const index: WorkMfIndex = {
    schemaVersion: '1.0', kind: 'workmf-index', ueVersion: '5.7',
    functions: {
      '/Game/Functions/MF_Foo.MF_Foo': {
        assetPath: '/Game/Functions/MF_Foo.MF_Foo', displayName: 'MF_Foo',
        inputs: [{ name: 'UV', type: 'Float2', index: 0 }, { name: 'Mask', type: 'Float1', index: 1 }],
        outputs: [{ name: 'Result', type: 'Float3', index: 0 }],
      },
    },
  };

  const mat = (mfPath: string): MatGraph => ({
    schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'main',
    nodes: [{ id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: mfPath } }],
    connections: [],
  });

  it('derives MFC pins from the work-MF index for a /Game asset path (declared order)', async () => {
    const resolved = await resolveMaterialFunctions(mat('/Game/Functions/MF_Foo.MF_Foo'), '/irrelevant', new Set(), { workMfIndex: index });
    expect(resolved.derivedPins['mfc']).toEqual({
      inputs: [{ name: 'UV', type: 'Float2' }, { name: 'Mask', type: 'Float1' }],
      outputs: [{ name: 'Result', type: 'Float3' }],
    });
    expect(resolved.warnings).toEqual([]);
  });

  it('warns (and empties pins) when a /Game asset path is not in the index', async () => {
    const resolved = await resolveMaterialFunctions(mat('/Game/Functions/MF_Missing.MF_Missing'), '/irrelevant', new Set(), { workMfIndex: index });
    expect(resolved.derivedPins['mfc']).toEqual({ inputs: [], outputs: [] });
    expect(resolved.warnings.some(w => /not in index/i.test(w))).toBe(true);
  });

  it('derives MFC pins from the engine-MF index for an /Engine asset path', async () => {
    const engineMfIndex: WorkMfIndex = {
      schemaVersion: '1.0', kind: 'workmf-index', ueVersion: '5.7',
      functions: {
        '/Engine/Functions/Engine_MaterialFunctions02/Utility/Foo.Foo': {
          assetPath: '/Engine/Functions/Engine_MaterialFunctions02/Utility/Foo.Foo', displayName: 'Foo',
          inputs: [{ name: 'In', type: 'Float3', index: 0 }],
          outputs: [{ name: 'Result', type: 'Float3', index: 0 }],
        },
      },
    };
    const resolved = await resolveMaterialFunctions(
      mat('/Engine/Functions/Engine_MaterialFunctions02/Utility/Foo.Foo'), '/irrelevant', new Set(),
      { workMfIndex: index, engineMfIndex },
    );
    expect(resolved.derivedPins['mfc']).toEqual({
      inputs: [{ name: 'In', type: 'Float3' }],
      outputs: [{ name: 'Result', type: 'Float3' }],
    });
    expect(resolved.warnings).toEqual([]);
  });

  it('warns to regenerate the engine index when an /Engine MF is not indexed', async () => {
    const resolved = await resolveMaterialFunctions(
      mat('/Engine/Functions/Engine_MaterialFunctions02/Utility/Foo.Foo'), '/irrelevant', new Set(),
      { workMfIndex: index, engineMfIndex: null },
    );
    expect(resolved.derivedPins['mfc']).toEqual({ inputs: [], outputs: [] });
    expect(resolved.warnings.some(w => /engine index/i.test(w))).toBe(true);
  });

  it('still warns for an asset path when no index is provided', async () => {
    const resolved = await resolveMaterialFunctions(mat('/Game/Functions/MF_Foo.MF_Foo'), '/irrelevant');
    expect(resolved.derivedPins['mfc']).toEqual({ inputs: [], outputs: [] });
    expect(resolved.warnings.some(w => /not in index/i.test(w))).toBe(true);
  });

  it('keeps pins for a work-MF MaterialFunctionCall nested inside a referenced MF', async () => {
    const root = makeRepo();
    write(resolve(root, 'functions/inner.matgraph.json'), {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'MaterialFunction', name: 'inner',
      nodes: [
        { id: 'in', type: 'FunctionInput', params: { InputName: 'A' } },
        { id: 'nested', type: 'MaterialFunctionCall', params: { MaterialFunction: '/Game/Functions/MF_Foo.MF_Foo' } },
        { id: 'out', type: 'FunctionOutput', params: { OutputName: 'R' } },
      ],
      connections: [],
    });
    write(resolve(root, 'main.matgraph.json'), {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'main',
      nodes: [
        { id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: './functions/inner.matgraph.json' } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [],
    });
    const r = await loadGraph(resolve(root, 'main.matgraph.json'));
    const resolved = await resolveMaterialFunctions(r.graph!, root, new Set(), { workMfIndex: index });
    // the nested MFC (declared inside inner.matgraph.json) must still get its work-MF pins
    expect(resolved.derivedPins['nested']).toEqual({
      inputs: [{ name: 'UV', type: 'Float2' }, { name: 'Mask', type: 'Float1' }],
      outputs: [{ name: 'Result', type: 'Float3' }],
    });
  });
});

describe('resolveMaterialFunctions — node provenance', () => {
  const engineMfIndex: WorkMfIndex = {
    schemaVersion: '1.0', kind: 'workmf-index', ueVersion: '5.7',
    functions: {
      '/Engine/Functions/EngFunc.EngFunc': {
        assetPath: '/Engine/Functions/EngFunc.EngFunc', displayName: 'EngFunc',
        inputs: [{ name: 'In', type: 'Float3', index: 0 }],
        outputs: [{ name: 'Out', type: 'Float3', index: 0 }],
      },
    },
  };

  const workMfIndex: WorkMfIndex = {
    schemaVersion: '1.0', kind: 'workmf-index', ueVersion: '5.7',
    functions: {
      '/Game/Functions/MF_Work.MF_Work': {
        assetPath: '/Game/Functions/MF_Work.MF_Work', displayName: 'MF_Work',
        inputs: [{ name: 'In', type: 'Float3', index: 0 }],
        outputs: [{ name: 'Result', type: 'Float3', index: 0 }],
      },
    },
  };

  const mat = (mfPath: string): MatGraph => ({
    schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'main',
    nodes: [{ id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: mfPath } }],
    connections: [],
  });

  it('tags an enginemf-resolved MFC as source="enginemf" with freshnessTs from freshnessMap', async () => {
    const freshnessMap = { enginemf: '2026-06-05T00:00:00.000Z' };
    const resolved = await resolveMaterialFunctions(
      mat('/Engine/Functions/EngFunc.EngFunc'), '/irrelevant', new Set(),
      { engineMfIndex, freshnessMap },
    );
    expect(resolved.nodeProvenance['mfc']).toEqual({ source: 'enginemf', freshnessTs: '2026-06-05T00:00:00.000Z' });
  });

  it('tags a workmf-resolved MFC as source="workmf" with freshnessTs from freshnessMap', async () => {
    const freshnessMap = { workmf: '2026-06-05T01:00:00.000Z' };
    const resolved = await resolveMaterialFunctions(
      mat('/Game/Functions/MF_Work.MF_Work'), '/irrelevant', new Set(),
      { workMfIndex, freshnessMap },
    );
    expect(resolved.nodeProvenance['mfc']).toEqual({ source: 'workmf', freshnessTs: '2026-06-05T01:00:00.000Z' });
  });

  it('tags an unresolved MFC as source="unresolved" with freshnessTs=null', async () => {
    const resolved = await resolveMaterialFunctions(
      mat('/Game/Functions/MF_Missing.MF_Missing'), '/irrelevant', new Set(),
      { workMfIndex, freshnessMap: {} },
    );
    expect(resolved.nodeProvenance['mfc']).toEqual({ source: 'unresolved', freshnessTs: null });
  });

  it('freshnessTs is null when key is not in freshnessMap', async () => {
    const resolved = await resolveMaterialFunctions(
      mat('/Engine/Functions/EngFunc.EngFunc'), '/irrelevant', new Set(),
      { engineMfIndex, freshnessMap: {} },
    );
    expect(resolved.nodeProvenance['mfc'].freshnessTs).toBeNull();
  });
});

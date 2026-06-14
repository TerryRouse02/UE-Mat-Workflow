import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateGraph, materialStructureWarnings } from '../server/schema';

function loadJson(rel: string) {
  return JSON.parse(readFileSync(resolve(__dirname, '..', '..', rel), 'utf-8'));
}

describe('materialStructureWarnings', () => {
  const mat = (nodes: { id: string; type: string }[], type = 'Material') =>
    ({ schemaVersion: '1.0', ueVersion: '5.7', type, name: 'm', nodes, connections: [] }) as never;

  it('passes a Material with exactly one MaterialOutput', () => {
    expect(materialStructureWarnings(mat([{ id: 'a', type: 'Multiply' }, { id: 'OUT', type: 'MaterialOutput' }]))).toEqual([]);
  });
  it('warns when a Material has no MaterialOutput', () => {
    const w = materialStructureWarnings(mat([{ id: 'a', type: 'Multiply' }]));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/found none/);
  });
  it('warns (and names the ids) when a Material has more than one MaterialOutput', () => {
    const w = materialStructureWarnings(mat([{ id: 'OUT', type: 'MaterialOutput' }, { id: 'OUT2', type: 'MaterialOutput' }]));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/found 2 \(OUT, OUT2\)/);
  });
  it('does not check MaterialFunction graphs (they use FunctionOutput)', () => {
    expect(materialStructureWarnings(mat([{ id: 'i', type: 'FunctionInput' }, { id: 'o', type: 'FunctionOutput' }], 'MaterialFunction'))).toEqual([]);
  });
});

describe('validateGraph', () => {
  it('accepts the basic PBR example', () => {
    const g = loadJson('agent-pack/examples/01_basic_pbr/01_basic_pbr.matgraph.json');
    expect(validateGraph(g).errors).toEqual([]);
  });

  it('accepts the with-function example', () => {
    const g = loadJson('agent-pack/examples/02_with_function/02_with_function.matgraph.json');
    expect(validateGraph(g).errors).toEqual([]);
  });

  it('accepts the flashing emissive material', () => {
    const g = loadJson('agent-pack/examples/03_flashing_emissive/03_flashing_emissive.matgraph.json');
    expect(validateGraph(g).errors).toEqual([]);
  });

  it('accepts the snow material', () => {
    const g = loadJson('agent-pack/examples/04_snow/04_snow.matgraph.json');
    expect(validateGraph(g).errors).toEqual([]);
  });


  it('rejects missing schemaVersion', () => {
    const r = validateGraph({ ueVersion: '5.7', type: 'Material', name: 'x', nodes: [], connections: [] });
    expect(r.errors.some(e => /schemaVersion/.test(e))).toBe(true);
  });

  it('rejects connection format without colon', () => {
    const r = validateGraph({
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'x',
      nodes: [{ id: 'a', type: 'X' }],
      connections: [{ from: 'a-Result', to: 'b:Input' }],
    });
    expect(r.errors.some(e => /from/.test(e))).toBe(true);
  });

  it('rejects duplicate node ids', () => {
    const r = validateGraph({
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'x',
      nodes: [{ id: 'a', type: 'X' }, { id: 'a', type: 'Y' }],
      connections: [],
    });
    expect(r.errors.some(e => /duplicate node id/i.test(e))).toBe(true);
  });

  it('rejects connection referencing unknown node', () => {
    const r = validateGraph({
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'x',
      nodes: [{ id: 'a', type: 'X' }],
      connections: [{ from: 'a:R', to: 'ghost:Input' }],
    });
    expect(r.errors.some(e => /ghost/.test(e))).toBe(true);
  });

  it('rejects null elements in nodes array', () => {
    const r = validateGraph({
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'x',
      nodes: [null, { id: 'a', type: 'X' }],
      connections: [],
    });
    expect(r.errors.some(e => /nodes\[0\] must be an object/.test(e))).toBe(true);
  });

  it('splits endpoints on the first colon only (pin names may contain colons)', () => {
    const r = validateGraph({
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'x',
      nodes: [{ id: 'a', type: 'X' }, { id: 'b', type: 'Y' }],
      connections: [{ from: 'a:Group:Sub', to: 'b:In' }],
    });
    // nodeId is the part before the FIRST colon ("a"), so no unknown-node error.
    expect(r.errors).toEqual([]);
  });

  it('rejects a node id that contains a colon', () => {
    const r = validateGraph({
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'x',
      nodes: [{ id: 'a:b', type: 'X' }],
      connections: [],
    });
    expect(r.errors.some(e => /nodes\[0\]\.id must not contain ':'/.test(e))).toBe(true);
  });
});

describe('semantic lint warnings (direct MaterialOutput connections)', () => {
  const lintMat = (
    nodes: Array<{ id: string; type: string; params?: Record<string, unknown> }>,
    connections: Array<{ from: string; to: string }>,
  ) => ({ schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm', nodes, connections }) as never;

  const OUT = { id: 'OUT', type: 'MaterialOutput' };

  it('warns when a texture without SamplerType "Normal" feeds the Normal output', () => {
    const w = materialStructureWarnings(lintMat(
      [OUT, { id: 'nrm', type: 'TextureSample', params: { SamplerType: 'Color' } }],
      [{ from: 'nrm:RGB', to: 'OUT:Normal' }],
    ));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/"nrm".*Normal output.*SamplerType is "Color"/);

    // Unset SamplerType says so explicitly.
    const w2 = materialStructureWarnings(lintMat(
      [OUT, { id: 'nrm', type: 'TextureSampleParameter2D' }],
      [{ from: 'nrm:RGB', to: 'OUT:Normal' }],
    ));
    expect(w2[0]).toMatch(/unset \(defaults to Color\)/);
  });

  it('accepts SamplerType "Normal" into the Normal output, and warns on the reverse misuse', () => {
    const good = materialStructureWarnings(lintMat(
      [OUT, { id: 'nrm', type: 'TextureSample', params: { SamplerType: 'Normal' } }],
      [{ from: 'nrm:RGB', to: 'OUT:Normal' }],
    ));
    expect(good).toEqual([]);

    const bad = materialStructureWarnings(lintMat(
      [OUT, { id: 'tex', type: 'TextureSample', params: { SamplerType: 'Normal' } }],
      [{ from: 'tex:RGB', to: 'OUT:BaseColor' }],
    ));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatch(/"tex".*SamplerType "Normal".*BaseColor/);
  });

  it('warns when a vector constant feeds a scalar output pin, naming a channel fix', () => {
    const w = materialStructureWarnings(lintMat(
      [OUT, { id: 'col', type: 'Constant3Vector' }],
      [{ from: 'col:RGB', to: 'OUT:Roughness' }],
    ));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/"col" \(Constant3Vector\).*scalar Roughness.*"col:R"/);
  });

  it('stays silent for indirect connections and for vector pins', () => {
    expect(materialStructureWarnings(lintMat(
      [
        OUT,
        { id: 'col', type: 'Constant3Vector' },
        { id: 'mul', type: 'Multiply' },
        { id: 'tex', type: 'TextureSample' }, // no SamplerType, but only feeds mul
      ],
      [
        { from: 'tex:RGB', to: 'mul:A' },
        { from: 'col:RGB', to: 'mul:B' },
        { from: 'mul:Result', to: 'OUT:BaseColor' }, // vector into a color pin — fine
      ],
    ))).toEqual([]);
  });
});

// BUG-6 regression — an endpoint with an empty pin ("A:") or empty node id
// (":Pin") must be rejected; it would surface in UE as a dangling pin.
describe('empty endpoint halves (BUG-6)', () => {
  const base = {
    schemaVersion: '1.0',
    ueVersion: '5.7',
    type: 'Material',
    name: 'm',
    nodes: [{ id: 'A', type: 'Constant' }, { id: 'B', type: 'Multiply' }],
  };

  it('rejects a trailing-colon endpoint (empty pin)', () => {
    const r = validateGraph({ ...base, connections: [{ from: 'A:', to: 'B:A' }] });
    expect(r.graph).toBeNull();
    expect(r.errors.join('\n')).toContain('connections[0].from');
  });

  it('rejects a whitespace-only pin', () => {
    const r = validateGraph({ ...base, connections: [{ from: 'A:Value', to: 'B:  ' }] });
    expect(r.graph).toBeNull();
    expect(r.errors.join('\n')).toContain('connections[0].to');
  });

  it('rejects an empty node id (":Pin")', () => {
    const r = validateGraph({ ...base, connections: [{ from: ':Value', to: 'B:A' }] });
    expect(r.graph).toBeNull();
  });
});

describe('semantic lint — duplicate parameter names', () => {
  const matP = (nodes: Array<{ id: string; type: string; params?: Record<string, unknown> }>) =>
    ({ schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm', nodes, connections: [] }) as never;
  const OUT = { id: 'OUT', type: 'MaterialOutput' };

  it('warns when two nodes share a ParameterName, naming both ids', () => {
    const w = materialStructureWarnings(matP([
      OUT,
      { id: 'p1', type: 'ScalarParameter', params: { ParameterName: 'Roughness' } },
      { id: 'p2', type: 'ScalarParameter', params: { ParameterName: 'Roughness' } },
    ]));
    expect(w.some(x => /Roughness/.test(x) && /p1, p2/.test(x) && /same value/i.test(x))).toBe(true);
  });

  it('is silent when parameter names are distinct', () => {
    const w = materialStructureWarnings(matP([
      OUT,
      { id: 'p1', type: 'ScalarParameter', params: { ParameterName: 'Roughness' } },
      { id: 'p2', type: 'ScalarParameter', params: { ParameterName: 'Metallic' } },
    ]));
    expect(w).toEqual([]);
  });

  it('is silent when only one node carries a given name', () => {
    const w = materialStructureWarnings(matP([
      OUT, { id: 'p1', type: 'ScalarParameter', params: { ParameterName: 'Roughness' } },
    ]));
    expect(w).toEqual([]);
  });
});

describe('semantic lint — no-op static switch', () => {
  const matC = (
    nodes: Array<{ id: string; type: string; params?: Record<string, unknown> }>,
    connections: Array<{ from: string; to: string }>,
  ) => ({ schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm', nodes, connections }) as never;
  const OUT = { id: 'OUT', type: 'MaterialOutput' };

  it('warns when a StaticSwitchParameter has identical A and B sources', () => {
    const w = materialStructureWarnings(matC(
      [OUT, { id: 'sw', type: 'StaticSwitchParameter', params: { ParameterName: 'UseB' } }, { id: 'uv', type: 'TextureCoordinate' }],
      [{ from: 'uv:Result', to: 'sw:A' }, { from: 'uv:Result', to: 'sw:B' }],
    ));
    expect(w.some(x => /"sw"/.test(x) && /(identical A and B|no effect)/i.test(x))).toBe(true);
  });

  it('is silent when A and B come from different sources', () => {
    const w = materialStructureWarnings(matC(
      [OUT, { id: 'sw', type: 'StaticSwitchParameter' }, { id: 'a', type: 'TextureCoordinate' }, { id: 'b', type: 'Constant' }],
      [{ from: 'a:Result', to: 'sw:A' }, { from: 'b:Value', to: 'sw:B' }],
    ));
    expect(w).toEqual([]);
  });

  it('is silent when only one of A/B is wired', () => {
    const w = materialStructureWarnings(matC(
      [OUT, { id: 'sw', type: 'StaticSwitch' }, { id: 'a', type: 'TextureCoordinate' }],
      [{ from: 'a:Result', to: 'sw:A' }],
    ));
    expect(w).toEqual([]);
  });
});

describe('semantic lint — dangling operator (safe empty-input slice)', () => {
  const matC = (
    nodes: Array<{ id: string; type: string; params?: Record<string, unknown> }>,
    connections: Array<{ from: string; to: string }>,
  ) => ({ schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm', nodes, connections }) as never;
  const OUT = { id: 'OUT', type: 'MaterialOutput' };

  it('warns when an operator feeds downstream but has no inputs wired and no params', () => {
    const w = materialStructureWarnings(matC(
      [OUT, { id: 'mul', type: 'Multiply' }],
      [{ from: 'mul:Result', to: 'OUT:BaseColor' }],
    ));
    expect(w.some(x => /"mul"/.test(x) && /Multiply/.test(x) && /no inputs/i.test(x))).toBe(true);
  });

  it('is silent when at least one input is wired (the common scale pattern)', () => {
    const w = materialStructureWarnings(matC(
      [OUT, { id: 'mul', type: 'Multiply' }, { id: 't', type: 'TextureCoordinate' }],
      [{ from: 't:Result', to: 'mul:A' }, { from: 'mul:Result', to: 'OUT:BaseColor' }],
    ));
    expect(w).toEqual([]);
  });

  it('is silent when the operator carries params (intentional constant)', () => {
    const w = materialStructureWarnings(matC(
      [OUT, { id: 'mul', type: 'Multiply', params: { ConstA: 2, ConstB: 3 } }],
      [{ from: 'mul:Result', to: 'OUT:Roughness' }],
    ));
    expect(w).toEqual([]);
  });

  it('is silent for a fully orphaned operator (does not feed anything)', () => {
    const w = materialStructureWarnings(matC(
      [OUT, { id: 'mul', type: 'Multiply' }, { id: 'c', type: 'Constant', params: { R: 1 } }],
      [{ from: 'c:Value', to: 'OUT:Roughness' }],
    ));
    expect(w).toEqual([]);
  });

  it('does not flag non-operator source nodes (e.g. a bare Constant)', () => {
    const w = materialStructureWarnings(matC(
      [OUT, { id: 'c', type: 'Constant' }],
      [{ from: 'c:Value', to: 'OUT:Roughness' }],
    ));
    expect(w).toEqual([]);
  });
});

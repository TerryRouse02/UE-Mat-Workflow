import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveMaterialFunctions } from '../server/mf-resolver';
import { loadGraph } from '../server/graph-loader';

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

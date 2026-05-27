import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateGraph } from '../server/schema';

function loadJson(rel: string) {
  return JSON.parse(readFileSync(resolve(__dirname, '..', '..', rel), 'utf-8'));
}

describe('validateGraph', () => {
  it('accepts the basic PBR example', () => {
    const g = loadJson('agent-pack/examples/01_basic_pbr.matgraph.json');
    expect(validateGraph(g).errors).toEqual([]);
  });

  it('accepts the with-function example', () => {
    const g = loadJson('agent-pack/examples/02_with_function.matgraph.json');
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
});

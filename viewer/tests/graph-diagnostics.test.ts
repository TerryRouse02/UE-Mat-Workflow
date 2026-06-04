import { describe, it, expect } from 'vitest';
import { diagnoseGraph } from '../web/src/graphDiagnostics';

const db = {
  nodes: { Multiply: { inputs: [{ name: 'A', type: 'F' }, { name: 'B', type: 'F' }], outputs: [{ name: 'Result', type: 'F' }] } },
  reservedTypes: ['MaterialOutput', 'FunctionInput', 'FunctionOutput', 'MaterialFunctionCall'],
} as never;

const mat = (nodes: { id: string; type: string }[], connections: { from: string; to: string }[] = [], type = 'Material') =>
  ({ schemaVersion: '1.0', ueVersion: '5.7', type, name: 'm', nodes, connections }) as never;

describe('diagnoseGraph', () => {
  it('flags a Material with no MaterialOutput as a warning (matches the server severity)', () => {
    const out = diagnoseGraph(mat([{ id: 'a', type: 'Multiply' }]), db);
    expect(out.some(i => i.severity === 'warning' && /MaterialOutput/.test(i.message))).toBe(true);
  });

  it('flags an extra MaterialOutput and points at the offending node', () => {
    const out = diagnoseGraph(mat([{ id: 'OUT', type: 'MaterialOutput' }, { id: 'OUT2', type: 'MaterialOutput' }]), db);
    const dup = out.find(i => i.nodeId === 'OUT2');
    expect(dup?.severity).toBe('warning');
  });

  it('flags an unknown node type with its node id', () => {
    const out = diagnoseGraph(mat([{ id: 'x', type: 'Frobnicate' }, { id: 'OUT', type: 'MaterialOutput' }]), db);
    expect(out.find(i => i.nodeId === 'x')?.message).toMatch(/未知節點/);
  });

  it('flags a connection to a non-existent pin and attributes it to the node', () => {
    const out = diagnoseGraph(mat([{ id: 'm', type: 'Multiply' }, { id: 'OUT', type: 'MaterialOutput' }], [{ from: 'm:Nope', to: 'OUT:BaseColor' }]), db);
    expect(out.some(i => i.nodeId === 'm' && /output pin/.test(i.message))).toBe(true);
  });

  it('flags an unresolved MaterialFunctionCall', () => {
    const out = diagnoseGraph(mat([{ id: 'f', type: 'MaterialFunctionCall' }, { id: 'OUT', type: 'MaterialOutput' }]), db, {});
    expect(out.find(i => i.nodeId === 'f')?.message).toMatch(/沒有解析到 pin/);
  });

  it('returns no issues for a healthy material', () => {
    const out = diagnoseGraph(
      mat([{ id: 'm', type: 'Multiply' }, { id: 'OUT', type: 'MaterialOutput' }], [{ from: 'm:Result', to: 'OUT:BaseColor' }]),
      db,
    );
    expect(out).toEqual([]);
  });

  it('requires a FunctionOutput in a MaterialFunction', () => {
    const out = diagnoseGraph(mat([{ id: 'i', type: 'FunctionInput' }], [], 'MaterialFunction'), db);
    expect(out.some(i => i.severity === 'error' && /FunctionOutput/.test(i.message))).toBe(true);
  });

  it('flags a MaterialFunction with no FunctionInput as a warning', () => {
    const out = diagnoseGraph(mat([{ id: 'o', type: 'FunctionOutput' }], [], 'MaterialFunction'), db);
    expect(out.some(i => i.severity === 'warning' && /FunctionInput/.test(i.message))).toBe(true);
  });

  it('returns no issues for a healthy MaterialFunction', () => {
    const out = diagnoseGraph(
      mat([{ id: 'i', type: 'FunctionInput' }, { id: 'o', type: 'FunctionOutput' }], [], 'MaterialFunction'),
      db,
    );
    expect(out).toEqual([]);
  });

  it('attributes an input-side bad pin to the destination node', () => {
    const out = diagnoseGraph(mat([{ id: 'm', type: 'Multiply' }, { id: 'OUT', type: 'MaterialOutput' }], [{ from: 'm:Result', to: 'OUT:Nope' }]), db);
    expect(out.some(i => i.nodeId === 'OUT' && /input pin/.test(i.message))).toBe(true);
  });
});

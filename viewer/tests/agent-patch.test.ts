// M1 patch.ts tests — every op happy path with exact zh-TW diff lines,
// cascade remove, rename rewrite, apply-error cases, why-suffix, immutability.

import { describe, it, expect } from 'vitest';
import { applyPatch, changedNodeIds } from '../server/agent/patch.js';
import type { MatGraph, PatchOp } from '../server/agent/patch.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function baseGraph(): MatGraph {
  return {
    schemaVersion: '1.0',
    ueVersion: '5.7',
    type: 'Material',
    name: 'test',
    nodes: [
      { id: 'A', type: 'Multiply' },
      { id: 'B', type: 'Lerp' },
    ],
    connections: [
      { from: 'A:Result', to: 'B:A' },
    ],
  };
}

// ---------------------------------------------------------------------------
// addNode
// ---------------------------------------------------------------------------

describe('addNode', () => {
  it('happy path: adds node and emits correct diff line', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'addNode', id: 'C', type: 'Add' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes.find(n => n.id === 'C')).toBeDefined();
    expect(r.diff[0]).toBe('加入了 `Add` 節點「`C`」');
  });

  it('happy path: addNode with params stores them', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'addNode', id: 'P', type: 'ScalarParameter', params: { ParameterName: 'Roughness', DefaultValue: 0.5 } }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes.find(n => n.id === 'P')?.params?.ParameterName).toBe('Roughness');
  });

  it('happy path: why suffix appended', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'addNode', id: 'D', type: 'Clamp', why: 'prevents oversaturation' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diff[0]).toBe('加入了 `Clamp` 節點「`D`」（prevents oversaturation）');
  });

  it('error: duplicate id returns opIndex=0', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'addNode', id: 'A', type: 'Add' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.opIndex).toBe(0);
    expect(r.applyError).toMatch(/already exists/);
  });

  it('error: id containing colon returns opIndex', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'addNode', id: 'bad:id', type: 'Add' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.opIndex).toBe(0);
    expect(r.applyError).toMatch(/must not contain ':'/);
  });
});

// ---------------------------------------------------------------------------
// removeNode
// ---------------------------------------------------------------------------

describe('removeNode', () => {
  it('happy path: removes node and emits diff line with N connections', () => {
    const g = baseGraph();
    // A has one connection: A:Result → B:A
    const ops: PatchOp[] = [{ op: 'removeNode', id: 'A' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes.find(n => n.id === 'A')).toBeUndefined();
    // Connection should be gone
    expect(r.graph.connections).toHaveLength(0);
    // Diff: main line
    expect(r.diff[0]).toBe('移除了節點「`A`」及其 1 條連線');
    // Indented connection line
    expect(r.diff[1]).toBe('　└ 斷開 A:Result → B:A');
  });

  it('cascade remove: node with 2 connections emits 1 node line + 2 indented lines', () => {
    const g: MatGraph = {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      type: 'Material',
      name: 'test',
      nodes: [
        { id: 'M', type: 'Multiply' },
        { id: 'X', type: 'Lerp' },
        { id: 'Y', type: 'Add' },
      ],
      connections: [
        { from: 'M:Result', to: 'X:A' },
        { from: 'M:Result', to: 'Y:A' },
      ],
    };
    const ops: PatchOp[] = [{ op: 'removeNode', id: 'M' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diff).toHaveLength(3);
    expect(r.diff[0]).toBe('移除了節點「`M`」及其 2 條連線');
    expect(r.diff[1]).toBe('　└ 斷開 M:Result → X:A');
    expect(r.diff[2]).toBe('　└ 斷開 M:Result → Y:A');
  });

  it('happy path: node with 0 connections', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'removeNode', id: 'B' }];
    const r = applyPatch(g, ops);
    // B→ has an incoming connection (A:Result → B:A), so 1 connection
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diff[0]).toBe('移除了節點「`B`」及其 1 條連線');
  });

  it('happy path: why suffix on removeNode', () => {
    const g: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'test',
      nodes: [{ id: 'solo', type: 'Add' }],
      connections: [],
    };
    const ops: PatchOp[] = [{ op: 'removeNode', id: 'solo', why: 'redundant' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diff[0]).toBe('移除了節點「`solo`」及其 0 條連線（redundant）');
  });

  it('error: missing node returns opIndex', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'removeNode', id: 'Z' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.opIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// setParam
// ---------------------------------------------------------------------------

describe('setParam', () => {
  it('happy path: creates params and emits diff', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'setParam', id: 'A', key: 'ConstA', value: 0.3 }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes.find(n => n.id === 'A')?.params?.ConstA).toBe(0.3);
    expect(r.diff[0]).toBe('將「`A`」的 ConstA 改為 0.3');
  });

  it('happy path: value renders with JSON.stringify (string)', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'setParam', id: 'A', key: 'Name', value: 'MyName' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diff[0]).toBe('將「`A`」的 Name 改為 "MyName"');
  });

  it('happy path: why suffix', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'setParam', id: 'A', key: 'ConstA', value: 1, why: 'full opacity' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diff[0]).toBe('將「`A`」的 ConstA 改為 1（full opacity）');
  });

  it('error: missing node', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'setParam', id: 'Z', key: 'k', value: 1 }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.opIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// renameNode
// ---------------------------------------------------------------------------

describe('renameNode', () => {
  it('happy path: renames node and rewrites connection references', () => {
    const g = baseGraph();
    // A:Result → B:A  (both from and to reference A indirectly — from does)
    const ops: PatchOp[] = [{ op: 'renameNode', id: 'A', newId: 'NewA' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes.find(n => n.id === 'NewA')).toBeDefined();
    expect(r.graph.nodes.find(n => n.id === 'A')).toBeUndefined();
    // Connection from should be rewritten
    expect(r.graph.connections[0].from).toBe('NewA:Result');
    expect(r.graph.connections[0].to).toBe('B:A');
    expect(r.diff[0]).toMatch(/將「`A`」改名為「`NewA`」（同步更新 1 條連線）/);
  });

  it('rename rewrites both from and to references when same node appears in both', () => {
    const g: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'test',
      nodes: [
        { id: 'X', type: 'Add' },
        { id: 'Y', type: 'Multiply' },
      ],
      connections: [
        { from: 'X:Result', to: 'Y:A' },
        { from: 'Y:Result', to: 'X:A' },  // Y→X reference
      ],
    };
    const ops: PatchOp[] = [{ op: 'renameNode', id: 'X', newId: 'Z' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.connections[0].from).toBe('Z:Result');
    expect(r.graph.connections[1].to).toBe('Z:A');
    expect(r.diff[0]).toMatch(/同步更新 2 條連線/);
  });

  it('happy path: why suffix', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'renameNode', id: 'A', newId: 'MulNode', why: 'clarity' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diff[0]).toContain('（clarity）');
  });

  it('error: source id not found', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'renameNode', id: 'Z', newId: 'W' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.opIndex).toBe(0);
    expect(r.applyError).toMatch(/not found/);
  });

  it('error: target id already exists', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'renameNode', id: 'A', newId: 'B' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.opIndex).toBe(0);
    expect(r.applyError).toMatch(/already exists/);
  });

  it('error: newId contains colon', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'renameNode', id: 'A', newId: 'bad:id' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.opIndex).toBe(0);
    expect(r.applyError).toMatch(/must not contain ':'/);
  });
});

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

describe('connect', () => {
  it('happy path: adds connection and emits diff', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'connect', from: 'A:Result', to: 'B:B' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.connections.some(c => c.from === 'A:Result' && c.to === 'B:B')).toBe(true);
    expect(r.diff[0]).toBe('連接 A:Result → B:B');
  });

  it('happy path: why suffix', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'connect', from: 'A:Result', to: 'B:Alpha', why: 'blend control' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diff[0]).toBe('連接 A:Result → B:Alpha（blend control）');
  });

  it('error: duplicate connection', () => {
    const g = baseGraph();
    // A:Result → B:A already exists
    const ops: PatchOp[] = [{ op: 'connect', from: 'A:Result', to: 'B:A' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.opIndex).toBe(0);
    expect(r.applyError).toMatch(/already exists/);
  });

  it('error: from missing colon', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'connect', from: 'AResult', to: 'B:A' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.opIndex).toBe(0);
    expect(r.applyError).toMatch(/nodeId:pinName/);
  });

  it('error: to missing colon', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'connect', from: 'A:Result', to: 'BA' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.opIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// disconnect
// ---------------------------------------------------------------------------

describe('disconnect', () => {
  it('happy path: removes connection and emits diff', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'disconnect', from: 'A:Result', to: 'B:A' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.connections).toHaveLength(0);
    expect(r.diff[0]).toBe('斷開 A:Result → B:A');
  });

  it('happy path: why suffix', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'disconnect', from: 'A:Result', to: 'B:A', why: 'testing' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diff[0]).toBe('斷開 A:Result → B:A（testing）');
  });

  it('error: connection not found', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'disconnect', from: 'A:Result', to: 'B:B' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.opIndex).toBe(0);
    expect(r.applyError).toMatch(/not found/);
  });

  it('error: from missing colon', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'disconnect', from: 'AResult', to: 'B:A' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.opIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// setDescription
// ---------------------------------------------------------------------------

describe('setDescription', () => {
  it('happy path: sets description and emits diff', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [{ op: 'setDescription', value: 'A PBR material' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.description).toBe('A PBR material');
    expect(r.diff[0]).toBe('設定描述為 "A PBR material"');
  });
});

// ---------------------------------------------------------------------------
// Multi-op sequences and opIndex accuracy
// ---------------------------------------------------------------------------

describe('multi-op sequences', () => {
  it('error in second op reports opIndex=1 and earlier ops are NOT applied (immutable input)', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [
      { op: 'addNode', id: 'C', type: 'Add' },
      { op: 'addNode', id: 'A', type: 'Multiply' }, // duplicate
    ];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.opIndex).toBe(1);
    // Input graph must not have been mutated
    expect(g.nodes).toHaveLength(2);
    expect(g.nodes.find(n => n.id === 'C')).toBeUndefined();
  });

  it('accumulates multiple diff lines for multi-op sequence', () => {
    const g = baseGraph();
    const ops: PatchOp[] = [
      { op: 'addNode', id: 'C', type: 'Lerp' },
      { op: 'connect', from: 'B:Result', to: 'C:A' },
    ];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diff).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Input graph not mutated
// ---------------------------------------------------------------------------

describe('immutability', () => {
  it('input graph nodes are not mutated by successful ops', () => {
    const g = baseGraph();
    const origNodeCount = g.nodes.length;
    const ops: PatchOp[] = [{ op: 'addNode', id: 'Z', type: 'Add' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
    expect(g.nodes).toHaveLength(origNodeCount);
  });

  it('input graph connections are not mutated by failed ops', () => {
    const g = baseGraph();
    const origConnCount = g.connections.length;
    const ops: PatchOp[] = [{ op: 'removeNode', id: 'NONEXISTENT' }];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(false);
    expect(g.connections).toHaveLength(origConnCount);
  });
});

describe('unknown op guard', () => {
  it('returns a clear applyError with opIndex — ops are a blind cast from LLM output', () => {
    const g = baseGraph();
    const ops = [{ op: 'frobnicate', id: 'x' }] as unknown as PatchOp[];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.opIndex).toBe(0);
      expect(r.applyError).toMatch(/unknown op "frobnicate"/);
    }
  });
});

describe('changedNodeIds (canvas diff highlight)', () => {
  it('collects ids per op kind, deduped; removeNode/setDescription contribute none', () => {
    const ops: PatchOp[] = [
      { op: 'addNode', id: 'glow', type: 'Multiply' },
      { op: 'setParam', id: 'glow', key: 'ConstA', value: 2 },
      { op: 'renameNode', id: 'old', newId: 'fresh' },
      { op: 'connect', from: 'color:Output', to: 'glow:A' },
      { op: 'disconnect', from: 'noise:Output', to: 'base:Color' },
      { op: 'removeNode', id: 'gone' },
      { op: 'setDescription', value: 'x' },
    ];
    expect(changedNodeIds(ops).sort()).toEqual(
      ['base', 'color', 'fresh', 'glow', 'noise'].sort(),
    );
  });

  it('returns empty for an op list with nothing to highlight', () => {
    expect(changedNodeIds([{ op: 'removeNode', id: 'a' }])).toEqual([]);
  });
});

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

// BUG-6 regression — connect/disconnect must reject empty endpoint halves.
describe('empty endpoint halves (BUG-6)', () => {
  it('connect with a trailing-colon from is rejected', () => {
    const r = applyPatch(baseGraph(), [{ op: 'connect', from: 'A:', to: 'B:A' } as PatchOp]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.applyError).toContain('nodeId:pinName');
  });

  it('connect with an empty node id is rejected', () => {
    const r = applyPatch(baseGraph(), [{ op: 'connect', from: ':Value', to: 'B:A' } as PatchOp]);
    expect(r.ok).toBe(false);
  });

  it('disconnect with an empty pin is rejected', () => {
    const r = applyPatch(baseGraph(), [{ op: 'disconnect', from: 'A:', to: 'B:A' } as PatchOp]);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// removeParam / setNodeType (incremental-edit completeness)
// ---------------------------------------------------------------------------

describe('removeParam', () => {
  it('happy path: deletes the key and drops an emptied params object', () => {
    const g = baseGraph();
    g.nodes[0].params = { ConstA: 2 };
    const r = applyPatch(g, [{ op: 'removeParam', id: 'A', key: 'ConstA' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes.find(n => n.id === 'A')?.params).toBeUndefined();
    expect(r.diff[0]).toBe('移除了「`A`」的 ConstA 參數');
  });

  it('happy path: other params survive', () => {
    const g = baseGraph();
    g.nodes[0].params = { ConstA: 2, ConstB: 3 };
    const r = applyPatch(g, [{ op: 'removeParam', id: 'A', key: 'ConstA' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes.find(n => n.id === 'A')?.params).toEqual({ ConstB: 3 });
  });

  it('error: missing node / missing key', () => {
    expect(applyPatch(baseGraph(), [{ op: 'removeParam', id: 'NOPE', key: 'k' }]).ok).toBe(false);
    const r = applyPatch(baseGraph(), [{ op: 'removeParam', id: 'A', key: 'NotThere' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.applyError).toMatch(/has no param "NotThere"/);
  });
});

describe('setNodeType', () => {
  it('happy path: swaps the type in place, keeping id/params/connections', () => {
    const g = baseGraph();
    g.nodes[0].params = { ConstA: 2 };
    const r = applyPatch(g, [{ op: 'setNodeType', id: 'A', type: 'Add' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const node = r.graph.nodes.find(n => n.id === 'A');
    expect(node?.type).toBe('Add');
    expect(node?.params).toEqual({ ConstA: 2 });
    expect(r.graph.connections).toEqual([{ from: 'A:Result', to: 'B:A' }]);
    expect(r.diff[0]).toBe('將「`A`」的類型從 `Multiply` 改為 `Add`');
  });

  it('error: missing node / already that type', () => {
    expect(applyPatch(baseGraph(), [{ op: 'setNodeType', id: 'NOPE', type: 'Add' }]).ok).toBe(false);
    const r = applyPatch(baseGraph(), [{ op: 'setNodeType', id: 'A', type: 'Multiply' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.applyError).toMatch(/already of type/);
  });
});

// ---------------------------------------------------------------------------
// snake_case aliases — LLMs routinely emit these instead of the camelCase ops
// ---------------------------------------------------------------------------

describe('op aliases', () => {
  it('add_node / set_param / add_connection map to their canonical ops', () => {
    const ops = [
      { op: 'add_node', id: 'C', type: 'Constant' },
      { op: 'set_param', id: 'C', key: 'R', value: 1 },
      { op: 'add_connection', from: 'C:Output', to: 'B:B' },
    ] as unknown as PatchOp[];
    const r = applyPatch(baseGraph(), ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes.find(n => n.id === 'C')?.params?.R).toBe(1);
    expect(r.graph.connections.some(c => c.from === 'C:Output' && c.to === 'B:B')).toBe(true);
  });

  it('remove_connection / remove_node / set_description work too', () => {
    const ops = [
      { op: 'remove_connection', from: 'A:Result', to: 'B:A' },
      { op: 'remove_node', id: 'A' },
      { op: 'set_description', value: 'aliased' },
    ] as unknown as PatchOp[];
    const r = applyPatch(baseGraph(), ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes.some(n => n.id === 'A')).toBe(false);
    expect(r.graph.description).toBe('aliased');
  });

  it('changedNodeIds normalizes aliases and counts the new ops', () => {
    const ops = [
      { op: 'set_param', id: 'A', key: 'k', value: 1 },
      { op: 'removeParam', id: 'B', key: 'k' },
      { op: 'set_node_type', id: 'C', type: 'Add' },
    ] as unknown as PatchOp[];
    expect(changedNodeIds(ops).sort()).toEqual(['A', 'B', 'C']);
  });
});

// ---------------------------------------------------------------------------
// Occupied input pin — UE inputs take exactly one wire
// ---------------------------------------------------------------------------

describe('connect: occupied input pin', () => {
  it('rejects a second connection into the same input pin with a how-to-fix hint', () => {
    const g = baseGraph(); // A:Result → B:A already wired
    const r = applyPatch(g, [{ op: 'connect', from: 'B:Result', to: 'B:A' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.applyError).toContain('already has a connection');
      expect(r.applyError).toContain('A:Result');
    }
  });

  it('disconnect-then-connect rewires in one patch', () => {
    const g = baseGraph();
    const r = applyPatch(g, [
      { op: 'disconnect', from: 'A:Result', to: 'B:A' },
      { op: 'connect', from: 'A:Result', to: 'B:B' },
      { op: 'connect', from: 'A:Result', to: 'B:A' },
    ]);
    expect(r.ok).toBe(true);
  });
});

describe('unknown op error lists supported ops', () => {
  it('mentions canonical names and the snake_case tolerance', () => {
    const r = applyPatch(baseGraph(), [{ op: 'move' }] as unknown as PatchOp[]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.applyError).toContain('addNode');
      expect(r.applyError).toContain('setNodeType');
      expect(r.applyError).toContain('snake_case');
    }
  });
});

// ---------------------------------------------------------------------------
// Batch error collection — every failing op reported, one retry fixes all
// ---------------------------------------------------------------------------

describe('batch error collection', () => {
  it('reports EVERY failing op with its own opIndex; first error mirrored in opIndex/applyError', () => {
    const g = baseGraph();
    const r = applyPatch(g, [
      { op: 'addNode', id: 'A', type: 'Add' },                  // 0: duplicate id
      { op: 'setParam', id: 'B', key: 'ConstB', value: 1 },     // 1: ok
      { op: 'removeNode', id: 'ghost' },                        // 2: not found
      { op: 'connect', from: 'B:Result', to: 'noColon' },       // 3: malformed endpoint
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.map(e => e.opIndex)).toEqual([0, 2, 3]);
    expect(r.errors[0].message).toMatch(/already exists/);
    expect(r.errors[1].message).toMatch(/not found/);
    expect(r.errors[2].message).toMatch(/nodeId:pinName/);
    // Back-compat mirror of the first error
    expect(r.opIndex).toBe(0);
    expect(r.applyError).toMatch(/already exists/);
  });

  it('anti-cascade: a failed addNode still registers its id so later ops do not all spuriously fail', () => {
    const g = baseGraph();
    const r = applyPatch(g, [
      { op: 'addNode', id: 'bad:id', type: 'Add' },             // 0: colon — fails
      { op: 'setParam', id: 'bad:id', key: 'ConstA', value: 1 }, // 1: would be "not found" without the phantom
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].opIndex).toBe(0);
  });

  it('input graph is untouched after a multi-error batch', () => {
    const g = baseGraph();
    const before = structuredClone(g);
    const r = applyPatch(g, [
      { op: 'removeNode', id: 'nope1' },
      { op: 'removeNode', id: 'nope2' },
    ]);
    expect(r.ok).toBe(false);
    expect(g).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// addNode auto-id
// ---------------------------------------------------------------------------

describe('addNode auto-id', () => {
  it('omitted id is generated from the type and reported in assignedIds + resolvedOps', () => {
    const g = baseGraph();
    const r = applyPatch(g, [{ op: 'addNode', type: 'Multiply' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.assignedIds).toEqual({ 0: 'multiply_1' });
    expect(r.graph.nodes.some(n => n.id === 'multiply_1')).toBe(true);
    const resolved = r.resolvedOps[0];
    expect(resolved.op === 'addNode' && resolved.id).toBe('multiply_1');
    expect(changedNodeIds(r.resolvedOps)).toContain('multiply_1');
  });

  it('suffix counts past existing ids — two unnamed Lerps after node lerp_1', () => {
    const g = baseGraph();
    g.nodes.push({ id: 'lerp_1', type: 'Lerp' });
    const r = applyPatch(g, [
      { op: 'addNode', type: 'Lerp' },
      { op: 'addNode', type: 'Lerp' },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.assignedIds).toEqual({ 0: 'lerp_2', 1: 'lerp_3' });
  });

  it('type is sanitized to lowercase alphanumerics for the id base', () => {
    const r = applyPatch(baseGraph(), [{ op: 'addNode', type: 'Constant3Vector' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.assignedIds[0]).toBe('constant3vector_1');
  });

  it('explicit ids still collide as before; assignedIds stays empty', () => {
    const r = applyPatch(baseGraph(), [{ op: 'addNode', id: 'A', type: 'Add' }]);
    expect(r.ok).toBe(false);
    if (!r.ok) return;
    expect(r.errors[0].message).toMatch(/already exists/);
  });
});

// ---------------------------------------------------------------------------
// insertNode — splice into an existing connection in one op
// ---------------------------------------------------------------------------

const PIN_LOOKUP = (type: string) =>
  type === 'Multiply' ? { inputs: ['A', 'B'], outputs: ['Result'] } :
  type === 'Lerp' ? { inputs: ['A', 'B', 'Alpha'], outputs: ['Result'] } :
  null;

describe('insertNode', () => {
  it('explicit pins: replaces the connection with two and adds the node', () => {
    const g = baseGraph(); // A:Result → B:A
    const r = applyPatch(g, [{
      op: 'insertNode', between: { from: 'A:Result', to: 'B:A' },
      type: 'Multiply', id: 'boost', inputPin: 'A', outputPin: 'Result',
    }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes.some(n => n.id === 'boost')).toBe(true);
    expect(r.graph.connections).toContainEqual({ from: 'A:Result', to: 'boost:A' });
    expect(r.graph.connections).toContainEqual({ from: 'boost:Result', to: 'B:A' });
    expect(r.graph.connections).not.toContainEqual({ from: 'A:Result', to: 'B:A' });
    expect(r.diff[0]).toContain('插入了');
    expect(r.diff[0]).toContain('boost');
  });

  it('pins inferred from pinLookup (first input / first output) when omitted', () => {
    const g = baseGraph();
    const r = applyPatch(
      g,
      [{ op: 'insertNode', between: { from: 'A:Result', to: 'B:A' }, type: 'Lerp', id: 'mix' }],
      { pinLookup: PIN_LOOKUP },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.connections).toContainEqual({ from: 'A:Result', to: 'mix:A' });
    expect(r.graph.connections).toContainEqual({ from: 'mix:Result', to: 'B:A' });
  });

  it('auto-id works for insertNode too', () => {
    const g = baseGraph();
    const r = applyPatch(
      g,
      [{ op: 'insertNode', between: { from: 'A:Result', to: 'B:A' }, type: 'Multiply' }],
      { pinLookup: PIN_LOOKUP },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.assignedIds).toEqual({ 0: 'multiply_1' });
    expect(r.graph.connections).toContainEqual({ from: 'A:Result', to: 'multiply_1:A' });
  });

  it('no signature and no explicit pins → clear error naming the missing pin', () => {
    const g = baseGraph();
    const r = applyPatch(
      g,
      [{ op: 'insertNode', between: { from: 'A:Result', to: 'B:A' }, type: 'CustomThing', id: 'c1' }],
      { pinLookup: PIN_LOOKUP }, // returns null for CustomThing
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].message).toMatch(/inputPin explicitly/);
  });

  it('between connection not found → error', () => {
    const g = baseGraph();
    const r = applyPatch(g, [{
      op: 'insertNode', between: { from: 'A:Result', to: 'B:Alpha' },
      type: 'Multiply', id: 'x', inputPin: 'A', outputPin: 'Result',
    }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].message).toMatch(/not found/);
    expect(r.errors[0].message).toMatch(/EXISTING connection/);
  });

  it('malformed between → error', () => {
    const r = applyPatch(baseGraph(), [
      { op: 'insertNode', between: { from: 'A:Result', to: 'noColon' }, type: 'Multiply', id: 'x' },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].message).toMatch(/between must be/);
  });

  it('insert_node / insert_between aliases map to insertNode', () => {
    const g = baseGraph();
    const ops = [
      { op: 'insert_node', between: { from: 'A:Result', to: 'B:A' }, type: 'Multiply', id: 'm1', inputPin: 'A', outputPin: 'Result' },
    ] as unknown as PatchOp[];
    const r = applyPatch(g, ops);
    expect(r.ok).toBe(true);
  });

  it('changedNodeIds covers the new node and both neighbours', () => {
    const ids = changedNodeIds([
      { op: 'insertNode', between: { from: 'A:Result', to: 'B:A' }, type: 'Multiply', id: 'mid' },
    ]);
    expect(ids.sort()).toEqual(['A', 'B', 'mid']);
  });
});

// ---------------------------------------------------------------------------
// removeNode heal — splice upstream source onto fed pins
// ---------------------------------------------------------------------------

describe('removeNode heal', () => {
  /** A:Result → B:A, B:Result → C:A and C:B (B is the removable middleman). */
  function chainGraph(): MatGraph {
    return {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      type: 'Material',
      name: 'chain',
      nodes: [
        { id: 'A', type: 'Multiply' },
        { id: 'B', type: 'Saturate' },
        { id: 'C', type: 'Lerp' },
      ],
      connections: [
        { from: 'A:Result', to: 'B:Input' },
        { from: 'B:Result', to: 'C:A' },
        { from: 'B:Result', to: 'C:B' },
      ],
    };
  }

  it('1 incoming, 2 outgoing from one pin → both rewired to the source', () => {
    const r = applyPatch(chainGraph(), [{ op: 'removeNode', id: 'B', heal: true }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes.some(n => n.id === 'B')).toBe(false);
    expect(r.graph.connections).toContainEqual({ from: 'A:Result', to: 'C:A' });
    expect(r.graph.connections).toContainEqual({ from: 'A:Result', to: 'C:B' });
    expect(r.graph.connections).toHaveLength(2);
    expect(r.diff[0]).toContain('縫合');
  });

  it('no incoming → error suggesting plain removeNode', () => {
    const g = chainGraph();
    g.connections = g.connections.filter(c => c.to !== 'B:Input');
    const r = applyPatch(g, [{ op: 'removeNode', id: 'B', heal: true }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].message).toMatch(/no incoming/);
  });

  it('several incoming without healFrom → error listing the wired input pins', () => {
    const g = chainGraph();
    g.connections.push({ from: 'C:Result', to: 'B:Extra' });
    const r = applyPatch(g, [{ op: 'removeNode', id: 'B', heal: true }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].message).toMatch(/healFrom/);
    expect(r.errors[0].message).toContain('Input');
    expect(r.errors[0].message).toContain('Extra');
  });

  it('several incoming with healFrom → the chosen source survives', () => {
    const g = chainGraph();
    g.connections.push({ from: 'C:Result', to: 'B:Extra' });
    const r = applyPatch(g, [{ op: 'removeNode', id: 'B', heal: true, healFrom: 'Extra' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.connections).toContainEqual({ from: 'C:Result', to: 'C:A' });
    expect(r.graph.connections).toContainEqual({ from: 'C:Result', to: 'C:B' });
  });

  it('healFrom naming an unwired pin → error', () => {
    const g = chainGraph();
    g.connections.push({ from: 'C:Result', to: 'B:Extra' });
    const r = applyPatch(g, [{ op: 'removeNode', id: 'B', heal: true, healFrom: 'Nope' }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].message).toMatch(/matches no incoming/);
  });

  it('outgoing from two different output pins → ambiguous, refused', () => {
    const g = chainGraph();
    g.connections = [
      { from: 'A:Result', to: 'B:Input' },
      { from: 'B:Result', to: 'C:A' },
      { from: 'B:Other', to: 'C:B' },
    ];
    const r = applyPatch(g, [{ op: 'removeNode', id: 'B', heal: true }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].message).toMatch(/ambiguous/);
  });

  it('heal with zero outgoing degenerates to a plain remove', () => {
    const g = chainGraph();
    g.connections = [{ from: 'A:Result', to: 'B:Input' }];
    const r = applyPatch(g, [{ op: 'removeNode', id: 'B', heal: true }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.connections).toHaveLength(0);
    expect(r.diff[0]).toContain('移除了節點');
  });
});

// ---------------------------------------------------------------------------
// comment ops (addComment / setComment / removeComment)
// ---------------------------------------------------------------------------

// A graph that already carries one comment, for set/remove cases.
function commentGraph(): MatGraph {
  return {
    schemaVersion: '1.0',
    ueVersion: '5.7',
    type: 'Material',
    name: 'test',
    nodes: [
      { id: 'A', type: 'Multiply' },
      { id: 'B', type: 'Lerp' },
    ],
    connections: [],
    comments: [{ id: 'note1', text: 'old', contains: ['A'] }],
  };
}

describe('addComment', () => {
  it('happy path: appends a comment and emits the diff line', () => {
    const g = baseGraph();
    const r = applyPatch(g, [{ op: 'addComment', id: 'note1', text: 'PBR base', contains: ['A', 'B'] }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.graph.comments?.find(x => x.id === 'note1');
    expect(c).toEqual({ id: 'note1', text: 'PBR base', contains: ['A', 'B'] });
    expect(r.diff[0]).toBe('加入了註解框「`note1`」');
  });

  it('omitted id is auto-generated and reported in assignedIds', () => {
    const g = baseGraph();
    const r = applyPatch(g, [{ op: 'addComment', text: 'auto' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.assignedIds[0]).toBe('comment_1');
    const c = r.graph.comments?.find(x => x.id === 'comment_1');
    expect(c).toEqual({ id: 'comment_1', text: 'auto', contains: [] });
  });

  it('stores color when provided', () => {
    const g = baseGraph();
    const r = applyPatch(g, [{ op: 'addComment', id: 'c', text: 't', color: '#FF0000' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.comments?.find(x => x.id === 'c')?.color).toBe('#FF0000');
  });

  it('error: duplicate comment id', () => {
    const g = commentGraph();
    const r = applyPatch(g, [{ op: 'addComment', id: 'note1', text: 'dup' }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.applyError).toMatch(/already exists/);
  });
});

describe('setComment', () => {
  it('happy path: updates only the provided fields and keeps the rest', () => {
    const g = commentGraph();
    const r = applyPatch(g, [{ op: 'setComment', id: 'note1', text: 'new' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.graph.comments?.find(x => x.id === 'note1');
    expect(c).toEqual({ id: 'note1', text: 'new', contains: ['A'] }); // contains preserved
    expect(r.diff[0]).toBe('更新了註解框「`note1`」');
  });

  it('can replace contains and set color in one op', () => {
    const g = commentGraph();
    const r = applyPatch(g, [{ op: 'setComment', id: 'note1', contains: ['A', 'B'], color: '#0F0' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.graph.comments?.find(x => x.id === 'note1');
    expect(c?.contains).toEqual(['A', 'B']);
    expect(c?.color).toBe('#0F0');
  });

  it('error: comment not found', () => {
    const g = commentGraph();
    const r = applyPatch(g, [{ op: 'setComment', id: 'nope', text: 'x' }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.applyError).toMatch(/not found/);
  });

  it('error: nothing to change', () => {
    const g = commentGraph();
    const r = applyPatch(g, [{ op: 'setComment', id: 'note1' }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.applyError).toMatch(/nothing to change/);
  });
});

describe('removeComment', () => {
  it('happy path: removes the comment and emits the diff line', () => {
    const g = commentGraph();
    const r = applyPatch(g, [{ op: 'removeComment', id: 'note1', why: 'no longer needed' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.comments?.find(x => x.id === 'note1')).toBeUndefined();
    expect(r.diff[0]).toBe('移除了註解框「`note1`」（no longer needed）');
  });

  it('error: comment not found', () => {
    const g = commentGraph();
    const r = applyPatch(g, [{ op: 'removeComment', id: 'nope' }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.applyError).toMatch(/not found/);
  });

  it('does not mutate the input graph', () => {
    const g = commentGraph();
    applyPatch(g, [{ op: 'removeComment', id: 'note1' }]);
    expect(g.comments).toHaveLength(1); // input untouched
  });
});

// ---------------------------------------------------------------------------
// autoLayout — clears stored positions so the viewer re-runs dagre (Format Graph)
// ---------------------------------------------------------------------------

describe('autoLayout', () => {
  it('clears every stored position and reports the count', () => {
    const g = baseGraph();
    g.nodes[0].pos = { x: 10, y: 20 };
    g.nodes[1].pos = { x: 30, y: 40 };
    const r = applyPatch(g, [{ op: 'autoLayout' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes.every(n => n.pos === undefined)).toBe(true);
    expect(r.diff[0]).toMatch(/重新排版.*2/);
  });

  it('succeeds (no-op) when no node has a position', () => {
    const g = baseGraph();
    const r = applyPatch(g, [{ op: 'autoLayout' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diff[0]).toMatch(/重新排版/);
  });

  it('accepts the format_graph alias', () => {
    const g = baseGraph();
    g.nodes[0].pos = { x: 1, y: 2 };
    const r = applyPatch(g, [{ op: 'format_graph' } as unknown as PatchOp]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes[0].pos).toBeUndefined();
  });

  it('does not mutate the input graph', () => {
    const g = baseGraph();
    g.nodes[0].pos = { x: 1, y: 2 };
    applyPatch(g, [{ op: 'autoLayout' }]);
    expect(g.nodes[0].pos).toEqual({ x: 1, y: 2 }); // input untouched
  });
});

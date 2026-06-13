// Tests for node-position ops in patch.ts:
//   setPosition (+ aliases set_position / move_node)
//   addNode with pos
//   insertNode auto-midpoint when both endpoints have pos

import { describe, it, expect } from 'vitest';
import { applyPatch, changedNodeIds } from '../server/agent/patch.js';
import type { MatGraph, PatchOp } from '../server/agent/patch.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function baseGraph(): MatGraph {
  return {
    schemaVersion: '1.0',
    ueVersion: '5.7',
    type: 'Material',
    name: 'test',
    nodes: [
      { id: 'A', type: 'Multiply', pos: { x: 0, y: 0 } },
      { id: 'B', type: 'Lerp',    pos: { x: 600, y: 0 } },
    ],
    connections: [{ from: 'A:Result', to: 'B:A' }],
  };
}

// ---------------------------------------------------------------------------
// setPosition
// ---------------------------------------------------------------------------

describe('setPosition', () => {
  it('sets the node pos (Math.round applied)', () => {
    const r = applyPatch(baseGraph(), [{ op: 'setPosition', id: 'A', pos: { x: 123.7, y: -50.2 } }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const node = r.graph.nodes.find(n => n.id === 'A');
    expect(node?.pos).toEqual({ x: 124, y: -50 });
  });

  it('alias set_position works', () => {
    const ops = [{ op: 'set_position', id: 'A', pos: { x: 200, y: 300 } }] as unknown as PatchOp[];
    const r = applyPatch(baseGraph(), ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes.find(n => n.id === 'A')?.pos).toEqual({ x: 200, y: 300 });
  });

  it('alias move_node works', () => {
    const ops = [{ op: 'move_node', id: 'B', pos: { x: 800, y: 100 } }] as unknown as PatchOp[];
    const r = applyPatch(baseGraph(), ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.graph.nodes.find(n => n.id === 'B')?.pos).toEqual({ x: 800, y: 100 });
  });

  it('missing node id → applyError', () => {
    const r = applyPatch(baseGraph(), [{ op: 'setPosition', id: 'NOPE', pos: { x: 0, y: 0 } }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.applyError).toMatch(/not found/);
  });
});

// ---------------------------------------------------------------------------
// addNode with pos
// ---------------------------------------------------------------------------

describe('addNode with pos', () => {
  it('new node carries the given pos (integer after round)', () => {
    const r = applyPatch(baseGraph(), [{ op: 'addNode', id: 'C', type: 'Add', pos: { x: 300.4, y: -100.6 } }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const node = r.graph.nodes.find(n => n.id === 'C');
    expect(node?.pos).toEqual({ x: 300, y: -101 });
  });
});

// ---------------------------------------------------------------------------
// insertNode auto-midpoint
// ---------------------------------------------------------------------------

describe('insertNode auto-midpoint', () => {
  it('both endpoints have pos → inserted node pos = integer midpoint', () => {
    // A:pos={0,0}, B:pos={600,0} → midpoint = {300,0}
    const r = applyPatch(
      baseGraph(),
      [{
        op: 'insertNode',
        between: { from: 'A:Result', to: 'B:A' },
        type: 'Multiply',
        id: 'mid',
        inputPin: 'A',
        outputPin: 'Result',
      }],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const node = r.graph.nodes.find(n => n.id === 'mid');
    expect(node?.pos).toEqual({ x: 300, y: 0 });
  });

  it('endpoints without pos → inserted node has no pos', () => {
    const g: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'test',
      nodes: [
        { id: 'A', type: 'Multiply' },
        { id: 'B', type: 'Lerp' },
      ],
      connections: [{ from: 'A:Result', to: 'B:A' }],
    };
    const r = applyPatch(g, [{
      op: 'insertNode',
      between: { from: 'A:Result', to: 'B:A' },
      type: 'Multiply',
      id: 'mid',
      inputPin: 'A',
      outputPin: 'Result',
    }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const node = r.graph.nodes.find(n => n.id === 'mid');
    expect(node?.pos).toBeUndefined();
  });

  it('non-finite endpoint pos (NaN) → midpoint guard rejects; inserted node has no pos', () => {
    // One endpoint has NaN in its pos — the guard must skip the midpoint and leave pos undefined.
    const g: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'test',
      nodes: [
        { id: 'A', type: 'Multiply', pos: { x: NaN, y: 0 } },
        { id: 'B', type: 'Lerp',    pos: { x: 600, y: 0 } },
      ],
      connections: [{ from: 'A:Result', to: 'B:A' }],
    };
    const r = applyPatch(g, [{
      op: 'insertNode',
      between: { from: 'A:Result', to: 'B:A' },
      type: 'Multiply',
      id: 'mid',
      inputPin: 'A',
      outputPin: 'Result',
    }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const node = r.graph.nodes.find(n => n.id === 'mid');
    // Guard must reject the non-finite midpoint — no pos assigned.
    expect(node?.pos).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// changedNodeIds — regression: setPosition'd nodes must appear
// ---------------------------------------------------------------------------

describe('changedNodeIds — setPosition', () => {
  it('setPosition op includes the targeted node id', () => {
    const ops = [{ op: 'setPosition', id: 'foo', pos: { x: 1, y: 2 } }] as unknown as PatchOp[];
    expect(changedNodeIds(ops)).toEqual(['foo']);
  });

  it('move_node alias also includes the targeted node id', () => {
    const ops = [{ op: 'move_node', id: 'bar', pos: { x: 10, y: 20 } }] as unknown as PatchOp[];
    expect(changedNodeIds(ops)).toContain('bar');
  });
});

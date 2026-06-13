// Tests for optional node positions (pos:{x,y}) in UE import and hybrid layout.
// Covers CLAUDE.md invariant #6: imported graphs carry UE editor positions; the
// viewer's hybrid layout honours stored positions and dagre-places the rest.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseUET3D } from '../web/src/export/ueImport';
import { applyLayout } from '../web/src/layout';
import type { ExportMeta } from '../web/src/export/export-meta-types';
import type { Node, Edge } from 'reactflow';

const exportMeta: ExportMeta = JSON.parse(
  readFileSync(resolve(__dirname, '../../agent-pack/nodes-ue5.7.export.json'), 'utf-8'),
);

// ---------------------------------------------------------------------------
// 1. parseUET3D — pos on imported expression nodes
// ---------------------------------------------------------------------------

describe('parseUET3D — node positions', () => {
  const fixture = readFileSync(
    resolve(__dirname, 'fixtures/ue-official-stress.t3d'),
    'utf-8',
  );

  it('every expression node has a pos:{x,y} property (Math.round of NodePosX/Y)', () => {
    const { graph } = parseUET3D(fixture, exportMeta);
    // All non-MaterialOutput nodes must have a pos.
    const nonRoot = graph.nodes.filter(n => n.type !== 'MaterialOutput');
    expect(nonRoot.length).toBeGreaterThan(0);
    for (const n of nonRoot) {
      expect(n.pos, `node ${n.id} missing pos`).toBeDefined();
      expect(Number.isInteger(n.pos!.x), `${n.id}.pos.x not integer`).toBe(true);
      expect(Number.isInteger(n.pos!.y), `${n.id}.pos.y not integer`).toBe(true);
    }
  });

  it('pos values match the NodePosX/NodePosY in the fixture (spot-check first node)', () => {
    // The fixture's first MaterialGraphNode has NodePosX=-960 NodePosY=-280.
    const { graph } = parseUET3D(fixture, exportMeta);
    const first = graph.nodes.find(n => n.type !== 'MaterialOutput');
    expect(first).toBeDefined();
    // -960 and -280 are already integers so Math.round is a no-op.
    expect(first!.pos).toEqual({ x: -960, y: -280 });
  });

  it('MaterialOutput root node has NO pos', () => {
    const { graph } = parseUET3D(fixture, exportMeta);
    const root = graph.nodes.find(n => n.type === 'MaterialOutput');
    expect(root).toBeDefined();
    expect(root!.pos).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Helpers — build minimal ReactFlow Node / Edge objects for applyLayout tests
// ---------------------------------------------------------------------------

function rfNode(id: string, nodeType?: string): Node {
  return { id, type: nodeType, position: { x: 0, y: 0 }, data: {} };
}
function rfEdge(source: string, target: string): Edge {
  return { id: `${source}-${target}`, source, target };
}

// ---------------------------------------------------------------------------
// 2. applyLayout hybrid layout
// ---------------------------------------------------------------------------

describe('applyLayout — all stored', () => {
  it('all nodes have stored pos → positions equal storedPos exactly; clusterBounds is {}', () => {
    const nodes = [rfNode('A'), rfNode('B'), rfNode('C')];
    const edges: Edge[] = [rfEdge('A', 'B'), rfEdge('B', 'C')];
    const storedPos = { A: { x: 100, y: 200 }, B: { x: 400, y: 200 }, C: { x: 700, y: 200 } };
    const { nodes: out, clusterBounds } = applyLayout(nodes, edges, undefined, storedPos);
    expect(out.find(n => n.id === 'A')!.position).toEqual({ x: 100, y: 200 });
    expect(out.find(n => n.id === 'B')!.position).toEqual({ x: 400, y: 200 });
    expect(out.find(n => n.id === 'C')!.position).toEqual({ x: 700, y: 200 });
    expect(clusterBounds).toEqual({});
  });
});

describe('applyLayout — no stored pos', () => {
  it('storedPos undefined → dagre positions are finite', () => {
    const nodes = [rfNode('src'), rfNode('dst')];
    const edges: Edge[] = [rfEdge('src', 'dst')];
    const { nodes: out } = applyLayout(nodes, edges, undefined, undefined);
    for (const n of out) {
      expect(Number.isFinite(n.position.x), `${n.id}.x not finite`).toBe(true);
      expect(Number.isFinite(n.position.y), `${n.id}.y not finite`).toBe(true);
    }
  });

  it('empty storedPos ({}) → falls through to dagre; positions are finite', () => {
    const nodes = [rfNode('X'), rfNode('Y')];
    const edges: Edge[] = [rfEdge('X', 'Y')];
    const { nodes: out } = applyLayout(nodes, edges, undefined, {});
    for (const n of out) {
      expect(Number.isFinite(n.position.x)).toBe(true);
    }
  });
});

describe('applyLayout — mixed (some nodes lack stored pos)', () => {
  it('positioned node keeps its stored pos exactly; loose node wired to it is placed to its right', () => {
    // A has stored pos; B is loose but wired to A.
    const nodes = [rfNode('A'), rfNode('B')];
    const edges: Edge[] = [rfEdge('A', 'B')];
    const storedPos = { A: { x: 0, y: 0 } };
    const { nodes: out } = applyLayout(nodes, edges, undefined, storedPos);
    const posA = out.find(n => n.id === 'A')!.position;
    const posB = out.find(n => n.id === 'B')!.position;
    // A stays exactly at its stored position.
    expect(posA).toEqual({ x: 0, y: 0 });
    // B is placed to the right of A (x > A.x + some offset, matching NODE_W + 60).
    expect(posB.x).toBeGreaterThan(posA.x + 200);
    // B's position is finite.
    expect(Number.isFinite(posB.x)).toBe(true);
    expect(Number.isFinite(posB.y)).toBe(true);
  });
});

describe('applyLayout — isolated loose node below negative stored layout', () => {
  it('loose node with no edges is anchored below the real layout even when stored Y is negative', () => {
    // Three stored nodes clustered at very negative Y (~-3000).
    // One loose node has no edges and no stored pos — it must land BELOW the stored cluster.
    const nodes = [rfNode('S1'), rfNode('S2'), rfNode('S3'), rfNode('loose')];
    const edges: Edge[] = [rfEdge('S1', 'S2'), rfEdge('S2', 'S3')];
    const storedPos = {
      S1: { x: 0,   y: -3000 },
      S2: { x: 400, y: -2900 },
      S3: { x: 800, y: -2800 },
    };
    const { nodes: out } = applyLayout(nodes, edges, undefined, storedPos);
    const maxStoredY = Math.max(...[storedPos.S1, storedPos.S2, storedPos.S3].map(p => p.y));
    const looseY = out.find(n => n.id === 'loose')!.position.y;
    // Loose node must be placed strictly below the stored layout, not near y=0.
    expect(looseY).toBeGreaterThan(maxStoredY);
  });
});

describe('applyLayout — fan-out must produce distinct positions', () => {
  it('four loose nodes wired only to one anchor get four distinct positions', () => {
    // One anchor node with stored pos, four loose nodes each connected only to that anchor.
    // Previously i%3 caused indices 0 and 3 to share the same fan offset → collision.
    const nodes = [rfNode('anchor'), rfNode('L0'), rfNode('L1'), rfNode('L2'), rfNode('L3')];
    const edges: Edge[] = [
      rfEdge('anchor', 'L0'),
      rfEdge('anchor', 'L1'),
      rfEdge('anchor', 'L2'),
      rfEdge('anchor', 'L3'),
    ];
    const storedPos = { anchor: { x: 0, y: 0 } };
    const { nodes: out } = applyLayout(nodes, edges, undefined, storedPos);
    const positions = ['L0', 'L1', 'L2', 'L3'].map(id => {
      const p = out.find(n => n.id === id)!.position;
      return `${p.x}:${p.y}`;
    });
    // All four positions must be unique — no two loose nodes may land at the same point.
    const unique = new Set(positions);
    expect(unique.size).toBe(4);
  });
});

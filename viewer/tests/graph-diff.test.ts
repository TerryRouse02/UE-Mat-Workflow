// graph-diff.test.ts — the compare view: computeGraphDiff/buildDiffPayload
// (pure web module) and the stateless GET /api/graph endpoint behind it.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeGraphDiff, buildDiffPayload, connKey } from '../web/src/diff.js';
import type { MatGraph, GraphPayload } from '../web/src/protocol.js';
import { startServer } from '../server/http-server.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const graph = (over: Partial<MatGraph>): MatGraph => ({
  schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'g',
  nodes: [], connections: [], ...over,
});

describe('computeGraphDiff', () => {
  const base = graph({
    nodes: [
      { id: 'OUT', type: 'MaterialOutput', params: {} },
      { id: 'c1', type: 'Constant3Vector', params: { Constant: [1, 0, 0] } },
      { id: 'old', type: 'Constant', params: { R: 0.5 } },
    ],
    connections: [
      { from: 'c1:RGB', to: 'OUT:BaseColor' },
      { from: 'old:R', to: 'OUT:Metallic' },
    ],
    comments: [{ id: 'cm', text: 'note', contains: ['c1'] }],
  });
  const other = graph({
    nodes: [
      { id: 'OUT', type: 'MaterialOutput', params: {} },
      { id: 'c1', type: 'Constant3Vector', params: { Constant: [0, 1, 0] } }, // params changed
      { id: 'rough', type: 'Constant', params: { R: 0.8 } },                  // added
    ],
    connections: [
      { from: 'c1:RGB', to: 'OUT:BaseColor' },              // unchanged
      { from: 'rough:R', to: 'OUT:Roughness' },             // added
    ],
  });

  it('classifies added / removed / changed nodes and connections', () => {
    const d = computeGraphDiff(base, other);
    expect(d.nodeStatus).toEqual({ c1: 'changed', rough: 'added', old: 'removed' });
    expect(d.summary.changed[0]).toEqual({ id: 'c1', what: ['params.Constant'] });
    expect(d.connStatus[connKey({ from: 'rough:R', to: 'OUT:Roughness' })]).toBe('added');
    expect(d.connStatus[connKey({ from: 'old:R', to: 'OUT:Metallic' })]).toBe('removed');
    expect(d.connStatus[connKey({ from: 'c1:RGB', to: 'OUT:BaseColor' })]).toBeUndefined();
    expect(d.summary.connAdded).toBe(1);
    expect(d.summary.connRemoved).toBe(1);
  });

  it('merged graph is the union: B wins shared ids, A-only ghosts ride along, comments dropped', () => {
    const d = computeGraphDiff(base, other);
    expect(d.merged.nodes.map(n => n.id).sort()).toEqual(['OUT', 'c1', 'old', 'rough']);
    // B's version of the changed node is rendered.
    expect(d.merged.nodes.find(n => n.id === 'c1')?.params).toEqual({ Constant: [0, 1, 0] });
    expect(d.merged.connections).toHaveLength(3);
    expect(d.merged.comments).toBeUndefined();
  });

  it('type change is a changed node with a type entry; param order does not matter', () => {
    const a = graph({ nodes: [{ id: 'x', type: 'Add', params: { A: 1, B: 2 } }] });
    const b = graph({ nodes: [{ id: 'x', type: 'Multiply', params: { B: 2, A: 1 } }] });
    const d = computeGraphDiff(a, b);
    expect(d.nodeStatus.x).toBe('changed');
    expect(d.summary.changed[0].what).toEqual(['type: Add → Multiply']);
    // identical params in different key order -> no params entries
    const same = computeGraphDiff(
      graph({ nodes: [{ id: 'y', type: 'Add', params: { A: [1, { k: 2 }], B: 'z' } }] }),
      graph({ nodes: [{ id: 'y', type: 'Add', params: { B: 'z', A: [1, { k: 2 }] } }] }),
    );
    expect(same.nodeStatus.y).toBeUndefined();
  });

  it('buildDiffPayload combines derivedPins with B winning', () => {
    const basePayload: GraphPayload = {
      graph: base, warnings: [],
      derivedPins: { mf1: { inputs: [{ name: 'In', type: 'Float1' }], outputs: [] }, oldMf: { inputs: [], outputs: [] } },
    };
    const otherPayload: GraphPayload = {
      graph: other, warnings: ['x'],
      derivedPins: { mf1: { inputs: [{ name: 'In2', type: 'Float2' }], outputs: [] } },
    };
    const { payload, diff } = buildDiffPayload(basePayload, otherPayload);
    expect(payload.graph).toBe(diff.merged);
    expect(payload.derivedPins.mf1.inputs[0].name).toBe('In2'); // B wins
    expect(payload.derivedPins.oldMf).toBeDefined();            // A fills ghosts
    expect(payload.warnings).toEqual([]);
  });
});

describe('GET /api/graph', () => {
  it('returns a resolved payload; rejects traversal, bad extension, and broken graphs', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'graph-get-'));
    mkdirSync(resolve(root, 'graphs', 'mini'), { recursive: true });
    mkdirSync(resolve(root, 'tools', 'node-t3d-metadata'), { recursive: true });
    writeFileSync(resolve(root, 'graphs', 'mini', 'mini.matgraph.json'), JSON.stringify({
      schemaVersion: '1.0', type: 'Material', name: 'mini', ueVersion: '5.7',
      nodes: [{ id: 'OUT', type: 'MaterialOutput', params: {} }], connections: [],
    }, null, 2));
    writeFileSync(resolve(root, 'graphs', 'mini', 'broken.matgraph.json'), '{not json');
    try {
      symlinkSync(resolve(REPO_ROOT, 'agent-pack'), resolve(root, 'agent-pack'),
        process.platform === 'win32' ? 'junction' : 'dir');
    } catch { /* exists */ }
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const base = `http://localhost:${server.port}`;
    try {
      const r = await fetch(`${base}/api/graph?path=${encodeURIComponent('mini/mini.matgraph.json')}`);
      expect(r.status).toBe(200);
      const data = await r.json() as { path: string; payload: GraphPayload };
      expect(data.path).toBe('mini/mini.matgraph.json');
      expect(data.payload.graph.name).toBe('mini');
      expect(data.payload.graph.nodes).toHaveLength(1);

      expect((await fetch(`${base}/api/graph?path=../../etc/passwd`)).status).toBe(400);
      expect((await fetch(`${base}/api/graph?path=mini/mini.json`)).status).toBe(400);
      expect((await fetch(`${base}/api/graph?path=`)).status).toBe(400);
      expect((await fetch(`${base}/api/graph?path=${encodeURIComponent('mini/broken.matgraph.json')}`)).status).toBe(422);
      expect((await fetch(`${base}/api/graph?path=${encodeURIComponent('nope/none.matgraph.json')}`)).status).toBe(422);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

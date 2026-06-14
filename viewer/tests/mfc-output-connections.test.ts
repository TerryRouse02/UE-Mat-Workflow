import { describe, it, expect, afterEach } from 'vitest';
import { resolve } from 'node:path';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveMfcOutputConnections } from '../server/mf-resolver';
import type { MatGraph } from '../server/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp(): string {
  return mkdtempSync(resolve(tmpdir(), 'mfcout-'));
}

function write(p: string, obj: unknown): void {
  writeFileSync(p, JSON.stringify(obj, null, 2));
}

function mfGraph(outputNodes: { id: string; name: string }[]): unknown {
  return {
    schemaVersion: '1.0',
    ueVersion: '5.7',
    type: 'MaterialFunction',
    name: 'MF_X',
    nodes: outputNodes.map(({ id, name }) => ({
      id,
      type: 'FunctionOutput',
      params: { OutputName: name },
    })),
    connections: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveMfcOutputConnections', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const t of temps) {
      try { rmSync(t, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    temps.length = 0;
  });

  // -------------------------------------------------------------------------
  // 1. Multi-output MF via sibling: three output pins, including spaces
  // -------------------------------------------------------------------------
  it('rewrites positional placeholders to real output names for a multi-output sibling MF', async () => {
    const tmp = makeTmp();
    temps.push(tmp);

    // Sibling MF: <tmp>/MF_X/MF_X.matgraph.json
    mkdirSync(resolve(tmp, 'MF_X'));
    write(resolve(tmp, 'MF_X', 'MF_X.matgraph.json'), mfGraph([
      { id: 'o0', name: 'Light Energy' },
      { id: 'o1', name: 'Step Complexity' },
      { id: 'o2', name: 'Raw Heightmap Value' },
    ]));

    // Material: graphDir = <tmp>/Mat
    mkdirSync(resolve(tmp, 'Mat'));
    const graphDir = resolve(tmp, 'Mat');

    const graph: MatGraph = {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      type: 'Material',
      name: 'Mat',
      nodes: [
        { id: 'MFC', type: 'MaterialFunctionCall', params: { MaterialFunction: '/Game/whatever/MF_X.MF_X' } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [
        { from: 'MFC:Result', to: 'OUT:BaseColor' },
        { from: 'MFC:Out1',   to: 'OUT:Metallic' },
        { from: 'MFC:Out2',   to: 'OUT:Roughness' },
      ],
    };

    const { rewrites, warnings } = await resolveMfcOutputConnections(graph, graphDir, {});

    expect(rewrites).toBe(3);
    expect(warnings).toEqual([]);

    expect(graph.connections[0].from).toBe('MFC:Light Energy');
    expect(graph.connections[1].from).toBe('MFC:Step Complexity');
    expect(graph.connections[2].from).toBe('MFC:Raw Heightmap Value');
  });

  // -------------------------------------------------------------------------
  // 2. Idempotency: second pass on already-rewritten graph → 0 rewrites
  // -------------------------------------------------------------------------
  it('is idempotent — a second pass rewrites nothing', async () => {
    const tmp = makeTmp();
    temps.push(tmp);

    mkdirSync(resolve(tmp, 'MF_X'));
    write(resolve(tmp, 'MF_X', 'MF_X.matgraph.json'), mfGraph([
      { id: 'o0', name: 'Light Energy' },
      { id: 'o1', name: 'Step Complexity' },
      { id: 'o2', name: 'Raw Heightmap Value' },
    ]));

    mkdirSync(resolve(tmp, 'Mat'));
    const graphDir = resolve(tmp, 'Mat');

    const graph: MatGraph = {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      type: 'Material',
      name: 'Mat',
      nodes: [
        { id: 'MFC', type: 'MaterialFunctionCall', params: { MaterialFunction: '/Game/whatever/MF_X.MF_X' } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [
        { from: 'MFC:Result', to: 'OUT:BaseColor' },
        { from: 'MFC:Out1',   to: 'OUT:Metallic' },
        { from: 'MFC:Out2',   to: 'OUT:Roughness' },
      ],
    };

    // First pass — fixes placeholders
    await resolveMfcOutputConnections(graph, graphDir, {});

    // Capture state after first pass
    const afterFirst = graph.connections.map(c => c.from);
    expect(afterFirst).toEqual([
      'MFC:Light Energy',
      'MFC:Step Complexity',
      'MFC:Raw Heightmap Value',
    ]);

    // Second pass — must be a no-op
    const second = await resolveMfcOutputConnections(graph, graphDir, {});
    expect(second.rewrites).toBe(0);
    expect(graph.connections.map(c => c.from)).toEqual(afterFirst);
  });

  // -------------------------------------------------------------------------
  // 3. Single-output MF whose output name IS "Result" → no rewrite needed
  // -------------------------------------------------------------------------
  it('leaves "Result" pin untouched when the MF single output is named "Result"', async () => {
    const tmp = makeTmp();
    temps.push(tmp);

    mkdirSync(resolve(tmp, 'MF_Single'));
    write(resolve(tmp, 'MF_Single', 'MF_Single.matgraph.json'), mfGraph([
      { id: 'o0', name: 'Result' },
    ]));

    mkdirSync(resolve(tmp, 'Mat'));
    const graphDir = resolve(tmp, 'Mat');

    const graph: MatGraph = {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      type: 'Material',
      name: 'Mat',
      nodes: [
        { id: 'MFC', type: 'MaterialFunctionCall', params: { MaterialFunction: '/Game/whatever/MF_Single.MF_Single' } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [
        { from: 'MFC:Result', to: 'OUT:BaseColor' },
      ],
    };

    const { rewrites } = await resolveMfcOutputConnections(graph, graphDir, {});

    expect(rewrites).toBe(0);
    expect(graph.connections[0].from).toBe('MFC:Result');
  });

  // -------------------------------------------------------------------------
  // 4. Unresolvable MF (no sibling, no index) → connection left as-is, warning returned
  // -------------------------------------------------------------------------
  it('leaves connection unchanged and returns a warning when the MF cannot be resolved', async () => {
    const tmp = makeTmp();
    temps.push(tmp);

    mkdirSync(resolve(tmp, 'Mat'));
    const graphDir = resolve(tmp, 'Mat');
    // No sibling MF_Ghost directory exists; no index provided.

    const graph: MatGraph = {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      type: 'Material',
      name: 'Mat',
      nodes: [
        { id: 'MFC', type: 'MaterialFunctionCall', params: { MaterialFunction: '/Game/whatever/MF_Ghost.MF_Ghost' } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [
        { from: 'MFC:Out1', to: 'OUT:Metallic' },
      ],
    };

    const { rewrites, warnings } = await resolveMfcOutputConnections(graph, graphDir, {});

    expect(rewrites).toBe(0);
    expect(graph.connections[0].from).toBe('MFC:Out1');
    expect(warnings.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 5. Non-MFC source connections are never altered
  // -------------------------------------------------------------------------

  // =========================================================================
  // Regression tests: positional placeholder vs. real output-name collision
  // =========================================================================

  // -------------------------------------------------------------------------
  // R1. Placeholder string appears at a DIFFERENT index than its position encodes
  //   MF outputs: ["Light Energy", "Result"]
  //   "Result" placeholder → index 0 → "Light Energy"  (NOT skipped as "already real")
  //   "Out1"   placeholder → index 1 → "Result"
  // -------------------------------------------------------------------------
  it('rewrites "Result" placeholder even when MF has an output literally named "Result" at a different index', async () => {
    const tmp = makeTmp();
    temps.push(tmp);

    // Sibling MF: outputs in order ["Light Energy", "Result"]
    mkdirSync(resolve(tmp, 'MF_R1'));
    write(resolve(tmp, 'MF_R1', 'MF_R1.matgraph.json'), mfGraph([
      { id: 'o0', name: 'Light Energy' },
      { id: 'o1', name: 'Result' },
    ]));

    mkdirSync(resolve(tmp, 'Mat'));
    const graphDir = resolve(tmp, 'Mat');

    const graph: MatGraph = {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      type: 'Material',
      name: 'Mat',
      nodes: [
        { id: 'MFC', type: 'MaterialFunctionCall', params: { MaterialFunction: '/Game/whatever/MF_R1.MF_R1' } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [
        { from: 'MFC:Result', to: 'OUT:BaseColor' },   // index-0 placeholder → "Light Energy"
        { from: 'MFC:Out1',   to: 'OUT:Metallic' },    // index-1 placeholder → "Result"
      ],
    };

    const { rewrites, warnings } = await resolveMfcOutputConnections(graph, graphDir, {});

    expect(warnings).toEqual([]);
    expect(rewrites).toBe(2);
    expect(graph.connections[0].from).toBe('MFC:Light Energy');
    expect(graph.connections[1].from).toBe('MFC:Result');
  });

  // -------------------------------------------------------------------------
  // R2. "Out<N>" collides with a real output name at a different index
  //   MF outputs: ["Out1", "Foo"]
  //   "Out1" placeholder → index 1 → "Foo"  (NOT skipped because "Out1" appears in the set)
  // -------------------------------------------------------------------------
  it('rewrites "Out1" placeholder to the real index-1 name even when "Out1" is a real output at index 0', async () => {
    const tmp = makeTmp();
    temps.push(tmp);

    // Sibling MF: outputs in order ["Out1", "Foo"]
    mkdirSync(resolve(tmp, 'MF_R2'));
    write(resolve(tmp, 'MF_R2', 'MF_R2.matgraph.json'), mfGraph([
      { id: 'o0', name: 'Out1' },
      { id: 'o1', name: 'Foo' },
    ]));

    mkdirSync(resolve(tmp, 'Mat'));
    const graphDir = resolve(tmp, 'Mat');

    const graph: MatGraph = {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      type: 'Material',
      name: 'Mat',
      nodes: [
        { id: 'MFC', type: 'MaterialFunctionCall', params: { MaterialFunction: '/Game/whatever/MF_R2.MF_R2' } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [
        { from: 'MFC:Out1', to: 'OUT:BaseColor' },   // index-1 placeholder → "Foo"
      ],
    };

    const { rewrites, warnings } = await resolveMfcOutputConnections(graph, graphDir, {});

    expect(warnings).toEqual([]);
    expect(rewrites).toBe(1);
    expect(graph.connections[0].from).toBe('MFC:Foo');
  });

  // -------------------------------------------------------------------------
  // R3. Out-of-range placeholder — single output MF, connection uses "Out5"
  //   index 5 is out of range → connection left unchanged, no crash, rewrites=0
  // -------------------------------------------------------------------------
  it('leaves an out-of-range Out<N> placeholder unchanged and does not crash', async () => {
    const tmp = makeTmp();
    temps.push(tmp);

    // Sibling MF: single output ["Only"]
    mkdirSync(resolve(tmp, 'MF_R3'));
    write(resolve(tmp, 'MF_R3', 'MF_R3.matgraph.json'), mfGraph([
      { id: 'o0', name: 'Only' },
    ]));

    mkdirSync(resolve(tmp, 'Mat'));
    const graphDir = resolve(tmp, 'Mat');

    const graph: MatGraph = {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      type: 'Material',
      name: 'Mat',
      nodes: [
        { id: 'MFC', type: 'MaterialFunctionCall', params: { MaterialFunction: '/Game/whatever/MF_R3.MF_R3' } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [
        { from: 'MFC:Out5', to: 'OUT:BaseColor' },   // index 5, out of range for 1-output MF
      ],
    };

    const { rewrites } = await resolveMfcOutputConnections(graph, graphDir, {});

    expect(rewrites).toBe(0);
    expect(graph.connections[0].from).toBe('MFC:Out5');
  });

  it('does not alter connections from non-MFC nodes', async () => {
    const tmp = makeTmp();
    temps.push(tmp);

    mkdirSync(resolve(tmp, 'Mat'));
    const graphDir = resolve(tmp, 'Mat');

    const graph: MatGraph = {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      type: 'Material',
      name: 'Mat',
      nodes: [
        { id: 'Multiply_1', type: 'Multiply' },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [
        { from: 'Multiply_1:Result', to: 'OUT:BaseColor' },
      ],
    };

    const { rewrites } = await resolveMfcOutputConnections(graph, graphDir, {});

    expect(rewrites).toBe(0);
    expect(graph.connections[0].from).toBe('Multiply_1:Result');
  });
});

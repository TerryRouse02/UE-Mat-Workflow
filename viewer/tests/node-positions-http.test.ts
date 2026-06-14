// Tests for POST /api/files op:'layout' — persists node positions to disk.
// Mirrors the pattern in files-param.test.ts.

import { describe, it, expect } from 'vitest';
import { startServer } from '../server/http-server';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

function post(port: number, body: unknown): Promise<{ status: number; json: any }> {
  return fetch(`http://localhost:${port}/api/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
}

const REL = 'm/mat.matgraph.json';

function seed(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'layout-'));
  mkdirSync(resolve(root, 'graphs/m'), { recursive: true });
  writeFileSync(
    resolve(root, 'graphs', REL),
    JSON.stringify({
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'mat',
      nodes: [
        { id: 'A', type: 'Multiply' },
        { id: 'B', type: 'Add' },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [{ from: 'A:Result', to: 'OUT:BaseColor' }],
    }, null, 2) + '\n',
  );
  return root;
}

describe("POST /api/files op 'layout'", () => {
  it('writes pos to each node in positions map, returns {ok:true, applied:N}', async () => {
    const root = seed();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const r = await post(server.port, {
      op: 'layout', path: REL,
      positions: { A: { x: 100, y: 200 }, B: { x: 400, y: 200 } },
    });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.applied).toBe(2);
    const onDisk = JSON.parse(readFileSync(resolve(root, 'graphs', REL), 'utf-8'));
    expect(onDisk.nodes.find((n: any) => n.id === 'A').pos).toEqual({ x: 100, y: 200 });
    expect(onDisk.nodes.find((n: any) => n.id === 'B').pos).toEqual({ x: 400, y: 200 });
    // MaterialOutput node not in positions map → no pos added.
    expect(onDisk.nodes.find((n: any) => n.id === 'OUT').pos).toBeUndefined();
    await server.close();
  }, 5000);

  it('positions missing → 400', async () => {
    const root = seed();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const r = await post(server.port, { op: 'layout', path: REL });
    expect(r.status).toBe(400);
    await server.close();
  }, 5000);

  it('positions as array → 400', async () => {
    const root = seed();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const r = await post(server.port, { op: 'layout', path: REL, positions: [{ x: 0, y: 0 }] });
    expect(r.status).toBe(400);
    await server.close();
  }, 5000);
});

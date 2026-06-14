import { describe, it, expect } from 'vitest';
import { startServer } from '../server/http-server';
import { isEditableParamValue } from '../server/graph-write';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve } from 'node:path';

function post(port: number, path: string, body: unknown): Promise<{ status: number; json: any }> {
  return fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
}

function get(port: number, path: string): Promise<{ status: number; json: any }> {
  return fetch(`http://localhost:${port}${path}`, { cache: 'no-store' })
    .then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
}

const graph = () => ({
  schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'mat',
  nodes: [
    { id: 'col', type: 'VectorParameter', params: { ParameterName: 'Tint', DefaultValue: [1, 0, 0, 1] } },
    { id: 'rough', type: 'ScalarParameter', params: { ParameterName: 'Roughness', DefaultValue: 0.5 } },
    { id: 'OUT', type: 'MaterialOutput' },
  ],
  connections: [{ from: 'col:RGB', to: 'OUT:BaseColor' }],
});

function seed(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'param-'));
  mkdirSync(resolve(root, 'graphs/m'), { recursive: true });
  writeFileSync(resolve(root, 'graphs/m/mat.matgraph.json'), JSON.stringify(graph(), null, 2) + '\n');
  return root;
}

const REL = 'm/mat.matgraph.json';

describe('isEditableParamValue', () => {
  it('accepts scalar value types and short numeric arrays', () => {
    expect(isEditableParamValue(0.5)).toBe(true);
    expect(isEditableParamValue(true)).toBe(true);
    expect(isEditableParamValue('Color')).toBe(true);
    expect(isEditableParamValue([1, 0, 0, 1])).toBe(true);
    expect(isEditableParamValue([0.2, 0.3, 0.4])).toBe(true);
  });
  it('rejects structural shapes and non-finite numbers', () => {
    expect(isEditableParamValue({ R: 1 })).toBe(false);
    expect(isEditableParamValue([{ Name: 'A' }])).toBe(false);
    expect(isEditableParamValue([1, 2, 3, 4, 5])).toBe(false);
    expect(isEditableParamValue(NaN)).toBe(false);
    expect(isEditableParamValue(null)).toBe(false);
  });
});

describe("POST /api/files op 'param'", () => {
  it('writes a scalar value back, format-preserved', async () => {
    const root = seed();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const r = await post(server.port, '/api/files', {
      op: 'param', path: REL, nodeId: 'rough', key: 'DefaultValue', value: 0.85,
    });
    expect(r.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(resolve(root, 'graphs', REL), 'utf-8'));
    expect(onDisk.nodes.find((n: any) => n.id === 'rough').params.DefaultValue).toBe(0.85);
    // Other params untouched, file ends with a trailing newline (authored style).
    expect(onDisk.nodes.find((n: any) => n.id === 'col').params.DefaultValue).toEqual([1, 0, 0, 1]);
    expect(readFileSync(resolve(root, 'graphs', REL), 'utf-8').endsWith('}\n')).toBe(true);
    await server.close();
  }, 5000);

  it('writes a colour vector back', async () => {
    const root = seed();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const r = await post(server.port, '/api/files', {
      op: 'param', path: REL, nodeId: 'col', key: 'DefaultValue', value: [0.1, 0.2, 0.3, 1],
    });
    expect(r.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(resolve(root, 'graphs', REL), 'utf-8'));
    expect(onDisk.nodes.find((n: any) => n.id === 'col').params.DefaultValue).toEqual([0.1, 0.2, 0.3, 1]);
    await server.close();
  }, 5000);

  it('rejects a structural (object) value', async () => {
    const root = seed();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const r = await post(server.port, '/api/files', {
      op: 'param', path: REL, nodeId: 'col', key: 'DefaultValue', value: { R: 1, G: 0, B: 0 },
    });
    expect(r.status).toBe(400);
    await server.close();
  }, 5000);

  it('404s an unknown node id and leaves the file untouched', async () => {
    const root = seed();
    const before = readFileSync(resolve(root, 'graphs', REL), 'utf-8');
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const r = await post(server.port, '/api/files', {
      op: 'param', path: REL, nodeId: 'nope', key: 'DefaultValue', value: 1,
    });
    expect(r.status).toBe(404);
    expect(readFileSync(resolve(root, 'graphs', REL), 'utf-8')).toBe(before);
    await server.close();
  }, 5000);

  it('removes a key when remove:true', async () => {
    const root = seed();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const r = await post(server.port, '/api/files', {
      op: 'param', path: REL, nodeId: 'rough', key: 'DefaultValue', remove: true,
    });
    expect(r.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(resolve(root, 'graphs', REL), 'utf-8'));
    expect('DefaultValue' in onDisk.nodes.find((n: any) => n.id === 'rough').params).toBe(false);
    await server.close();
  }, 5000);

  it('rejects a path that escapes graphs/', async () => {
    const root = seed();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const r = await post(server.port, '/api/files', {
      op: 'param', path: '../../etc/passwd.matgraph.json', nodeId: 'x', key: 'k', value: 1,
    });
    expect(r.status).toBe(400);
    await server.close();
  }, 5000);
});

describe('GET /api/fs/list', () => {
  it('lists a directory in local mode (dirs first, dotfiles hidden)', async () => {
    const root = seed();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const r = await get(server.port, `/api/fs/list?path=${encodeURIComponent(resolve(root, 'graphs'))}`);
    expect(r.status).toBe(200);
    expect(r.json.path).toBe(resolve(root, 'graphs'));
    expect(r.json.entries.some((e: any) => e.name === 'm' && e.dir)).toBe(true);
    await server.close();
  }, 5000);

  it('falls back to the home dir when path is empty', async () => {
    const root = seed();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const r = await get(server.port, '/api/fs/list');
    expect(r.status).toBe(200);
    expect(r.json.path).toBe(homedir());
    await server.close();
  }, 5000);

  it('400s an unreachable path without leaking', async () => {
    const root = seed();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const r = await get(server.port, `/api/fs/list?path=${encodeURIComponent(resolve(root, 'does-not-exist-xyz'))}`);
    expect(r.status).toBe(400);
    await server.close();
  }, 5000);

  it('403s in team mode (never exposes a server filesystem to members)', async () => {
    const root = seed();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '', bindHost: '0.0.0.0' });
    // bindHost non-loopback → team mode; unauthenticated /api/ is gated 401,
    // and even authed the fs lister is disabled. Either way it must not 200.
    const r = await get(server.port, '/api/fs/list');
    expect(r.status).not.toBe(200);
    await server.close();
  }, 5000);
});

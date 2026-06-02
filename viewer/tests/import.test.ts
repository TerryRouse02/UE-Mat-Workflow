import { describe, it, expect } from 'vitest';
import { startServer, slugifyGraphName } from '../server/http-server';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

function post(port: number, body: unknown): Promise<{ status: number; json: any }> {
  return fetch(`http://localhost:${port}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
}

const sampleGraph = (name = 'x') => ({
  schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name,
  nodes: [{ id: 'OUT', type: 'MaterialOutput' }], connections: [],
});

describe('slugifyGraphName', () => {
  it('keeps safe names, falls back to "imported" on empty', () => {
    expect(slugifyGraphName('my_material')).toBe('my_material');
    expect(slugifyGraphName('  ')).toBe('imported');
    expect(slugifyGraphName(undefined)).toBe('imported');
  });
  it('strips separators and traversal so the result cannot escape graphs/', () => {
    expect(slugifyGraphName('../../etc/passwd')).toBe('etc_passwd');
    expect(slugifyGraphName('a/b\\c')).toBe('a_b_c');
    expect(slugifyGraphName('weird name!! v2')).toBe('weird_name_v2');
  });
});

describe('POST /api/import', () => {
  it('writes a new project folder and returns its relative path', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'imp-'));
    mkdirSync(resolve(root, 'graphs'), { recursive: true });
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });

    const { status, json } = await post(server.port, { name: 'water', graph: sampleGraph() });
    expect(status).toBe(200);
    expect(json.path).toBe('water/water.matgraph.json');
    expect(json.name).toBe('water');

    const written = JSON.parse(readFileSync(resolve(root, 'graphs/water/water.matgraph.json'), 'utf-8'));
    // The graph's own name is realigned to the (deduped) folder name.
    expect(written.name).toBe('water');
    expect(written.type).toBe('Material');

    await server.close();
  }, 5000);

  it('auto-suffixes the folder on collision instead of overwriting', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'imp-'));
    mkdirSync(resolve(root, 'graphs/water'), { recursive: true });
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });

    const r1 = await post(server.port, { name: 'water', graph: sampleGraph() });
    expect(r1.json.name).toBe('water-2');
    const r2 = await post(server.port, { name: 'water', graph: sampleGraph() });
    expect(r2.json.name).toBe('water-3');

    expect(existsSync(resolve(root, 'graphs/water-2/water-2.matgraph.json'))).toBe(true);
    expect(existsSync(resolve(root, 'graphs/water-3/water-3.matgraph.json'))).toBe(true);

    await server.close();
  }, 5000);

  it('rejects an invalid graph with 400 and writes nothing', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'imp-'));
    mkdirSync(resolve(root, 'graphs'), { recursive: true });
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });

    const { status } = await post(server.port, { name: 'bad', graph: { type: 'Nope' } });
    expect(status).toBe(400);
    expect(existsSync(resolve(root, 'graphs/bad'))).toBe(false);

    await server.close();
  }, 5000);

  it('a malicious name cannot escape graphs/ (slug strips traversal)', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'imp-'));
    mkdirSync(resolve(root, 'graphs'), { recursive: true });
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });

    const { status, json } = await post(server.port, { name: '../../pwned', graph: sampleGraph() });
    expect(status).toBe(200);
    // Stayed inside graphs/ as a sanitized folder name.
    expect(json.path).toBe('pwned/pwned.matgraph.json');
    expect(existsSync(resolve(root, 'pwned'))).toBe(false);
    expect(existsSync(resolve(root, 'graphs/pwned/pwned.matgraph.json'))).toBe(true);

    await server.close();
  }, 5000);
});

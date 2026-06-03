import { describe, it, expect } from 'vitest';
import { startServer } from '../server/http-server';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';

interface Res { status: number; body: string }
function request(port: number, method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> {
  return new Promise((res, rej) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...opts.headers } }, (r) => {
      let buf = '';
      r.on('data', (d) => { buf += d.toString(); });
      r.on('end', () => res({ status: r.statusCode ?? 0, body: buf }));
    });
    req.on('error', rej);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// A fixture repo with graphs/ + an agent-pack data file so the runtime-serve
// endpoint has something to return.
function fixtureRepo(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'crawlapi-'));
  mkdirSync(resolve(root, 'graphs'), { recursive: true });
  mkdirSync(resolve(root, 'agent-pack'), { recursive: true });
  mkdirSync(resolve(root, 'tools', 'node-t3d-metadata'), { recursive: true });
  writeFileSync(resolve(root, 'agent-pack', 'nodes-ue5.7.json'), JSON.stringify({ ueVersion: '5.7', nodes: { Add: {} } }));
  return root;
}

describe('crawl API', () => {
  it('GET /api/env returns a probe with checks', async () => {
    const server = await startServer({ repoRoot: fixtureRepo(), port: 0, webDist: '' });
    const r = await request(server.port, 'GET', '/api/env');
    expect(r.status).toBe(200);
    const env = JSON.parse(r.body);
    expect(typeof env.ready).toBe('boolean');
    expect(env.checks.platform).toBeDefined();
    expect(env.checks.config).toBeDefined();
    await server.close();
  }, 5000);

  it('GET /api/agent-pack serves an allowlisted file and 404s anything else', async () => {
    const server = await startServer({ repoRoot: fixtureRepo(), port: 0, webDist: '' });
    const ok = await request(server.port, 'GET', '/api/agent-pack/nodes-ue5.7.json');
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).ueVersion).toBe('5.7');

    const evil = await request(server.port, 'GET', '/api/agent-pack/secret.json');
    expect(evil.status).toBe(404);
    await server.close();
  }, 5000);

  it('POST /api/crawl refuses a cross-origin request', async () => {
    const server = await startServer({ repoRoot: fixtureRepo(), port: 0, webDist: '' });
    const r = await request(server.port, 'POST', '/api/crawl', { headers: { origin: 'http://evil.example:1234' }, body: JSON.stringify({ kind: 'export' }) });
    expect(r.status).toBe(403);
    await server.close();
  }, 5000);

  it('POST /api/crawl rejects an unknown crawl kind', async () => {
    const server = await startServer({ repoRoot: fixtureRepo(), port: 0, webDist: '' });
    const r = await request(server.port, 'POST', '/api/crawl', { headers: { origin: `http://127.0.0.1:${server.port}` }, body: JSON.stringify({ kind: 'bogus' }) });
    expect(r.status).toBe(400);
    await server.close();
  }, 5000);

  it('POST /api/crawl accepts a same-origin valid kind and returns a jobId', async () => {
    // The spawn itself fails fast off-Windows (no powershell); the endpoint still
    // returns a jobId synchronously — that contract is what we assert here.
    const server = await startServer({ repoRoot: fixtureRepo(), port: 0, webDist: '' });
    const r = await request(server.port, 'POST', '/api/crawl', { headers: { origin: `http://127.0.0.1:${server.port}` }, body: JSON.stringify({ kind: 'enginemf' }) });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).jobId).toMatch(/^crawl-/);
    await server.close();
  }, 5000);
});

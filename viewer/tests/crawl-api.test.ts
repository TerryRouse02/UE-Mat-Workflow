import { describe, it, expect } from 'vitest';
import { startServer } from '../server/http-server';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';

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

  it('GET /api/workmf returns the local work-MF index when present', async () => {
    const root = fixtureRepo();
    const idx = {
      schemaVersion: '1.0', kind: 'workmf-index', ueVersion: '5.7',
      functions: {
        '/Game/Functions/MF_X.MF_X': {
          assetPath: '/Game/Functions/MF_X.MF_X', displayName: 'MF_X', category: '/Game/Functions',
          inputs: [{ name: 'In', type: 'Float3', index: 0 }],
          outputs: [{ name: 'Result', type: 'Float3', index: 0 }],
        },
      },
    };
    writeFileSync(resolve(root, 'agent-pack', 'workmf-index.json'), JSON.stringify(idx));
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const r = await request(server.port, 'GET', '/api/workmf');
    expect(r.status).toBe(200);
    const got = JSON.parse(r.body);
    expect(got.kind).toBe('workmf-index');
    expect(got.functions['/Game/Functions/MF_X.MF_X'].displayName).toBe('MF_X');
    await server.close();
  }, 5000);

  it('GET /api/workmf serves null when no index is present (absent is not an error)', async () => {
    const server = await startServer({ repoRoot: fixtureRepo(), port: 0, webDist: '' });
    const r = await request(server.port, 'GET', '/api/workmf');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toBe(null);
    await server.close();
  }, 5000);

  it('POST /api/config writes local.config.json and returns the fresh probe', async () => {
    const root = fixtureRepo();
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const origin = `http://127.0.0.1:${server.port}`;
    const r = await request(server.port, 'POST', '/api/config', {
      headers: { origin },
      body: JSON.stringify({ ProjectPath: 'C:\\Proj\\Game.uproject', EngineRoot: 'C:\\UE_5.7' }),
    });
    expect(r.status).toBe(200);
    expect(typeof JSON.parse(r.body).ready).toBe('boolean'); // a probe came back
    const written = JSON.parse(readFileSync(resolve(root, 'tools', 'node-t3d-metadata', 'local.config.json'), 'utf-8'));
    expect(written.ProjectPath).toBe('C:\\Proj\\Game.uproject');
    expect(written.EngineRoot).toBe('C:\\UE_5.7');
    await server.close();
  }, 5000);

  it('POST /api/config preserves existing fields it was not sent (merge)', async () => {
    const root = fixtureRepo();
    writeFileSync(resolve(root, 'tools', 'node-t3d-metadata', 'local.config.json'),
      JSON.stringify({ ProjectPath: 'C:\\Old.uproject', EngineRoot: 'C:\\UE', WorkMfContentRoots: '/Game/Materials' }));
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const origin = `http://127.0.0.1:${server.port}`;
    await request(server.port, 'POST', '/api/config', { headers: { origin }, body: JSON.stringify({ EngineRoot: 'C:\\UE_5.7' }) });
    const written = JSON.parse(readFileSync(resolve(root, 'tools', 'node-t3d-metadata', 'local.config.json'), 'utf-8'));
    expect(written.EngineRoot).toBe('C:\\UE_5.7');             // updated
    expect(written.ProjectPath).toBe('C:\\Old.uproject');      // preserved
    expect(written.WorkMfContentRoots).toBe('/Game/Materials'); // preserved
    await server.close();
  }, 5000);

  it('POST /api/config refuses a cross-origin request', async () => {
    const server = await startServer({ repoRoot: fixtureRepo(), port: 0, webDist: '' });
    const r = await request(server.port, 'POST', '/api/config', { headers: { origin: 'http://evil.example:1234' }, body: JSON.stringify({ ProjectPath: 'x' }) });
    expect(r.status).toBe(403);
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

  it('POST /api/crawl accepts the workmf kind (not rejected as unknown)', async () => {
    const server = await startServer({ repoRoot: fixtureRepo(), port: 0, webDist: '' });
    const r = await request(server.port, 'POST', '/api/crawl', { headers: { origin: `http://127.0.0.1:${server.port}` }, body: JSON.stringify({ kind: 'workmf' }) });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).jobId).toMatch(/^crawl-/);
    await server.close();
  }, 5000);

  it('POST /api/crawl accepts a valid contentRoots but rejects a malformed one', async () => {
    const server = await startServer({ repoRoot: fixtureRepo(), port: 0, webDist: '' });
    const origin = `http://127.0.0.1:${server.port}`;
    const ok = await request(server.port, 'POST', '/api/crawl', { headers: { origin }, body: JSON.stringify({ kind: 'workmf', contentRoots: '/Game/Materials,/MyPlugin' }) });
    expect(ok.status).toBe(200);
    // A value that could be mistaken for a PowerShell flag must be refused, not spawned.
    const evil = await request(server.port, 'POST', '/api/crawl', { headers: { origin }, body: JSON.stringify({ kind: 'workmf', contentRoots: '-Command rm -rf' }) });
    expect(evil.status).toBe(400);
    await server.close();
  }, 5000);

  it('WS: a cross-origin upgrade is closed, never served the file list', async () => {
    const server = await startServer({ repoRoot: fixtureRepo(), port: 0, webDist: '' });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: 'http://evil.example' });
    const outcome = await new Promise<string>((res) => {
      ws.on('message', () => res('message'));   // a 'hello' would mean we leaked
      ws.on('close', () => res('close'));
      ws.on('error', () => res('close'));
    });
    expect(outcome).toBe('close');
    await server.close();
  }, 5000);

  it('WS: a client connecting after a finished crawl gets the crawl state replayed', async () => {
    const server = await startServer({ repoRoot: fixtureRepo(), port: 0, webDist: '' });
    const origin = `http://127.0.0.1:${server.port}`;
    // ws1 watches the crawl run to completion (spawn fails fast off-Windows -> error).
    const ws1 = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await waitFor(ws1, (m) => m.kind === 'hello');
    // Attach the crawlDone waiter BEFORE the POST — the spawn errors almost
    // immediately, so the broadcast can land before a post-POST listener attaches.
    const ws1Done = waitFor(ws1, (m) => m.kind === 'crawlDone');
    await request(server.port, 'POST', '/api/crawl', { headers: { origin }, body: JSON.stringify({ kind: 'enginemf' }) });
    await ws1Done;
    // ws2 connects AFTER the crawl finished — it must receive the replayed crawlDone
    // (otherwise its UI would be stuck and never refresh).
    const ws2 = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const replayed = await waitFor(ws2, (m) => m.kind === 'crawlDone');
    expect(replayed.status).toBe('error');
    ws1.close(); ws2.close();
    await server.close();
  }, 8000);
});

function waitFor(ws: WebSocket, predicate: (m: { kind: string; status?: string }) => boolean, timeoutMs = 5000): Promise<{ kind: string; status?: string }> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting for ws message')), timeoutMs);
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (predicate(m)) { clearTimeout(t); res(m); } });
    ws.on('error', (e) => { clearTimeout(t); rej(e as Error); });
  });
}

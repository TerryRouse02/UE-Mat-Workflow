import { describe, it, expect } from 'vitest';
import { startServer, toPosixPath } from '../server/http-server';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, basename } from 'node:path';
import { connect } from 'node:net';
import { WebSocket } from 'ws';

// Raw HTTP request so the literal request-target (incl. '../') reaches the
// server unmodified. fetch()/undici normalizes '../' away client-side, which
// would defeat a traversal test.
function rawGet(port: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((res, rej) => {
    const sock = connect(port, 'localhost', () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', d => { buf += d.toString(); });
    sock.on('error', rej);
    sock.on('end', () => {
      const status = Number(buf.split('\r\n')[0].split(' ')[1]);
      const body = buf.split('\r\n\r\n').slice(1).join('\r\n\r\n');
      res({ status, body });
    });
  });
}

describe('toPosixPath', () => {
  // Regression: on Windows path.relative() returns backslashes, which broke
  // sidebar grouping (every file fell into "Unorganized") because the client
  // splits paths on '/'. The wire protocol must always be POSIX-style.
  it('converts Windows backslash separators to POSIX slashes', () => {
    expect(toPosixPath('myProject\\obsidian.matgraph.json')).toBe('myProject/obsidian.matgraph.json');
  });

  it('converts deeply nested Windows paths', () => {
    expect(toPosixPath('proj\\sub\\deep.matgraph.json')).toBe('proj/sub/deep.matgraph.json');
  });

  it('leaves POSIX paths unchanged', () => {
    expect(toPosixPath('myProject/obsidian.matgraph.json')).toBe('myProject/obsidian.matgraph.json');
  });
});

describe('startServer', () => {
  it('serves WS hello with file list on connect', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'srv-'));
    mkdirSync(resolve(root, 'graphs/functions'), { recursive: true });
    writeFileSync(resolve(root, 'graphs/a.matgraph.json'), '{}');
    writeFileSync(resolve(root, 'graphs/functions/b.matgraph.json'), '{}');

    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const url = `ws://localhost:${server.port}`;
    const ws = new WebSocket(url);

    const hello: any = await new Promise((res, rej) => {
      ws.on('message', d => res(JSON.parse(d.toString())));
      ws.on('error', rej);
    });
    expect(hello.kind).toBe('hello');
    expect(hello.files).toEqual([
      { path: 'a.matgraph.json', type: 'Unknown' },
      { path: 'functions/b.matgraph.json', type: 'Unknown' },
    ]);

    ws.close();
    await server.close();
  }, 5000);

  it('reports Material and MaterialFunction types from file content', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'srv-'));
    mkdirSync(resolve(root, 'graphs/mat1'), { recursive: true });
    writeFileSync(resolve(root, 'graphs/mat1/main.matgraph.json'),
      JSON.stringify({ type: 'Material', schemaVersion: '1.0', ueVersion: '5.7', name: 'main', nodes: [], connections: [] }));
    writeFileSync(resolve(root, 'graphs/mat1/helper.matgraph.json'),
      JSON.stringify({ type: 'MaterialFunction', schemaVersion: '1.0', ueVersion: '5.7', name: 'helper', nodes: [], connections: [] }));

    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const ws = new WebSocket(`ws://localhost:${server.port}`);
    const hello: any = await new Promise((res, rej) => {
      ws.on('message', d => res(JSON.parse(d.toString())));
      ws.on('error', rej);
    });

    expect(hello.files).toEqual([
      { path: 'mat1/helper.matgraph.json', type: 'MaterialFunction' },
      { path: 'mat1/main.matgraph.json', type: 'Material' },
    ]);

    ws.close();
    await server.close();
  }, 5000);

  it('resolves a sibling MaterialFunction for a material inside a project folder', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'srv-'));
    mkdirSync(resolve(root, 'graphs/proj'), { recursive: true });
    // MF path is "./fn..." — relative to the MATERIAL's own folder, not graphs root.
    writeFileSync(resolve(root, 'graphs/proj/main.matgraph.json'),
      JSON.stringify({
        schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'main',
        nodes: [
          { id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: './fn.matgraph.json' } },
          { id: 'OUT', type: 'MaterialOutput' },
        ],
        connections: [{ from: 'mfc:R', to: 'OUT:BaseColor' }],
      }));
    writeFileSync(resolve(root, 'graphs/proj/fn.matgraph.json'),
      JSON.stringify({
        schemaVersion: '1.0', ueVersion: '5.7', type: 'MaterialFunction', name: 'fn',
        nodes: [
          { id: 'i', type: 'FunctionInput', params: { InputName: 'A' } },
          { id: 'o', type: 'FunctionOutput', params: { OutputName: 'R' } },
        ],
        connections: [{ from: 'i:Input', to: 'o:Input' }],
      }));

    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const ws = new WebSocket(`ws://localhost:${server.port}`);

    const graphMsg: any = await new Promise((res, rej) => {
      ws.on('error', rej);
      ws.on('message', d => {
        const msg = JSON.parse(d.toString());
        if (msg.kind === 'hello') ws.send(JSON.stringify({ kind: 'open', path: 'proj/main.matgraph.json' }));
        else if (msg.kind === 'graph' || msg.kind === 'graphError') res(msg);
      });
    });

    expect(graphMsg.kind).toBe('graph');
    expect(graphMsg.payload.warnings).toEqual([]);
    expect(graphMsg.payload.derivedPins['mfc']).toEqual({
      inputs: [{ name: 'A', type: 'Float3' }],
      outputs: [{ name: 'R', type: 'Float3' }],
    });

    ws.close();
    await server.close();
  }, 5000);

  it("an 'open' with a traversing '../' path yields graphError (no leaked file)", async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'srv-'));
    mkdirSync(resolve(root, 'graphs'), { recursive: true });
    writeFileSync(resolve(root, 'graphs/ok.matgraph.json'),
      JSON.stringify({ schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'ok', nodes: [], connections: [] }));
    // A secret outside graphsRoot that a traversal would try to reach.
    writeFileSync(resolve(root, 'secret.txt'), 'TOP SECRET');

    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const ws = new WebSocket(`ws://localhost:${server.port}`);

    const msg: any = await new Promise((res, rej) => {
      ws.on('error', rej);
      ws.on('message', d => {
        const m = JSON.parse(d.toString());
        if (m.kind === 'hello') ws.send(JSON.stringify({ kind: 'open', path: '../secret.txt' }));
        else if (m.kind === 'graph' || m.kind === 'graphError') res(m);
      });
    });

    expect(msg.kind).toBe('graphError');
    expect(msg.path).toBe('../secret.txt');
    expect(JSON.stringify(msg)).not.toContain('TOP SECRET');

    ws.close();
    await server.close();
  }, 5000);

  it('404s a traversing static request', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'srv-'));
    const webDist = mkdtempSync(resolve(tmpdir(), 'web-'));
    mkdirSync(resolve(root, 'graphs'), { recursive: true });
    writeFileSync(resolve(webDist, 'index.html'), '<html>ok</html>');
    const secret = resolve(webDist, '..', 'secret.txt');
    writeFileSync(secret, 'TOP SECRET');

    const server = await startServer({ repoRoot: root, port: 0, webDist });
    // '../secret.txt' escapes webDist; the containment guard must 404 it
    // before any read, never serving the out-of-root file contents.
    const { status, body } = await rawGet(server.port, `/../${basename(secret)}`);
    expect(status).toBe(404);
    expect(body).not.toContain('TOP SECRET');

    await server.close();
  }, 5000);
});

import { describe, it, expect } from 'vitest';
import { startServer } from '../server/http-server';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';

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
});

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
    expect(hello.files.sort()).toEqual(['a.matgraph.json', 'functions/b.matgraph.json']);

    ws.close();
    await server.close();
  }, 5000);
});

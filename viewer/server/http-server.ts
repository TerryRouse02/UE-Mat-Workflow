import { createServer, type Server } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, extname, relative } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { watchGraphs } from './watcher.js';
import { loadGraph } from './graph-loader.js';
import { resolveMaterialFunctions } from './mf-resolver.js';
import type { ServerMessage, ClientMessage } from './ws-protocol.js';

export interface ServerOpts {
  repoRoot: string;     // contains graphs/
  port: number;         // 0 = auto
  webDist: string;      // path to built web files (empty for test)
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export async function startServer(opts: ServerOpts): Promise<RunningServer> {
  const graphsRoot = resolve(opts.repoRoot, 'graphs');

  const http: Server = createServer(async (req, res) => {
    if (!opts.webDist) { res.writeHead(404); res.end(); return; }
    try {
      const url = (req.url || '/').split('?')[0];
      const rel = url === '/' ? '/index.html' : url;
      const filePath = join(opts.webDist, rel);
      const data = await readFile(filePath);
      const ext = extname(filePath);
      // Only no-cache the HTML entrypoint so dev iterations see the latest
      // bundle reference; assets are content-hashed and safe to cache.
      const headers: Record<string, string> = {
        'Content-Type': MIME[ext] ?? 'application/octet-stream',
      };
      if (ext === '.html') headers['Cache-Control'] = 'no-store';
      res.writeHead(200, headers);
      res.end(data);
    } catch {
      try {
        const index = await readFile(join(opts.webDist, 'index.html'));
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(index);
      } catch { res.writeHead(404); res.end(); }
    }
  });

  const wss = new WebSocketServer({ server: http });

  const send = (ws: WebSocket, msg: ServerMessage) => ws.send(JSON.stringify(msg));

  async function listFiles(): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && e.name.endsWith('.matgraph.json')) {
          out.push(relative(graphsRoot, full));
        }
      }
    }
    await walk(graphsRoot);
    return out.sort();
  }

  async function sendGraph(ws: WebSocket, relPath: string) {
    const abs = resolve(graphsRoot, relPath);
    const loaded = await loadGraph(abs);
    if (!loaded.graph) {
      send(ws, { kind: 'graphError', path: relPath, errors: loaded.errors });
      return;
    }
    const resolved = await resolveMaterialFunctions(loaded.graph, graphsRoot);
    send(ws, {
      kind: 'graph', path: relPath,
      payload: { graph: resolved.graph, derivedPins: resolved.derivedPins, warnings: resolved.warnings },
    });
  }

  wss.on('connection', async (ws) => {
    const files = await listFiles();
    send(ws, { kind: 'hello', graphsRoot, files });
    ws.on('message', async (raw) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.kind === 'listFiles') {
        send(ws, { kind: 'fileList', files: await listFiles() });
      } else if (msg.kind === 'open') {
        await sendGraph(ws, msg.path);
      }
    });
  });

  const watcher = watchGraphs(graphsRoot, async (paths) => {
    const files = await listFiles();
    for (const ws of wss.clients) {
      send(ws, { kind: 'fileList', files });
      for (const p of paths) {
        const rel = relative(graphsRoot, p);
        await sendGraph(ws, rel);
      }
    }
  }, { debounceMs: 300 });

  await new Promise<void>((res) => http.listen(opts.port, res));
  const addr = http.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;

  return {
    port: actualPort,
    async close() {
      await watcher.close();
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => http.close(() => res()));
    },
  };
}

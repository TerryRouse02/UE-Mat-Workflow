import { createServer, type Server } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, extname, relative, dirname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { watchGraphs } from './watcher.js';
import { loadGraph } from './graph-loader.js';
import { resolveMaterialFunctions } from './mf-resolver.js';
import { loadWorkMfIndex } from './workmf-index.js';
import type { ServerMessage, ClientMessage, FileEntry } from './ws-protocol.js';

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
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// Containment check for user-controlled paths: the resolved candidate must be
// the root itself or live strictly beneath it. Blocks '../' traversal escapes.
export function isInside(root: string, candidate: string): boolean {
  const r = resolve(root);
  const c = resolve(candidate);
  return c === r || c.startsWith(r + sep);
}

// Wire paths are always POSIX-style ('/'). On Windows path.relative() returns
// backslash separators, which the client's path.split('/') logic can't segment:
// every file collapses to one segment and lands under "Unorganized". Normalize
// at this boundary so all path consumers (grouping, base names, breadcrumbs)
// stay platform-neutral.
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

export async function startServer(opts: ServerOpts): Promise<RunningServer> {
  const graphsRoot = resolve(opts.repoRoot, 'graphs');
  const workMfIndexPath = resolve(opts.repoRoot, 'agent-pack', 'workmf-index.json');

  const http: Server = createServer(async (req, res) => {
    if (!opts.webDist) { res.writeHead(404); res.end(); return; }
    try {
      const url = (req.url || '/').split('?')[0];
      const rel = url === '/' ? '/index.html' : url;
      const filePath = join(opts.webDist, rel);
      // Reject path-traversal escapes ('/../../etc/passwd') before any read.
      if (!isInside(opts.webDist, filePath)) { res.writeHead(404); res.end(); return; }
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

  // Any read/parse error → 'Unknown'; user sees it under "Unorganized"
  // and can investigate. Distinct error types are not surfaced.
  async function readGraphType(absPath: string): Promise<FileEntry['type']> {
    try {
      const raw = await readFile(absPath, 'utf-8');
      const parsed = JSON.parse(raw) as { type?: string };
      if (parsed.type === 'Material' || parsed.type === 'MaterialFunction') return parsed.type;
      return 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  async function listFiles(): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    async function walk(dir: string) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && e.name.endsWith('.matgraph.json')) {
          const type = await readGraphType(full);
          out.push({ path: toPosixPath(relative(graphsRoot, full)), type });
        }
      }
    }
    await walk(graphsRoot);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  // Resolve a path ONCE into the message to send. Used both for direct 'open'
  // requests and for broadcast fan-out (so a changed graph is read+resolved
  // once, not once per connected client).
  async function buildGraphMessage(relPath: string): Promise<ServerMessage> {
    const abs = resolve(graphsRoot, relPath);
    // Reject traversal escapes ('../...') instead of leaking files outside graphs/.
    if (!isInside(graphsRoot, abs)) {
      return { kind: 'graphError', path: relPath, errors: ['path escapes graphs root'] };
    }
    const loaded = await loadGraph(abs);
    if (!loaded.graph) {
      return { kind: 'graphError', path: relPath, errors: loaded.errors };
    }
    // Work-project MFs referenced by UE asset path get their pins from the local
    // index (re-read per build so a fresh WorkMF crawl shows up without a restart).
    const { index: workMfIndex, warnings: indexWarnings } = await loadWorkMfIndex(workMfIndexPath);
    // MaterialFunction paths are relative to the material file's own directory
    // (project-folder convention), not the graphs root.
    const resolved = await resolveMaterialFunctions(loaded.graph, dirname(abs), new Set(), { workMfIndex });
    return {
      kind: 'graph', path: relPath,
      payload: { graph: resolved.graph, derivedPins: resolved.derivedPins, warnings: [...indexWarnings, ...resolved.warnings] },
    };
  }

  // Guard each send: a CLOSING/CLOSED socket throws on send, which must not
  // abort the rest of the broadcast batch.
  const safeSend = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState !== ws.OPEN) return;
    try { send(ws, msg); }
    catch (e) { console.error('ws send error:', e); }
  };

  async function sendGraph(ws: WebSocket, relPath: string) {
    safeSend(ws, await buildGraphMessage(relPath));
  }

  wss.on('connection', async (ws) => {
    // Guard the handler body: a thrown error here would otherwise become an
    // unhandledRejection and can crash the process.
    try {
      const files = await listFiles();
      send(ws, { kind: 'hello', graphsRoot, files });
    } catch (e) {
      console.error('connection handler error:', e);
    }
    ws.on('message', async (raw) => {
      try {
        let msg: ClientMessage;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.kind === 'listFiles') {
          send(ws, { kind: 'fileList', files: await listFiles() });
        } else if (msg.kind === 'open') {
          await sendGraph(ws, msg.path);
        }
      } catch (e) {
        console.error('message handler error:', e);
      }
    });
  });

  const watcher = watchGraphs(graphsRoot, async (changed) => {
    // Guard the whole callback: a throw here would become an unhandledRejection.
    try {
      const files = await listFiles();
      const fileListMsg: ServerMessage = { kind: 'fileList', files };
      // Resolve each changed graph ONCE, then fan out. (Removed/unlinked paths
      // are intentionally not re-sent as graphs — the fileList refresh already
      // tells clients they are gone.)
      const graphMsgs: ServerMessage[] = [];
      for (const p of changed) {
        const rel = toPosixPath(relative(graphsRoot, p));
        graphMsgs.push(await buildGraphMessage(rel));
      }
      for (const ws of wss.clients) {
        safeSend(ws, fileListMsg);
        for (const msg of graphMsgs) safeSend(ws, msg);
      }
    } catch (e) {
      console.error('watch broadcast error:', e);
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

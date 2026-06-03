import { createServer, type Server, type IncomingMessage } from 'node:http';
import { readFile, readdir, mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, join, extname, relative, dirname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { watchGraphs } from './watcher.js';
import { loadGraph } from './graph-loader.js';
import { resolveMaterialFunctions } from './mf-resolver.js';
import { loadWorkMfIndex } from './workmf-index.js';
import { probeEnv } from './crawl-env.js';
import { createCrawlRunner, type CrawlEvent } from './crawl-runner.js';
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

// Turn a user-supplied import name into a filesystem-safe slug used as BOTH the
// project folder and the file base name (folder-per-project convention). Every
// char outside [A-Za-z0-9_-] collapses to '_', so no '/', '\' or '.' survives —
// the result therefore cannot escape graphs/ even before the isInside guard.
// Empty/garbage input falls back to 'imported'.
export function slugifyGraphName(raw: unknown): string {
  const s = String(raw ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  return s || 'imported';
}

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

// Pick a project folder name that does not collide with an existing one, by
// appending -2, -3, … (collision policy: never overwrite the user's materials).
async function freeProjectName(graphsRoot: string, slug: string): Promise<string> {
  let name = slug;
  for (let n = 2; await pathExists(join(graphsRoot, name)); n++) name = `${slug}-${n}`;
  return name;
}

// Collect a request body with a hard size cap so a malicious/huge POST cannot
// exhaust memory. Rejects (and destroys the socket) past the cap.
function readBody(req: IncomingMessage, maxBytes = 8_000_000): Promise<string> {
  return new Promise((res, rej) => {
    let data = '';
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); rej(new Error('request body too large')); return; }
      data += c.toString();
    });
    req.on('end', () => res(data));
    req.on('error', rej);
  });
}

const isMatGraph = (g: unknown): g is { type: string; name?: string; nodes: unknown[] } =>
  !!g && typeof g === 'object' &&
  ((g as { type?: unknown }).type === 'Material' || (g as { type?: unknown }).type === 'MaterialFunction') &&
  Array.isArray((g as { nodes?: unknown }).nodes);

export async function startServer(opts: ServerOpts): Promise<RunningServer> {
  const graphsRoot = resolve(opts.repoRoot, 'graphs');
  const agentPackRoot = resolve(opts.repoRoot, 'agent-pack');
  const workMfIndexPath = resolve(agentPackRoot, 'workmf-index.json');
  const engineMfIndexPath = resolve(agentPackRoot, 'enginemf-index-ue5.7.json');
  const runner = createCrawlRunner(opts.repoRoot);

  const sendJson = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  // Persist a reverse-imported graph (parsed client-side from UE T3D) as a new
  // project folder under graphs/. The existing watcher then picks it up and the
  // client navigates to it. This is the ONLY write path the server exposes.
  async function handleImport(req: IncomingMessage, res: import('node:http').ServerResponse) {
    let payload: { name?: unknown; graph?: unknown };
    try { payload = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { error: `bad request body: ${(e as Error).message}` }); return; }

    const graph = payload.graph;
    if (!isMatGraph(graph)) { sendJson(res, 400, { error: 'invalid graph: expected a Material/MaterialFunction with a nodes array' }); return; }

    const slug = slugifyGraphName(payload.name ?? graph.name);
    const finalName = await freeProjectName(graphsRoot, slug);
    // Keep the graph's internal name aligned with its folder/file (convention:
    // folder name = material name = file base name).
    graph.name = finalName;

    const folder = join(graphsRoot, finalName);
    const filePath = join(folder, `${finalName}.matgraph.json`);
    // Defence in depth: the slug already strips separators, but re-assert the
    // write target lives under graphs/ before touching the disk.
    if (!isInside(graphsRoot, filePath)) { sendJson(res, 400, { error: 'resolved path escapes graphs root' }); return; }

    try {
      await mkdir(folder, { recursive: true });
      // UTF-8 without BOM, trailing newline — matches authored files.
      await writeFile(filePath, JSON.stringify(graph, null, 2) + '\n', 'utf-8');
    } catch (e) {
      sendJson(res, 500, { error: `failed to write file: ${(e as Error).message}` }); return;
    }
    sendJson(res, 200, { path: toPosixPath(relative(graphsRoot, filePath)), name: finalName });
  }

  // Serve a committed agent-pack data file so the web can re-fetch it at runtime
  // after a crawl (no rebuild). Allowlist by filename pattern — the exact set the
  // web bundles — so no arbitrary path can be read.
  const AGENT_PACK_RE = /^(nodes-ue[\d.]+(?:\.export)?|enginemf-index-ue[\d.]+)\.json$/;
  async function handleAgentPack(urlPath: string, res: import('node:http').ServerResponse) {
    const file = decodeURIComponent(urlPath.slice('/api/agent-pack/'.length));
    const candidate = resolve(agentPackRoot, file);
    // Allowlist by name AND re-assert containment (defence in depth, matching the
    // import + static paths) so broadening the regex can never enable traversal.
    if (!AGENT_PACK_RE.test(file) || !isInside(agentPackRoot, candidate)) { res.writeHead(404); res.end(); return; }
    try {
      const data = await readFile(candidate);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  }

  // CSRF guard for the process-spawning crawl endpoint: a browser request always
  // carries Origin; reject unless its host matches ours. No-Origin requests (curl,
  // the test client) are not a CSRF vector and are allowed. Combined with the
  // 127.0.0.1 bind below, only same-machine same-origin pages can trigger a crawl.
  function sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  function crawlEventToMsg(e: CrawlEvent): ServerMessage {
    if (e.type === 'started') return { kind: 'crawlStarted', jobId: e.jobId, crawlKind: e.kind };
    if (e.type === 'log') return { kind: 'crawlLog', jobId: e.jobId, line: e.line };
    return { kind: 'crawlDone', jobId: e.jobId, status: e.status, exitCode: e.exitCode };
  }

  async function handleCrawl(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: 'cross-origin crawl requests are refused' }); return; }
    let body: { kind?: unknown };
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { error: `bad request body: ${(e as Error).message}` }); return; }
    const kind = body.kind;
    if (kind !== 'export' && kind !== 'enginemf') { sendJson(res, 400, { error: `unknown crawl kind: ${String(kind)}` }); return; }
    try {
      const jobId = runner.start(kind, (e) => {
        const msg = crawlEventToMsg(e);
        for (const ws of wss.clients) safeSend(ws, msg);
      });
      sendJson(res, 200, { jobId });
    } catch (e) {
      // Already running — single-job lock.
      sendJson(res, 409, { error: (e as Error).message });
    }
  }

  const http: Server = createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (req.method === 'POST' && urlPath === '/api/import') {
      try { await handleImport(req, res); }
      catch (e) { console.error('import handler error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/env') {
      try { sendJson(res, 200, await probeEnv(opts.repoRoot)); }
      catch (e) { console.error('env probe error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'GET' && urlPath.startsWith('/api/agent-pack/')) {
      try { await handleAgentPack(urlPath, res); }
      catch (e) { console.error('agent-pack handler error:', e); if (!res.headersSent) { res.writeHead(500); res.end(); } }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/crawl') {
      try { await handleCrawl(req, res); }
      catch (e) { console.error('crawl handler error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
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
    // Official /Engine MFs resolve from the committed engine-MF index (same shape,
    // shipped in the repo). Re-read per build so a regenerated index shows up live.
    const { index: engineMfIndex, warnings: engineWarnings } = await loadWorkMfIndex(engineMfIndexPath);
    // MaterialFunction paths are relative to the material file's own directory
    // (project-folder convention), not the graphs root.
    const resolved = await resolveMaterialFunctions(loaded.graph, dirname(abs), new Set(), { workMfIndex, engineMfIndex });
    return {
      kind: 'graph', path: relPath,
      payload: { graph: resolved.graph, derivedPins: resolved.derivedPins, warnings: [...indexWarnings, ...engineWarnings, ...resolved.warnings] },
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

  wss.on('connection', async (ws, req) => {
    // Same-origin guard, mirroring POST /api/crawl. A WS upgrade bypasses CORS, so
    // without this any page the user visits could open ws://127.0.0.1 and read the
    // file list + every graph in graphs/. The loopback bind only stops remote hosts.
    if (!sameOrigin(req)) { ws.close(1008, 'cross-origin'); return; }
    // Guard the handler body: a thrown error here would otherwise become an
    // unhandledRejection and can crash the process.
    try {
      const files = await listFiles();
      send(ws, { kind: 'hello', graphsRoot, files });
      // Replay current crawl state: the progress broadcast only reaches clients
      // connected at the time, so a client that connects/reconnects mid- or
      // post-crawl would otherwise be stuck showing 'running' and never refresh.
      const cs = runner.current();
      if (cs.status === 'running' && cs.jobId && cs.kind) {
        send(ws, { kind: 'crawlStarted', jobId: cs.jobId, crawlKind: cs.kind });
      } else if ((cs.status === 'success' || cs.status === 'error') && cs.jobId) {
        send(ws, { kind: 'crawlDone', jobId: cs.jobId, status: cs.status, exitCode: cs.exitCode ?? null });
      }
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

  // Local-first: bind loopback only. The crawl endpoint spawns UnrealEditor-Cmd.exe,
  // so the server must not be reachable from other machines on the network.
  await new Promise<void>((res) => http.listen(opts.port, '127.0.0.1', res));
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

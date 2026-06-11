import { createServer, type Server, type IncomingMessage } from 'node:http';
import { readFile, readdir, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { resolve, join, extname, relative, dirname } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { watchGraphs } from './watcher.js';
import { loadGraph } from './graph-loader.js';
import { materialStructureWarnings } from './schema.js';
import { resolveMaterialFunctions } from './mf-resolver.js';
import { loadWorkMfIndex } from './workmf-index.js';
import { probeEnv } from './crawl-env.js';
import { loadFreshness, recordFreshness } from './crawl-freshness.js';
import { createCrawlRunner, type CrawlEvent, PROJECTMAT_STAGING_REL } from './crawl-runner.js';
import type { CrawlFreshness } from './crawl-types.js';
import type { ServerMessage, ClientMessage, FileEntry } from './ws-protocol.js';
import { isInside, toPosixPath, slugifyGraphName, writeGraph } from './graph-write.js';
export { isInside, toPosixPath, slugifyGraphName } from './graph-write.js';
import { importProjectMaterials, PROJECT_DIR } from './projectmat-importer.js';
import type { ExportMeta } from '../web/src/export/export-meta-types.js';
import { runAgent, createSession, type AgentLoopSession } from './agent/loop.js';
import { createCheckpointStore } from './agent/checkpoint.js';
import { pickProvider } from './agent/provider/index.js';
import { discoverVersions, getNodes } from './agent/query-bridge.js';
import type { AgentSseEvent, AgentChatRequest, AgentUndoResponse, AgentResetResponse, AgentExplainRequest, AgentExplainResponse } from './agent/agent-types.js';
import { explainNode, buildGraphContext, RESERVED_NODE_DESCRIPTIONS } from './agent/explain.js';
import type { LLMConfig, ProviderStatus } from './agent/provider/types.js';

export interface ServerOpts {
  repoRoot: string;     // contains graphs/
  port: number;         // 0 = auto
  webDist: string;      // path to built web files (empty for test)
  /**
   * Optional override for the LLM provider factory — injected by tests so they
   * can substitute a FakeProvider without monkey-patching pickProvider.
   * Default: pickProvider from ./agent/provider/index.js
   */
  providerFactory?: (config: LLMConfig) => import('./agent/provider/types.js').Provider;
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

// isInside / toPosixPath / slugifyGraphName live in ./graph-write so the
// project-materials importer can share them without an import cycle. They are
// imported (for internal use) and re-exported near the top of this file.

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
  // The per-machine crawl config the env probe + PowerShell scripts read. Writable
  // from the Config tab so an artist sets ProjectPath/EngineRoot without hand-editing
  // JSON. Fixed path (no user-controlled segment), and gitignored.
  const localConfigPath = resolve(opts.repoRoot, 'tools', 'node-t3d-metadata', 'local.config.json');
  const runner = createCrawlRunner(opts.repoRoot);

  // ─── Agent state ───────────────────────────────────────────────────────────
  // Single active session (MVP). Null when no chat has been started yet.
  let agentSession: AgentLoopSession | null = null;
  // True while a chat is actively streaming. Guards the 409 single-flight.
  let agentStreaming = false;
  // AbortController for the currently-streaming chat (if any).
  // Referenced inside handleAgentChat (set and cleared); stored here so future
  // M4 /api/agent/reset can call it.
  const agentAbortRef = { current: null as AbortController | null };
  // Checkpoint store for the current session (created alongside the session).
  let agentCheckpoint: ReturnType<typeof createCheckpointStore> | null = null;
  // Provider factory — default pickProvider, overridable for tests.
  const makeProvider = opts.providerFactory ?? pickProvider;

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

    let relPath: string;
    try {
      relPath = await writeGraph(graphsRoot, finalName, finalName, graph);
    } catch (e) {
      sendJson(res, 500, { error: `failed to write file: ${(e as Error).message}` }); return;
    }
    sendJson(res, 200, { path: relPath, name: finalName });
  }

  // Serve a committed agent-pack data file so the web can re-fetch it at runtime
  // after a crawl (no rebuild). Allowlist by filename pattern — the exact set the
  // web bundles — so no arbitrary path can be read.
  const AGENT_PACK_RE = /^(nodes-ue[\d.]+(?:\.export)?|enginemf-index-ue[\d.]+)\.json$/;
  // A single UE content root "/Word(/Word)*" — leading '/', word segments only.
  // One folder by design (studio convention keeps a project's Material Functions in one
  // place). Anchors out anything that could be mistaken for a flag or carry path/shell-
  // escape characters (no comma either, so it can't smuggle a second arg).
  const CONTENT_ROOT_RE = /^\/\w+(\/\w+)*$/;
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

  // Serve the LOCAL work-MF index so the web's Nodes tab can browse the user's own
  // project Material Functions and refresh them after a WorkMF crawl. Deliberately
  // NOT on the public agent-pack allowlist: this is the user's own /Game asset data
  // — server-only, never bundled into the build or the single-file HTML export. The
  // loopback bind plus the browser's same-origin policy (no CORS headers here) keep
  // it off cross-origin pages, exactly like /api/env which also returns local paths.
  // An absent index is not an error — it serializes to `null` (no project MFs yet).
  async function handleWorkMf(res: import('node:http').ServerResponse) {
    const { index } = await loadWorkMfIndex(workMfIndexPath);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(index));
  }

  // Write the per-machine crawl config (ProjectPath / EngineRoot / WorkMfContentRoots)
  // from the Config tab. Same-origin guarded like /api/crawl (this drives a process
  // spawn target) and only ever writes the fixed local.config.json — no user-controlled
  // path segment. Fields are merged into any existing config and lightly sanitized
  // (string, length-capped, no control chars); their validity is reflected back by the
  // probe, not enforced here. Responds with the fresh probe so the checklist updates.
  function cleanConfigField(v: unknown): string | null {
    if (v === undefined || v === null) return null;     // not sent -> leave existing as-is
    if (typeof v !== 'string') throw new Error('config fields must be strings');
    const s = v.trim();
    if (s.length > 4096) throw new Error('config field too long');
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 0x20 || code === 0x7f) throw new Error('config field has control characters');
    }
    return s;
  }
  async function handleConfig(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: 'cross-origin config requests are refused' }); return; }
    let body: {
      ProjectPath?: unknown; EngineRoot?: unknown; WorkMfContentRoots?: unknown;
      Llm?: unknown;
    };
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { error: `bad request body: ${(e as Error).message}` }); return; }

    const fields: Record<string, string> = {};
    try {
      const pp = cleanConfigField(body.ProjectPath); if (pp !== null) fields.ProjectPath = pp;
      const er = cleanConfigField(body.EngineRoot);  if (er !== null) fields.EngineRoot = er;
      const cr = cleanConfigField(body.WorkMfContentRoots);
      if (cr !== null) {
        if (cr !== '' && !CONTENT_ROOT_RE.test(cr.replace(/\s+/g, ''))) {
          throw new Error('invalid WorkMfContentRoots — use a single UE content path like "/Game"');
        }
        fields.WorkMfContentRoots = cr;
      }
    } catch (e) { sendJson(res, 400, { error: (e as Error).message }); return; }

    // Merge into any existing config so a field the UI didn't send is preserved.
    let existing: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(await readFile(localConfigPath, 'utf-8'));
      if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>;
    } catch { /* absent or unparseable — start fresh */ }
    const merged: Record<string, unknown> = { ...existing, ...fields };

    // ── Llm extension ──────────────────────────────────────────────────────────
    // Merge the optional Llm object into local.config.json.
    // Rules:
    //  - provider: must be 'anthropic' or 'openai-compatible'
    //  - baseUrl/model: sanitized strings (cleanConfigField)
    //  - apiKey: sanitized string; an explicit empty string clears the stored key;
    //            an absent/undefined apiKey leaves the previously-saved key intact.
    //            This means the Config UI can save provider/model without sending
    //            apiKey and the saved key is preserved.
    //  - maxTokens: coerced to a safe positive integer; dropped if invalid.
    //  - The HTTP response shape is EnvStatus (probeEnv) — Llm fields are NEVER echoed.
    if (body.Llm !== undefined && body.Llm !== null && typeof body.Llm === 'object') {
      const llmIn = body.Llm as Record<string, unknown>;
      let llmConfig: Record<string, unknown> = {};
      try {
        // Load any previously-saved Llm config to preserve untouched fields.
        const prevLlm = existing.Llm;
        if (prevLlm && typeof prevLlm === 'object') llmConfig = { ...(prevLlm as Record<string, unknown>) };

        // provider — required, validated enum
        if (llmIn.provider !== undefined) {
          if (llmIn.provider !== 'anthropic' && llmIn.provider !== 'openai-compatible') {
            throw new Error('Llm.provider must be "anthropic" or "openai-compatible"');
          }
          llmConfig.provider = llmIn.provider;
        }

        // baseUrl
        if (llmIn.baseUrl !== undefined) {
          const v = cleanConfigField(llmIn.baseUrl);
          if (v !== null) llmConfig.baseUrl = v; else delete llmConfig.baseUrl;
        }

        // model
        if (llmIn.model !== undefined) {
          const v = cleanConfigField(llmIn.model);
          if (v !== null) llmConfig.model = v;
        }

        // apiKey: explicit empty string clears; absent leaves existing intact.
        if ('apiKey' in llmIn) {
          if (llmIn.apiKey === '' || llmIn.apiKey === null) {
            delete llmConfig.apiKey;
          } else {
            const v = cleanConfigField(llmIn.apiKey);
            if (v !== null) llmConfig.apiKey = v;
          }
        }

        // maxTokens: coerce to positive integer or drop
        if (llmIn.maxTokens !== undefined) {
          const n = Number(llmIn.maxTokens);
          if (Number.isFinite(n) && n > 0) {
            llmConfig.maxTokens = Math.min(Math.floor(n), 2_000_000);
          } else {
            delete llmConfig.maxTokens;
          }
        }

        merged.Llm = llmConfig;
      } catch (e) { sendJson(res, 400, { error: (e as Error).message }); return; }
    }

    try {
      await mkdir(dirname(localConfigPath), { recursive: true });
      await writeFile(localConfigPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
    } catch (e) { sendJson(res, 500, { error: `failed to write config: ${(e as Error).message}` }); return; }

    // Response is always EnvStatus — Llm fields are never echoed back.
    sendJson(res, 200, await probeEnv(opts.repoRoot));
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

  // Post-crawl hook for 'projectmat': convert the staged T3D dumps the commandlet
  // wrote into openable graphs under graphs/_project/ via the shared converter.
  async function importStagedProjectMaterials(jobId: string) {
    const log = (line: string) => {
      const m = crawlEventToMsg({ type: 'log', jobId, line });
      for (const ws of wss.clients) safeSend(ws, m);
    };
    try {
      const exportMeta = JSON.parse(
        await readFile(resolve(opts.repoRoot, 'agent-pack', 'nodes-ue5.7.export.json'), 'utf-8'),
      ) as ExportMeta;
      const stagingDir = resolve(opts.repoRoot, PROJECTMAT_STAGING_REL);
      const { imported, warnings } = await importProjectMaterials({ stagingDir, graphsRoot, exportMeta });
      log(`project materials: imported ${imported.length}${imported.length ? ` (${imported.join(', ')})` : ''}`);
      for (const w of warnings) log(`  warning: ${w}`);
    } catch (e) {
      log(`project-materials import failed: ${(e as Error).message}`);
    }
  }

  async function handleCrawl(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: 'cross-origin crawl requests are refused' }); return; }
    let body: { kind?: unknown; contentRoots?: unknown };
    try { body = JSON.parse(await readBody(req)); }
    catch (e) { sendJson(res, 400, { error: `bad request body: ${(e as Error).message}` }); return; }
    const kind = body.kind;
    if (kind !== 'export' && kind !== 'enginemf' && kind !== 'workmf' && kind !== 'projectmat') { sendJson(res, 400, { error: `unknown crawl kind: ${String(kind)}` }); return; }
    // contentRoots (workmf only) becomes a literal arg to the spawned editor. Constrain it
    // to a single UE content root — leading '/', word segments — so it can never start with
    // '-' (PowerShell param injection) or carry shell/path-escape chars (no comma → no second arg).
    let contentRoots: string | undefined;
    if (body.contentRoots !== undefined) {
      const cr = String(body.contentRoots).replace(/\s+/g, '');
      if (!CONTENT_ROOT_RE.test(cr)) { sendJson(res, 400, { error: 'invalid contentRoots — use a single UE content path like "/Game"' }); return; }
      contentRoots = cr;
    }
    try {
      const jobId = runner.start(kind, (e) => {
        const msg = crawlEventToMsg(e);
        for (const ws of wss.clients) safeSend(ws, msg);
        // After a successful project-materials crawl, convert the staged T3D dumps
        // into openable graphs under graphs/_project/. The chokidar watcher then
        // refreshes the file list; import results append as trailing crawl-log lines.
        if (kind === 'projectmat' && e.type === 'done' && e.status === 'success') {
          void importStagedProjectMaterials(e.jobId);
        }
        // Record freshness timestamp after any successful crawl.
        if (e.type === 'done' && e.status === 'success') {
          void recordFreshness(opts.repoRoot, kind as keyof CrawlFreshness, new Date().toISOString());
        }
      }, contentRoots ? { contentRoots } : undefined);
      sendJson(res, 200, { jobId });
    } catch (e) {
      // Already running — single-job lock.
      sendJson(res, 409, { error: (e as Error).message });
    }
  }

  // ─── Agent handlers ───────────────────────────────────────────────────────

  /** Read LLMConfig from local.config.json on each request (config changes apply without restart). */
  async function readLlmConfig(): Promise<LLMConfig | null> {
    try {
      const raw = JSON.parse(await readFile(localConfigPath, 'utf-8')) as Record<string, unknown>;
      const llm = raw.Llm as Partial<LLMConfig> | undefined;
      if (!llm || typeof llm !== 'object') return null;
      if (llm.provider !== 'anthropic' && llm.provider !== 'openai-compatible') return null;
      if (typeof llm.model !== 'string' || !llm.model.trim()) return null;
      return {
        provider: llm.provider,
        baseUrl: typeof llm.baseUrl === 'string' ? llm.baseUrl : undefined,
        apiKey: typeof llm.apiKey === 'string' ? llm.apiKey : undefined,
        model: llm.model.trim(),
        maxTokens: typeof llm.maxTokens === 'number' && llm.maxTokens > 0 ? Math.floor(llm.maxTokens) : undefined,
      };
    } catch {
      return null;
    }
  }

  /** GET /api/agent/status — returns ProviderStatus (never contains apiKey). */
  async function handleAgentStatus(res: import('node:http').ServerResponse) {
    const config = await readLlmConfig();
    const status: ProviderStatus = config
      ? { configured: true, provider: config.provider, model: config.model }
      : { configured: false };
    sendJson(res, 200, status);
  }

  /** POST /api/agent/undo — restore the previous checkpoint turn. */
  async function handleAgentUndo(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }

    // 409 if an agent is actively streaming — cannot undo while writing.
    if (agentStreaming) {
      sendJson(res, 409, { error: '對話進行中，無法還原。請等待完成後再試。' });
      return;
    }

    // No session or empty checkpoint → {ok:false, reason:'nothing-to-undo'}.
    if (!agentCheckpoint) {
      const body: AgentUndoResponse = { ok: false, reason: 'nothing-to-undo' };
      sendJson(res, 200, body);
      return;
    }

    const restored = await agentCheckpoint.undoLastTurn(resolve(opts.repoRoot, 'graphs'));

    if (restored === null) {
      const body: AgentUndoResponse = { ok: false, reason: 'nothing-to-undo' };
      sendJson(res, 200, body);
      return;
    }

    // Filter out SKIPPED entries, convert abs paths to graphsRoot-relative.
    const relPaths = restored
      .filter(p => !p.startsWith('!SKIPPED:'))
      .map(p => relative(resolve(opts.repoRoot, 'graphs'), p));

    const body: AgentUndoResponse = { ok: true, restored: relPaths };
    sendJson(res, 200, body);
  }

  /** POST /api/agent/reset — abort any in-flight chat and clear the session. */
  async function handleAgentReset(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }

    // Abort any in-flight streaming chat.
    agentAbortRef.current?.abort();
    agentAbortRef.current = null;
    // Clear the streaming flag immediately so the next POST /api/agent/chat on
    // this server instance does not receive a spurious 409.  The flag is also
    // cleared in handleAgentChat's finally block, but that fires only after the
    // aborted generator fully unwinds — which is asynchronous and can take
    // several seconds with a real LLM provider.
    agentStreaming = false;

    // Remove the old checkpoint directory from disk (stale pre-images are dead weight).
    if (agentCheckpoint) {
      try {
        await rm(agentCheckpoint.sessionDir, { recursive: true, force: true });
      } catch {
        // Non-fatal — directory may already be gone.
      }
    }

    // Clear session and checkpoint.
    agentSession = null;
    agentCheckpoint = null;

    const body: AgentResetResponse = { ok: true };
    sendJson(res, 200, body);
  }

  /** POST /api/agent/explain — one-shot LLM node explanation (JSON, not SSE). */
  async function handleAgentExplain(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }

    let body: AgentExplainRequest;
    try { body = JSON.parse(await readBody(req)) as AgentExplainRequest; }
    catch (e) { sendJson(res, 400, { error: `bad request body: ${(e as Error).message}` }); return; }

    // Validate nodeType.
    if (!body.nodeType || typeof body.nodeType !== 'string' || !body.nodeType.trim()) {
      sendJson(res, 200, { ok: false, error: '必須提供 nodeType。' } satisfies AgentExplainResponse);
      return;
    }
    const nodeType = body.nodeType.trim();

    // Read LLM config fresh.
    const llmConfig = await readLlmConfig();
    if (!llmConfig) {
      sendJson(res, 200, {
        ok: false,
        error: '尚未設定 LLM 提供商。請前往 Config 分頁的「AI 助手」區塊填寫 Provider、Model 和 API Key。',
      } satisfies AgentExplainResponse);
      return;
    }

    // Resolve ueVersion: use body.ueVersion or discover the newest available.
    const versions = discoverVersions(opts.repoRoot);
    const defaultVersion = versions.length > 0 ? versions[versions.length - 1] : '5.7';
    const ueVersion = (body.ueVersion ?? defaultVersion).trim() || defaultVersion;

    // Look up DB entry for the node type.
    // Reserved types are handled with a built-in description (not in the DB).
    let dbEntry: unknown;
    let isReserved = false;
    if (nodeType in RESERVED_NODE_DESCRIPTIONS) {
      isReserved = true;
      dbEntry = { description: RESERVED_NODE_DESCRIPTIONS[nodeType] };
    } else {
      const result = getNodes(opts.repoRoot, ueVersion, [nodeType]);
      const entry = result.result[nodeType];
      if (!entry) {
        // Unknown node type — return a zh-TW error (not a 500).
        sendJson(res, 200, {
          ok: false,
          error: `查無此節點型別「${nodeType}」，請確認節點名稱是否正確（版本：UE ${ueVersion}）。`,
        } satisfies AgentExplainResponse);
        return;
      }
      dbEntry = entry;
    }
    void isReserved; // reserved flag drives the built-in desc path above; no further use needed

    // Build optional graph context (degrade silently on any failure).
    let graphContext: string | undefined;
    if (body.graphPath && body.nodeId) {
      graphContext = await buildGraphContext(
        resolve(opts.repoRoot, 'graphs'),
        body.graphPath,
        body.nodeId,
      );
    }

    // Build provider.
    let provider: import('./agent/provider/types.js').Provider;
    try {
      provider = makeProvider(llmConfig);
    } catch (e) {
      sendJson(res, 200, {
        ok: false,
        error: `無法建立 LLM 提供商：${(e as Error).message}`,
      } satisfies AgentExplainResponse);
      return;
    }

    // AbortController tied to client disconnect.
    const ac = new AbortController();
    req.on('close', () => ac.abort());

    try {
      const text = await explainNode(
        provider,
        llmConfig.model,
        { nodeType, ueVersion, dbEntry, graphContext },
        llmConfig.maxTokens,
        ac.signal,
      );
      sendJson(res, 200, { ok: true, text } satisfies AgentExplainResponse);
    } catch (e) {
      const msg = (e as Error)?.message ?? 'unknown error';
      sendJson(res, 200, { ok: false, error: `解說時發生錯誤：${msg}` } satisfies AgentExplainResponse);
    }
  }

  /** POST /api/agent/chat — SSE stream of AgentSseEvents. */
  async function handleAgentChat(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }

    // Single-flight: reject concurrent chats.
    // IMPORTANT: set the flag here, synchronously, before any await — otherwise a
    // second request can arrive during readBody/readLlmConfig and pass the guard (TOCTOU).
    if (agentStreaming) {
      sendJson(res, 409, { error: '目前已有對話進行中，請等待完成或停止後再試。' });
      return;
    }
    agentStreaming = true;

    let body: AgentChatRequest;
    try { body = JSON.parse(await readBody(req)) as AgentChatRequest; }
    catch (e) {
      agentStreaming = false;
      sendJson(res, 400, { error: `bad request body: ${(e as Error).message}` });
      return;
    }

    // Read LLM config fresh on each request.
    const llmConfig = await readLlmConfig();
    if (!llmConfig) {
      agentStreaming = false;
      // Return SSE error event with zh-TW guidance.
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const errEvent: AgentSseEvent = {
        type: 'error',
        message: '尚未設定 LLM 提供商。請前往 Config 分頁的「AI 助手」區塊填寫 Provider、Model 和 API Key。',
      };
      res.write(`data: ${JSON.stringify(errEvent)}\n\n`);
      const doneEvent: AgentSseEvent = { type: 'done' };
      res.write(`data: ${JSON.stringify(doneEvent)}\n\n`);
      res.end();
      return;
    }

    // Create or reuse session.
    if (!agentSession) {
      const versions = discoverVersions(opts.repoRoot);
      const defaultVersion = versions.length > 0 ? versions[versions.length - 1] : '5.7';
      const ueVersion = body.ueVersion ?? defaultVersion;
      const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      agentSession = createSession(sessionId, ueVersion, body.graphPath ?? undefined);
      agentCheckpoint = createCheckpointStore(resolve(opts.repoRoot, 'viewer'), sessionId);
    }

    const session = agentSession;
    const checkpointStore = agentCheckpoint!;

    // Build provider.
    let provider: import('./agent/provider/types.js').Provider;
    try {
      provider = makeProvider(llmConfig);
    } catch (e) {
      agentStreaming = false;
      sendJson(res, 500, { error: `failed to build provider: ${(e as Error).message}` });
      return;
    }

    // SSE response headers.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const ac = new AbortController();
    agentAbortRef.current = ac;

    // Abort when client disconnects.
    req.on('close', () => { ac.abort(); });

    const graphsRoot = resolve(opts.repoRoot, 'graphs');
    const agentPackRoot = resolve(opts.repoRoot, 'agent-pack');

    // Degradation §3.4: a model that rejects tool definitions surfaces either
    // as a thrown 4xx (catch below) or as an error StreamEvent the adapter
    // yields without throwing — rewriting at the emit boundary covers both.
    const TOOL_HINT = '建議使用支援工具的模型，例如 claude-opus-4-8、gpt-4o 或 deepseek-chat。';
    const withToolHint = (msg: string): string =>
      /4\d\d/.test(msg) && /tool/i.test(msg) && !msg.includes(TOOL_HINT)
        ? `模型不支援工具呼叫（${msg}）。${TOOL_HINT}`
        : msg;

    const emit = (event: AgentSseEvent) => {
      if (res.writableEnded) return;
      const out = event.type === 'error' ? { ...event, message: withToolHint(event.message) } : event;
      res.write(`data: ${JSON.stringify(out)}\n\n`);
    };

    const ctx = {
      repoRoot: opts.repoRoot,
      graphsRoot,
      ueVersion: session.ueVersion,
      workMfIndexPath: resolve(agentPackRoot, 'workmf-index.json'),
      beforeWrite: async (absPath: string, turnId: string) => {
        await checkpointStore.snapshotFile(turnId, absPath);
      },
    };

    try {
      await runAgent(
        body.text,
        session,
        provider,
        llmConfig.model,
        ctx,
        emit,
        ac.signal,
        { maxTokens: llmConfig.maxTokens },
      );
    } catch (e) {
      const msg = (e as Error)?.message ?? 'unknown error';
      // Tool-rejection messages get the model-switch hint via emit; everything
      // else gets the generic prefix.
      const toolRejected = /4\d\d/.test(msg) && /tool/i.test(msg);
      emit({ type: 'error', message: toolRejected ? msg : `對話發生錯誤：${msg}` });
      emit({ type: 'done' });
    } finally {
      // Ownership check: a reset may abort this run and hand the lock to a
      // NEWER chat while this generator is still unwinding (the abort only
      // takes effect at the next event boundary). Clearing the shared flags
      // unconditionally here would break the newer run's single-flight lock
      // and null out its abort controller — only the run that still owns the
      // abort ref may clear them.
      if (agentAbortRef.current === ac) {
        agentStreaming = false;
        agentAbortRef.current = null;
      }
      if (!res.writableEnded) res.end();
    }
  }

  // Track all open HTTP sockets so we can destroy them during forced shutdown.
  // Without this, http.close() only stops accepting new connections but waits
  // for existing keep-alive connections to drain — which can take up to 300 s on
  // some Node versions, hanging every test that calls server.close().
  const openSockets = new Set<import('node:net').Socket>();
  const http: Server = createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (req.method === 'POST' && urlPath === '/api/import') {
      try { await handleImport(req, res); }
      catch (e) { console.error('import handler error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/env') {
      try {
        const [env, freshness] = await Promise.all([probeEnv(opts.repoRoot), loadFreshness(opts.repoRoot)]);
        sendJson(res, 200, { ...env, freshness });
      }
      catch (e) { console.error('env probe error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'GET' && urlPath.startsWith('/api/agent-pack/')) {
      try { await handleAgentPack(urlPath, res); }
      catch (e) { console.error('agent-pack handler error:', e); if (!res.headersSent) { res.writeHead(500); res.end(); } }
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/workmf') {
      try { await handleWorkMf(res); }
      catch (e) { console.error('workmf handler error:', e); if (!res.headersSent) { res.writeHead(500); res.end(); } }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/config') {
      try { await handleConfig(req, res); }
      catch (e) { console.error('config handler error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/crawl') {
      try { await handleCrawl(req, res); }
      catch (e) { console.error('crawl handler error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/crawl/cancel') {
      if (!sameOrigin(req)) { sendJson(res, 403, { error: 'cross-origin cancel requests are refused' }); return; }
      const ok = runner.cancel();
      sendJson(res, ok ? 200 : 409, ok ? { cancelled: true } : { error: 'no crawl running' });
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/agent/explain') {
      try { await handleAgentExplain(req, res); }
      catch (e) { console.error('agent explain handler error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/agent/chat') {
      try { await handleAgentChat(req, res); }
      catch (e) { console.error('agent chat handler error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'GET' && urlPath === '/api/agent/status') {
      try { await handleAgentStatus(res); }
      catch (e) { console.error('agent status handler error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/agent/undo') {
      try { await handleAgentUndo(req, res); }
      catch (e) { console.error('agent undo handler error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/agent/reset') {
      try { await handleAgentReset(req, res); }
      catch (e) { console.error('agent reset handler error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
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

  // Any read/parse error → type 'Unknown', nodeCount undefined; user sees it
  // under "Unorganized" and can investigate. Distinct error types are not surfaced.
  async function readGraphMeta(absPath: string): Promise<{ type: FileEntry['type']; nodeCount: number | undefined }> {
    try {
      const raw = await readFile(absPath, 'utf-8');
      const parsed = JSON.parse(raw) as { type?: string; nodes?: unknown };
      const type: FileEntry['type'] =
        parsed.type === 'Material' || parsed.type === 'MaterialFunction' ? parsed.type : 'Unknown';
      const nodeCount = Array.isArray(parsed.nodes) ? parsed.nodes.length : undefined;
      return { type, nodeCount };
    } catch {
      return { type: 'Unknown', nodeCount: undefined };
    }
  }

  // Per-file health for the file-list status dots: the SAME load + MF-resolve +
  // warning set as opening the file, so an unopened file's dot matches what you'd
  // see after opening it. The resolution context (indexes + freshness) is loaded
  // ONCE per listFiles call and reused across every file, not re-loaded per file.
  type ResolveCtx = {
    workMfIndex: Awaited<ReturnType<typeof loadWorkMfIndex>>['index'];
    indexWarnings: string[];
    engineMfIndex: Awaited<ReturnType<typeof loadWorkMfIndex>>['index'];
    engineWarnings: string[];
    freshness: Awaited<ReturnType<typeof loadFreshness>>;
  };
  async function computeHealth(abs: string, ctx: ResolveCtx): Promise<FileEntry['health']> {
    const loaded = await loadGraph(abs);
    if (!loaded.graph) return 'error';
    const resolved = await resolveMaterialFunctions(
      loaded.graph, dirname(abs), new Set(),
      { workMfIndex: ctx.workMfIndex, engineMfIndex: ctx.engineMfIndex, freshnessMap: ctx.freshness },
    );
    const warnings = [
      ...materialStructureWarnings(loaded.graph),
      ...ctx.indexWarnings, ...ctx.engineWarnings, ...resolved.warnings,
    ];
    return warnings.length ? 'warn' : 'ok';
  }

  async function listFiles(): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    // Load the resolution context once for the whole scan (mirrors buildGraphMessage).
    const { index: workMfIndex, warnings: indexWarnings } = await loadWorkMfIndex(workMfIndexPath);
    const { index: engineMfIndex, warnings: engineWarnings } = await loadWorkMfIndex(engineMfIndexPath);
    const freshness = await loadFreshness(opts.repoRoot);
    const ctx: ResolveCtx = { workMfIndex, indexWarnings, engineMfIndex, engineWarnings, freshness };
    async function walk(dir: string) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && e.name.endsWith('.matgraph.json')) {
          const { type, nodeCount } = await readGraphMeta(full);
          const posixPath = toPosixPath(relative(graphsRoot, full));
          const origin: FileEntry['origin'] = posixPath.startsWith(PROJECT_DIR + '/') ? 'crawled' : 'agent';
          const entry: FileEntry = { path: posixPath, type, origin };
          if (nodeCount !== undefined) entry.nodeCount = nodeCount;
          entry.health = await computeHealth(full, ctx);
          out.push(entry);
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
    const freshness = await loadFreshness(opts.repoRoot);
    const resolved = await resolveMaterialFunctions(loaded.graph, dirname(abs), new Set(), { workMfIndex, engineMfIndex, freshnessMap: freshness });

    // Second pass: tag non-MFC nodes that are not already in nodeProvenance as 'export'.
    // These are the export-authored node types (MaterialOutput, FunctionInput, etc.)
    // that come from the exported graph data rather than any crawl index.
    for (const n of resolved.graph.nodes) {
      if (n.type !== 'MaterialFunctionCall' && !(n.id in resolved.nodeProvenance)) {
        resolved.nodeProvenance[n.id] = { source: 'export', freshnessTs: freshness.export ?? null };
      }
    }

    return {
      kind: 'graph', path: relPath,
      payload: {
        graph: resolved.graph, derivedPins: resolved.derivedPins,
        warnings: [...materialStructureWarnings(loaded.graph), ...indexWarnings, ...engineWarnings, ...resolved.warnings],
        nodeProvenance: resolved.nodeProvenance,
      },
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

  // Track every new TCP socket so force-close can destroy keep-alive connections.
  http.on('connection', (sock) => {
    openSockets.add(sock);
    sock.once('close', () => openSockets.delete(sock));
  });

  // Local-first: bind loopback only. The crawl endpoint spawns UnrealEditor-Cmd.exe,
  // so the server must not be reachable from other machines on the network.
  await new Promise<void>((res) => http.listen(opts.port, '127.0.0.1', res));
  const addr = http.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;

  return {
    port: actualPort,
    async close() {
      await watcher.close();
      // Cancel any running crawl child process so it does not outlive the server.
      runner.cancel();
      // Terminate all WebSocket clients immediately (ws.terminate() sends no
      // close frame and does not wait for the peer to ack — wss.close() blocks
      // until every client disconnects, so ungraceful teardown is necessary here).
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((res) => wss.close(() => res()));
      // Destroy all tracked HTTP sockets. keep-alive connections are never closed
      // by http.close() on its own — they block the callback for up to 300 s.
      for (const sock of openSockets) sock.destroy();
      openSockets.clear();
      await new Promise<void>((res) => http.close(() => res()));
    },
  };
}

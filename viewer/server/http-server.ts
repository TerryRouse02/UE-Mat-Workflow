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
import { runAgent, createSession, estimateMessagesTokens, VIEW_CONTEXT_PREFIX, type AgentLoopSession } from './agent/loop.js';
import { createCheckpointStore } from './agent/checkpoint.js';
import { pickProvider } from './agent/provider/index.js';
import { discoverVersions, getNodes } from './agent/query-bridge.js';
import type { AgentSseEvent, AgentChatRequest, AgentUndoResponse, AgentResetResponse, AgentRegenerateResponse, AgentTestResponse, AgentWebTestResponse, AgentExplainRequest, AgentExplainResponse, AgentTranscriptEntry, AgentSessionDetail, AgentSessionsListResponse, AgentSessionCreateResponse, AgentDbEditRequest, AgentDbEditResponse, AgentPublicSessionResponse } from './agent/agent-types.js';
import { webSearch, type WebSearchConfig } from './agent/web-tools.js';
import { applyDbEdit } from './agent/db-edit.js';
import { createSessionStore, appendTranscript, SESSION_ID_RE } from './agent/session-store.js';
import { createMemoryStore } from './agent/memory-store.js';
import { explainNode, buildGraphContext, RESERVED_NODE_DESCRIPTIONS } from './agent/explain.js';
import type { LLMConfig, ProviderStatus } from './agent/provider/types.js';
import {
  resolveMode, createAuthStore, createLoginLimiter, validateCredentials,
  USERNAME_RE, TOKEN_TTL_MS,
  type ServerMode, type AuthUser, type Role,
} from './auth.js';

export interface ServerOpts {
  repoRoot: string;     // contains graphs/
  port: number;         // 0 = auto
  webDist: string;      // path to built web files (empty for test)
  /**
   * Host to bind. Default 127.0.0.1 (local mode, no auth — unchanged classic
   * behavior). A non-loopback host (e.g. 0.0.0.0) switches the server into
   * TEAM mode: username/password auth, 7-day tokens, admin/user roles.
   */
  bindHost?: string;
  /** Test override: force team mode while still binding loopback. */
  mode?: ServerMode;
  /** Add `Secure` to auth cookies (set when serving behind an HTTPS proxy). */
  secureCookies?: boolean;
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

  // ─── Mode + auth (team collaboration) ───────────────────────────────────────
  // Local mode (loopback bind) constructs NO auth store and skips every gate —
  // classic single-user behavior is untouched. Team mode (non-loopback bind)
  // requires a valid token cookie (or Bearer header) on every /api route and
  // the WebSocket upgrade, with the dangerous surface admin-only.
  const mode: ServerMode = opts.mode ?? resolveMode(opts.bindHost);
  const teamMode = mode === 'team';
  const authStore = teamMode ? createAuthStore(resolve(opts.repoRoot, 'viewer')) : null;
  const loginLimiter = createLoginLimiter();
  const COOKIE_NAME = 'uemw_token';

  /** Token from `Authorization: Bearer` (scripts) or the auth cookie (browser+WS). */
  function readAuthToken(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim();
    const cookie = req.headers.cookie;
    if (!cookie) return null;
    for (const part of cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim();
    }
    return null;
  }

  async function authenticate(req: IncomingMessage): Promise<AuthUser | null> {
    if (!authStore) return null;
    const token = readAuthToken(req);
    return token ? authStore.validateToken(token) : null;
  }

  /** Set (raw != null) or clear (raw == null) the HttpOnly auth cookie. */
  function setAuthCookie(res: import('node:http').ServerResponse, raw: string | null): void {
    const maxAge = raw ? Math.floor(TOKEN_TTL_MS / 1000) : 0;
    let cookie = `${COOKIE_NAME}=${raw ?? ''}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
    if (opts.secureCookies) cookie += '; Secure';
    res.setHeader('Set-Cookie', cookie);
  }

  // Admin-only surface in team mode: anything that changes server state,
  // spawns processes, spends LLM budget, or manages users. Regular members
  // keep the read/collaborate surface (graphs, WS, import/export, node
  // explain) — the agent itself is admin-only by design (one announcement
  // session is the team-visible window, added with the public-session API).
  function isAdminOnly(urlPath: string): boolean {
    if (urlPath === '/api/config' || urlPath === '/api/crawl' || urlPath === '/api/crawl/cancel') return true;
    if (urlPath === '/api/auth/users' || urlPath.startsWith('/api/auth/users/')) return true;
    if (urlPath.startsWith('/api/agent/')) {
      return urlPath !== '/api/agent/status' && urlPath !== '/api/agent/explain'
        && urlPath !== '/api/agent/public-session';
    }
    return false;
  }

  /** Tell every WS client where the announcement channel points + whether it is mid-turn. */
  function broadcastPublicAgent(id: string | null, streaming: boolean): void {
    const msg: ServerMessage = { kind: 'publicAgent', id, streaming };
    for (const ws of wss.clients) safeSend(ws, msg);
  }

  // ─── Agent state (M7: persistent multi-session) ────────────────────────────
  // Sessions persist under viewer/.agent-sessions/ and are resumed on demand.
  // The runtime cache pairs the loop session with its checkpoint store and the
  // replayable transcript. Chat stays single-flight ACROSS sessions.
  const sessionStore = createSessionStore(resolve(opts.repoRoot, 'viewer'));
  interface ActiveSession {
    loop: AgentLoopSession;
    checkpoint: ReturnType<typeof createCheckpointStore>;
    memory: ReturnType<typeof createMemoryStore>;
    transcript: AgentTranscriptEntry[];
    title: string;
    createdAt: string;
    /**
     * Abs paths of graphs this conversation CREATED — write_graph may rewrite
     * these freely; other existing files need an explicit overwrite:true.
     * In-memory only (like the checkpoint turn stack): a server restart
     * conservatively forgets them, so old files regain overwrite protection.
     */
    createdPaths: Set<string>;
  }
  const activeSessions = new Map<string, ActiveSession>();
  // The session an id-less chat/undo/reset request applies to. The web UI
  // always sends explicit session ids; this pointer keeps the legacy flow
  // (and the M3/M4 tests) working.
  let currentSessionId: string | null = null;
  // True while a chat is actively streaming. Guards the 409 single-flight.
  let agentStreaming = false;
  // AbortController for the currently-streaming chat (if any).
  const agentAbortRef = { current: null as AbortController | null };
  // Resolves when the most recent chat run has FULLY unwound (its finally ran,
  // session persisted). The streaming lock is released the moment the client
  // disconnects (stop button) so a re-send never 409s, but the aborted
  // generator can take seconds to unwind — the next chat/undo/regenerate
  // awaits this so two runs never mutate the same session concurrently.
  let chatUnwind: Promise<void> = Promise.resolve();
  // Single-flight for history-mutating endpoints (undo / regenerate): the
  // entry check alone left every await window open to a concurrent second
  // mutation of the same session history.
  let agentMutating = false;
  // Provider factory — default pickProvider, overridable for tests.
  const makeProvider = opts.providerFactory ?? pickProvider;

  function newAgentSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function defaultUeVersion(): string {
    const versions = discoverVersions(opts.repoRoot);
    return versions.length > 0 ? versions[versions.length - 1] : '5.7';
  }

  function createActiveSession(id: string, ueVersion: string, graphPath?: string): ActiveSession {
    const active: ActiveSession = {
      loop: createSession(id, ueVersion, graphPath),
      checkpoint: createCheckpointStore(resolve(opts.repoRoot, 'viewer'), id),
      memory: createMemoryStore(resolve(opts.repoRoot, 'viewer'), id),
      transcript: [],
      title: '',
      createdAt: new Date().toISOString(),
      createdPaths: new Set<string>(),
    };
    activeSessions.set(id, active);
    return active;
  }

  /** Runtime cache first, then disk. Returns null for unknown/invalid ids. */
  async function resumeSession(id: string): Promise<ActiveSession | null> {
    const cached = activeSessions.get(id);
    if (cached) return cached;
    const persisted = await sessionStore.load(id);
    if (!persisted) return null;
    const loop = createSession(persisted.id, persisted.ueVersion);
    loop.messages = persisted.messages;
    loop.totalTokens = persisted.totalTokens;
    // Context size is derived state — re-estimate from the restored history
    // (the next provider round overwrites it with real usage numbers).
    loop.contextTokens = estimateMessagesTokens(loop.messages);
    loop.turnSeq = persisted.turnSeq;
    loop.offTopicStrikes = persisted.offTopicStrikes ?? 0;
    const active: ActiveSession = {
      loop,
      // NOTE: the checkpoint turn stack is in-memory — undo history does not
      // survive a server restart (pre-images on disk are simply orphaned).
      checkpoint: createCheckpointStore(resolve(opts.repoRoot, 'viewer'), id),
      memory: createMemoryStore(resolve(opts.repoRoot, 'viewer'), id),
      transcript: persisted.transcript,
      title: persisted.title,
      createdAt: persisted.createdAt,
      createdPaths: new Set<string>(),
    };
    activeSessions.set(id, active);
    return active;
  }

  /** Best-effort persist; a failed save must never break the chat stream. */
  async function persistSession(active: ActiveSession): Promise<void> {
    try {
      await sessionStore.save({
        id: active.loop.id,
        title: active.title,
        createdAt: active.createdAt,
        updatedAt: new Date().toISOString(),
        ueVersion: active.loop.ueVersion,
        totalTokens: Math.round(active.loop.totalTokens),
        turnSeq: active.loop.turnSeq,
        offTopicStrikes: active.loop.offTopicStrikes,
        messages: active.loop.messages,
        transcript: active.transcript,
      });
    } catch (e) {
      console.error('agent session persist failed:', e);
    }
  }

  /**
   * Fully remove a session: runtime cache, session file, checkpoint pre-images
   * and per-session memory (longterm memory is shared and untouched). Used by
   * DELETE /api/agent/sessions/:id and the off-topic session_closed path.
   */
  async function destroySession(id: string): Promise<void> {
    const active = activeSessions.get(id);
    activeSessions.delete(id);
    if (currentSessionId === id) currentSessionId = null;
    await sessionStore.remove(id);
    try {
      const cpDir = active?.checkpoint.sessionDir
        ?? resolve(opts.repoRoot, 'viewer', '.agent-checkpoints', id);
      await rm(cpDir, { recursive: true, force: true });
    } catch { /* non-fatal */ }
    try {
      await rm(resolve(opts.repoRoot, 'viewer', '.agent-sessions', `${id}.memory.md`), { force: true });
    } catch { /* non-fatal */ }
  }

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

        // baseUrl — an explicit empty string clears the stored value (a stored
        // '' would otherwise short-circuit the adapters' `?? DEFAULT_BASE`).
        if (llmIn.baseUrl !== undefined) {
          const v = cleanConfigField(llmIn.baseUrl);
          if (v !== null && v !== '') llmConfig.baseUrl = v; else delete llmConfig.baseUrl;
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

        // maxIters: integer ≥ 0 (0 = unlimited); anything else clears → loop default.
        if (llmIn.maxIters !== undefined) {
          const n = Number(llmIn.maxIters);
          if (Number.isInteger(n) && n >= 0) {
            llmConfig.maxIters = Math.min(n, 1000);
          } else {
            delete llmConfig.maxIters;
          }
        }

        // contextLimit: model context window in tokens; 0/invalid clears → loop defaults.
        if (llmIn.contextLimit !== undefined) {
          const n = Number(llmIn.contextLimit);
          if (Number.isFinite(n) && n >= 32_000) {
            llmConfig.contextLimit = Math.min(Math.floor(n), 10_000_000);
          } else {
            delete llmConfig.contextLimit;
          }
        }

        merged.Llm = llmConfig;
      } catch (e) { sendJson(res, 400, { error: (e as Error).message }); return; }
    }

    // ── Web extension (search backend / API keys / proxy) ──────────────────────
    // Same merge contract as Llm: keys clear on explicit empty string, absent
    // fields keep the stored value, and nothing is ever echoed back.
    const bodyWeb = (body as Record<string, unknown>).Web;
    if (bodyWeb !== undefined && bodyWeb !== null && typeof bodyWeb === 'object') {
      const webIn = bodyWeb as Record<string, unknown>;
      try {
        const prevWeb = existing.Web;
        const webConfig: Record<string, unknown> =
          prevWeb && typeof prevWeb === 'object' ? { ...(prevWeb as Record<string, unknown>) } : {};

        if (webIn.searchBackend !== undefined) {
          const v = cleanConfigField(webIn.searchBackend) ?? '';
          if (v === '' || v === 'auto') delete webConfig.searchBackend;
          else if (['duckduckgo', 'tavily', 'brave', 'searxng'].includes(v)) webConfig.searchBackend = v;
          else throw new Error('Web.searchBackend must be auto/duckduckgo/tavily/brave/searxng');
        }
        for (const keyField of ['tavilyApiKey', 'braveApiKey'] as const) {
          if (keyField in webIn) {
            if (webIn[keyField] === '' || webIn[keyField] === null) delete webConfig[keyField];
            else {
              const v = cleanConfigField(webIn[keyField]);
              if (v !== null) webConfig[keyField] = v;
            }
          }
        }
        if (webIn.searxngBaseUrl !== undefined) {
          const v = cleanConfigField(webIn.searxngBaseUrl) ?? '';
          if (v === '') delete webConfig.searxngBaseUrl;
          else {
            const u = new URL(v); // throws on garbage
            if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Web.searxngBaseUrl must be http(s)');
            webConfig.searxngBaseUrl = v;
          }
        }
        if (webIn.proxyUrl !== undefined) {
          const v = cleanConfigField(webIn.proxyUrl) ?? '';
          if (v === '') delete webConfig.proxyUrl;
          else {
            const u = new URL(v);
            if (u.protocol !== 'http:') throw new Error('Web.proxyUrl must be an http:// CONNECT proxy (e.g. http://127.0.0.1:7890)');
            webConfig.proxyUrl = v;
          }
        }

        if (Object.keys(webConfig).length > 0) merged.Web = webConfig;
        else delete merged.Web;
      } catch (e) {
        sendJson(res, 400, { error: (e as Error).message.startsWith('Web.') ? (e as Error).message : `invalid Web config: ${(e as Error).message}` });
        return;
      }
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
        baseUrl: typeof llm.baseUrl === 'string' && llm.baseUrl.trim() !== '' ? llm.baseUrl : undefined,
        apiKey: typeof llm.apiKey === 'string' ? llm.apiKey : undefined,
        model: llm.model.trim(),
        maxTokens: typeof llm.maxTokens === 'number' && llm.maxTokens > 0 ? Math.floor(llm.maxTokens) : undefined,
        maxIters: typeof llm.maxIters === 'number' && Number.isInteger(llm.maxIters) && llm.maxIters >= 0 ? llm.maxIters : undefined,
        contextLimit: typeof llm.contextLimit === 'number' && llm.contextLimit >= 32_000 ? Math.floor(llm.contextLimit) : undefined,
      };
    } catch {
      return null;
    }
  }

  /** Read the `Web` section (search backend / keys / proxy) fresh per request. */
  async function readWebConfig(): Promise<WebSearchConfig | undefined> {
    try {
      const raw = JSON.parse(await readFile(localConfigPath, 'utf-8')) as Record<string, unknown>;
      const w = raw.Web as Record<string, unknown> | undefined;
      if (!w || typeof w !== 'object') return undefined;
      const str = (v: unknown): string | undefined =>
        typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
      const backend = str(w.searchBackend);
      return {
        backend: backend === 'auto' || backend === 'duckduckgo' || backend === 'tavily' || backend === 'brave' || backend === 'searxng'
          ? backend
          : undefined,
        tavilyApiKey: str(w.tavilyApiKey),
        braveApiKey: str(w.braveApiKey),
        searxngBaseUrl: str(w.searxngBaseUrl),
        proxyUrl: str(w.proxyUrl),
      };
    } catch {
      return undefined;
    }
  }

  /** GET /api/agent/status — returns ProviderStatus (never contains apiKey). */
  async function handleAgentStatus(res: import('node:http').ServerResponse) {
    const config = await readLlmConfig();
    const status: ProviderStatus = config
      ? {
          configured: true,
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          hasApiKey: config.apiKey !== undefined,
          maxIters: config.maxIters,
          contextLimit: config.contextLimit,
        }
      : { configured: false };
    const web = await readWebConfig();
    if (web) {
      status.webSearchBackend = web.backend ?? 'auto';
      status.hasTavilyKey = web.tavilyApiKey !== undefined;
      status.hasBraveKey = web.braveApiKey !== undefined;
      status.searxngBaseUrl = web.searxngBaseUrl;
      status.webProxyUrl = web.proxyUrl;
    }
    sendJson(res, 200, status);
  }

  /** POST /api/agent/web-test — one real search with the SAVED Web config. */
  async function handleAgentWebTest(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }
    const config = await readWebConfig();
    try {
      const r = await webSearch('Unreal Engine material editor', { config });
      sendJson(res, 200, (r.ok
        ? { ok: true, backend: r.backend, results: r.results.length }
        : { ok: false, error: r.error }) satisfies AgentWebTestResponse);
    } catch (e) {
      sendJson(res, 200, { ok: false, error: (e as Error)?.message ?? 'unknown error' } satisfies AgentWebTestResponse);
    }
  }

  /** Map raw provider/transport errors to actionable zh-TW guidance (key never echoed). */
  function friendlyTestError(raw: string, timedOut = false): string {
    const trimmed = raw.length > 300 ? raw.slice(0, 300) + '…' : raw;
    if (timedOut) return '連線逾時（30 秒）— 請檢查 Base URL 與網路連線。';
    if (/HTTP 40[13]/.test(raw)) return `API Key 無效或沒有權限（${trimmed}）`;
    if (/HTTP 404/.test(raw)) return `找不到模型或 API 路徑 — 請檢查 Model 名稱與 Base URL（${trimmed}）`;
    if (/HTTP 429/.test(raw)) return `請求過於頻繁或額度不足（${trimmed}）`;
    if (/HTTP 5\d\d/.test(raw)) return `伺服器端錯誤，稍後再試（${trimmed}）`;
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket|network/i.test(raw)) {
      return `無法連線到伺服器 — 請檢查 Base URL 與網路（${trimmed}）`;
    }
    return `測試失敗：${trimmed}`;
  }

  /** POST /api/agent/test — verify the SAVED LLM config with one minimal request. */
  async function handleAgentTest(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }

    const config = await readLlmConfig();
    if (!config) {
      sendJson(res, 200, {
        ok: false,
        error: '尚未設定 LLM 提供商 — 請先填寫並儲存下方欄位。',
      } satisfies AgentTestResponse);
      return;
    }

    let provider: import('./agent/provider/types.js').Provider;
    try {
      provider = makeProvider(config);
    } catch (e) {
      sendJson(res, 200, {
        ok: false,
        error: `無法建立 LLM 提供商：${(e as Error).message}`,
      } satisfies AgentTestResponse);
      return;
    }

    // Abort on client disconnect or after a hard 30 s ceiling.
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    const timer = setTimeout(() => ac.abort(), 30_000);

    try {
      let errMsg: string | null = null;
      for await (const ev of provider.stream({
        model: config.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: '測試連線，請只回覆「OK」。' }] }],
        maxTokens: 16,
        signal: ac.signal,
      })) {
        if (ev.type === 'error') { errMsg = ev.message; break; }
        if (ev.type === 'done') break;
      }
      if (errMsg !== null) {
        sendJson(res, 200, { ok: false, error: friendlyTestError(errMsg) } satisfies AgentTestResponse);
      } else {
        // Stream completed (any text/done) — the endpoint, key, and model all work.
        sendJson(res, 200, { ok: true, model: config.model } satisfies AgentTestResponse);
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      sendJson(res, 200, {
        ok: false,
        error: friendlyTestError(msg, ac.signal.aborted),
      } satisfies AgentTestResponse);
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST /api/agent/undo — restore the previous checkpoint turn (body may carry sessionId). */
  async function handleAgentUndo(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }

    // 409 if an agent is actively streaming — cannot undo while writing.
    if (agentStreaming) {
      sendJson(res, 409, { error: '對話進行中，無法還原。請等待完成後再試。' });
      return;
    }
    // Single-flight with regenerate/undo: the entry check above is not enough —
    // every await below is a window for a concurrent second mutation.
    if (agentMutating) {
      sendJson(res, 409, { error: '另一個還原／重新生成正在進行中，請稍候。' });
      return;
    }
    agentMutating = true;
    try {
      // A stopped chat releases the streaming lock before its generator has
      // fully unwound — wait it out so undo never races an in-flight write.
      await chatUnwind;

      // Optional body { sessionId } — absent falls back to the current session.
      let sessionId = currentSessionId;
      try {
        const raw = await readBody(req);
        if (raw) {
          const parsed = JSON.parse(raw) as { sessionId?: unknown };
          if (typeof parsed.sessionId === 'string' && SESSION_ID_RE.test(parsed.sessionId)) {
            sessionId = parsed.sessionId;
          }
        }
      } catch { /* empty/invalid body → current session */ }

      const active = sessionId ? await resumeSession(sessionId) : null;
      if (!active) {
        const body: AgentUndoResponse = { ok: false, reason: 'nothing-to-undo' };
        sendJson(res, 200, body);
        return;
      }

      const restored = await active.checkpoint.undoLastTurn(resolve(opts.repoRoot, 'graphs'));

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
    } finally {
      agentMutating = false;
    }
  }

  /**
   * POST /api/agent/regenerate — rewind the last user turn so the client can
   * re-send it: restore that turn's file writes (checkpoint undo), trim the
   * turn from the message history and the transcript, return the user text.
   * turnSeq is NOT decremented — checkpoint turn ids must stay monotonic.
   */
  async function handleAgentRegenerate(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }
    if (agentStreaming) {
      sendJson(res, 409, { error: '對話進行中，無法重新生成。請等待完成或停止後再試。' });
      return;
    }
    // Single-flight: two concurrent regenerates would each rewind the same
    // history once — the entry check alone leaves the await windows open.
    if (agentMutating) {
      sendJson(res, 409, { error: '另一個還原／重新生成正在進行中，請稍候。' });
      return;
    }
    agentMutating = true;
    try {
      // Wait out a stopped chat's unwind (see handleAgentUndo).
      await chatUnwind;

      let sessionId = currentSessionId;
      try {
        const raw = await readBody(req);
        if (raw) {
          const parsed = JSON.parse(raw) as { sessionId?: unknown };
          if (typeof parsed.sessionId === 'string' && SESSION_ID_RE.test(parsed.sessionId)) {
            sessionId = parsed.sessionId;
          }
        }
      } catch { /* empty/invalid body → current session */ }

      const active = sessionId ? await resumeSession(sessionId) : null;
      const lastUserIdx = active
        ? active.transcript.map(e => e.kind).lastIndexOf('user')
        : -1;
      if (!active || lastUserIdx === -1) {
        sendJson(res, 200, { ok: false, reason: 'nothing-to-regenerate' } satisfies AgentRegenerateResponse);
        return;
      }
      const userText = (active.transcript[lastUserIdx] as { kind: 'user'; text: string }).text;

      // Restore the files this turn wrote (no-op when it wrote nothing).
      await active.checkpoint.undoLastTurn(resolve(opts.repoRoot, 'graphs'));

      // Trim the message history back to before this user turn. The turn began
      // either as its own text-only user message, or as a text block appended to
      // a tool_results user message (the merged shape runAgent creates when the
      // previous turn ended on a ceiling/abort) — in the merged case keep the
      // tool_results so the preceding assistant tool_use stays answered.
      const msgs = active.loop.messages;
      let cut = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'user' && m.content.some(b => b.type === 'text' && b.text === userText)) {
          cut = i;
          break;
        }
      }
      if (cut !== -1) {
        const m = msgs[cut];
        // Remove only the LAST matching text block (identical re-sends stay intact).
        let removeIdx = -1;
        for (let j = m.content.length - 1; j >= 0; j--) {
          const b = m.content[j];
          if (b.type === 'text' && b.text === userText) { removeIdx = j; break; }
        }
        // Also drop any legacy viewport-context block (older sessions carry
        // them; the injection itself is gone — viewport is a tool now).
        const others = m.content.filter((b, j) =>
          j !== removeIdx && !(b.type === 'text' && b.text.startsWith(VIEW_CONTEXT_PREFIX)));
        active.loop.messages = others.some(b => b.type === 'tool_result')
          ? [...msgs.slice(0, cut), { role: 'user' as const, content: others }]
          : msgs.slice(0, cut);
      }

      active.transcript = active.transcript.slice(0, lastUserIdx);
      await persistSession(active);
      sendJson(res, 200, { ok: true, text: userText } satisfies AgentRegenerateResponse);
    } finally {
      agentMutating = false;
    }
  }

  /**
   * POST /api/agent/db-edit — the user-approval side of a db_edit_proposal.
   * Validates and applies the patch to the PUBLIC nodes-ue<v>.json, regenerates
   * the index, runs the parity audit, and rolls back on any failure. Single-
   * flight: the regen+audit subprocesses must never overlap.
   */
  let dbEditRunning = false;
  async function handleAgentDbEdit(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }
    if (dbEditRunning) {
      sendJson(res, 409, { error: '另一個節點 DB 修改正在套用中，請稍候。' });
      return;
    }
    dbEditRunning = true;
    try {
      let body: AgentDbEditRequest;
      try { body = JSON.parse(await readBody(req)) as AgentDbEditRequest; }
      catch (e) { sendJson(res, 400, { error: `bad request body: ${(e as Error).message}` }); return; }
      if (typeof body.nodeName !== 'string' || typeof body.ueVersion !== 'string') {
        sendJson(res, 400, { error: 'nodeName and ueVersion are required' });
        return;
      }
      const result = await applyDbEdit(opts.repoRoot, body.ueVersion, body.nodeName, body.patch ?? {}, undefined, body.create === true);
      if (result.ok) {
        sendJson(res, 200, { ok: true, changedKeys: result.changedKeys ?? [] } satisfies AgentDbEditResponse);
      } else {
        sendJson(res, 200, { ok: false, error: result.error ?? 'unknown error' } satisfies AgentDbEditResponse);
      }
    } finally {
      dbEditRunning = false;
    }
  }

  /** POST /api/agent/reset — abort any in-flight chat and detach the current session. */
  async function handleAgentReset(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }
    if (agentMutating) {
      sendJson(res, 409, { error: '正在還原／重新生成，請稍候再試。' });
      return;
    }

    // Abort any in-flight streaming chat.
    agentAbortRef.current?.abort();
    agentAbortRef.current = null;
    // Clear the streaming flag immediately so the next POST /api/agent/chat on
    // this server instance does not receive a spurious 409.  The flag is also
    // cleared in handleAgentChat's finally block, but that fires only after the
    // aborted generator fully unwinds — which is asynchronous and can take
    // several seconds with a real LLM provider.
    agentStreaming = false;

    // Drop the current session's undo history (stale pre-images are dead
    // weight) and detach it. The session FILE persists — reset means "start
    // clean", not "destroy history"; deletion is DELETE /api/agent/sessions/:id.
    const active = currentSessionId ? activeSessions.get(currentSessionId) : null;
    if (active) {
      try {
        await rm(active.checkpoint.sessionDir, { recursive: true, force: true });
      } catch {
        // Non-fatal — directory may already be gone.
      }
      activeSessions.delete(active.loop.id);
    }
    currentSessionId = null;

    const body: AgentResetResponse = { ok: true };
    sendJson(res, 200, body);
  }

  // ─── M7 session endpoints ───────────────────────────────────────────────────

  /** GET /api/agent/sessions — list persisted sessions, newest first. */
  async function handleAgentSessionsList(res: import('node:http').ServerResponse) {
    const sessions = await sessionStore.list();
    sendJson(res, 200, { sessions } satisfies AgentSessionsListResponse);
  }

  /** POST /api/agent/sessions — create a fresh persistent session. */
  async function handleAgentSessionsCreate(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }
    let ueVersion: string | undefined;
    try {
      const raw = await readBody(req);
      if (raw) {
        const parsed = JSON.parse(raw) as { ueVersion?: unknown };
        if (typeof parsed.ueVersion === 'string' && parsed.ueVersion.trim()) ueVersion = parsed.ueVersion.trim();
      }
    } catch { /* empty body is fine */ }

    const id = newAgentSessionId();
    const active = createActiveSession(id, ueVersion ?? defaultUeVersion());
    currentSessionId = id;
    await persistSession(active);
    sendJson(res, 200, { id } satisfies AgentSessionCreateResponse);
  }

  /** GET /api/agent/sessions/:id — replayable transcript + meta. */
  async function handleAgentSessionDetail(id: string, res: import('node:http').ServerResponse) {
    const active = await resumeSession(id);
    if (!active) { sendJson(res, 404, { error: '找不到指定的會話。' }); return; }
    sendJson(res, 200, {
      id: active.loop.id,
      title: active.title,
      ueVersion: active.loop.ueVersion,
      totalTokens: Math.round(active.loop.totalTokens),
      transcript: active.transcript,
    } satisfies AgentSessionDetail);
  }

  /** DELETE /api/agent/sessions/:id — remove the session file + checkpoints. */
  async function handleAgentSessionDelete(id: string, req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }
    if (agentStreaming && currentSessionId === id) {
      sendJson(res, 409, { error: '對話進行中，無法刪除。請先停止。' });
      return;
    }
    if (agentMutating) {
      sendJson(res, 409, { error: '正在還原／重新生成，請稍候再試。' });
      return;
    }
    // Check BEFORE destroy — sessionStore.remove clears the pointer itself.
    const wasPublic = (await sessionStore.getPublicId()) === id;
    await destroySession(id);
    sendJson(res, 200, { ok: true });
    if (wasPublic) broadcastPublicAgent(null, false);
  }

  /**
   * POST /api/agent/sessions/:id/public — designate (or clear) the single
   * team-visible announcement session. Admin-only via the team gate.
   */
  async function handleAgentSessionPublic(id: string, req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }
    let makePublic = true;
    try {
      const raw = await readBody(req, 64_000);
      if (raw) makePublic = (JSON.parse(raw) as { public?: unknown }).public !== false;
    } catch { /* empty body = set public */ }
    if (makePublic) {
      if (!(await sessionStore.load(id)) && !activeSessions.has(id)) {
        sendJson(res, 404, { error: '找不到指定的會話。' });
        return;
      }
      await sessionStore.setPublicId(id);
      broadcastPublicAgent(id, agentStreaming && currentSessionId === id);
    } else {
      if ((await sessionStore.getPublicId()) === id) {
        await sessionStore.setPublicId(null);
        broadcastPublicAgent(null, false);
      }
    }
    sendJson(res, 200, { ok: true, publicId: makePublic ? id : null });
  }

  /**
   * GET /api/agent/public-session — the announcement channel's replayable
   * transcript. Deliberately NOT admin-only: this is the one agent surface
   * every team member can read (and the only one — raw messages stay private).
   */
  async function handleAgentPublicSession(res: import('node:http').ServerResponse) {
    const id = await sessionStore.getPublicId();
    if (!id) { sendJson(res, 200, { id: null } satisfies AgentPublicSessionResponse); return; }
    // Prefer the in-memory session: mid-turn its transcript is ahead of disk.
    const active = activeSessions.get(id);
    if (active) {
      sendJson(res, 200, {
        id,
        title: active.title,
        ueVersion: active.loop.ueVersion,
        updatedAt: new Date().toISOString(),
        streaming: agentStreaming && currentSessionId === id,
        transcript: active.transcript,
      } satisfies AgentPublicSessionResponse);
      return;
    }
    const persisted = await sessionStore.load(id);
    if (!persisted) { sendJson(res, 200, { id: null } satisfies AgentPublicSessionResponse); return; }
    sendJson(res, 200, {
      id,
      title: persisted.title,
      ueVersion: persisted.ueVersion,
      updatedAt: persisted.updatedAt,
      streaming: false,
      transcript: persisted.transcript,
    } satisfies AgentPublicSessionResponse);
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

    // Single-flight: reject concurrent chats (and chats during undo/regenerate).
    // IMPORTANT: set the flag here, synchronously, before any await — otherwise a
    // second request can arrive during readBody/readLlmConfig and pass the guard (TOCTOU).
    if (agentStreaming) {
      sendJson(res, 409, { error: '目前已有對話進行中，請等待完成或停止後再試。' });
      return;
    }
    if (agentMutating) {
      sendJson(res, 409, { error: '正在還原／重新生成，請稍候再試。' });
      return;
    }
    agentStreaming = true;

    // Serialize against the previous run's unwind: a stopped chat releases the
    // streaming lock immediately (socket close), but its generator may still
    // be unwinding (a tool call in flight) — wait for it to fully finish
    // (including persistSession) before touching any session state, so an
    // aborted old run can never interleave with or clobber this run.
    const prevUnwind = chatUnwind;
    let releaseUnwind!: () => void;
    chatUnwind = new Promise<void>((r) => { releaseUnwind = r; });
    try {
      await prevUnwind;
      await handleAgentChatInner(req, res);
    } finally {
      releaseUnwind();
    }
  }

  async function handleAgentChatInner(req: IncomingMessage, res: import('node:http').ServerResponse) {
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

    // Resolve the target session (M7): explicit sessionId binds exactly; an
    // id-less request continues the current session or creates a fresh one —
    // so a reloaded UI that binds explicitly can never inherit stale context.
    let active: ActiveSession;
    if (typeof body.sessionId === 'string' && body.sessionId) {
      if (!SESSION_ID_RE.test(body.sessionId)) {
        agentStreaming = false;
        sendJson(res, 400, { error: 'invalid sessionId' });
        return;
      }
      const resumed = await resumeSession(body.sessionId);
      if (!resumed) {
        agentStreaming = false;
        sendJson(res, 404, { error: '找不到指定的會話，請重新整理會話列表。' });
        return;
      }
      active = resumed;
    } else {
      const current = currentSessionId ? await resumeSession(currentSessionId) : null;
      active = current ?? createActiveSession(
        newAgentSessionId(),
        body.ueVersion ?? defaultUeVersion(),
        body.graphPath ?? undefined,
      );
    }
    currentSessionId = active.loop.id;

    // Announcement channel: tell every viewer a new turn started streaming here.
    if ((await sessionStore.getPublicId()) === active.loop.id) broadcastPublicAgent(active.loop.id, true);

    const session = active.loop;
    const checkpointStore = active.checkpoint;

    // Transcript: record the user message and derive a title from the first one.
    appendTranscript(active.transcript, { kind: 'user', text: body.text });
    if (!active.title) active.title = body.text.trim().slice(0, 30);

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

    // Abort when the client disconnects (stop button = fetch abort = socket
    // close), and release the single-flight lock IMMEDIATELY: the aborted
    // generator only notices the abort at its next event boundary and can take
    // seconds to unwind — without this, an instant re-send hits a spurious
    // 409. The next chat serializes behind chatUnwind, so the early release
    // can never let two runs mutate the same session concurrently.
    //
    // NOTE: mid-response disconnects surface on the RESPONSE ('close' with
    // writableEnded still false) — the request stream completed long ago at
    // readBody, so req 'close' alone misses them. Keep both for robustness.
    const onClientGone = () => {
      if (res.writableEnded) return; // normal completion, nothing to abort
      ac.abort();
      if (agentAbortRef.current === ac) {
        agentStreaming = false;
        agentAbortRef.current = null;
      }
    };
    req.on('close', onClientGone);
    res.on('close', onClientGone);

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

    // Off-topic strike limit: the loop emits session_closed; the finally block
    // below deletes the session instead of persisting it.
    let sessionClosed = false;
    const emit = (event: AgentSseEvent) => {
      if (event.type === 'session_closed') sessionClosed = true;
      if (res.writableEnded) return;
      const out = event.type === 'error' ? { ...event, message: withToolHint(event.message) } : event;
      res.write(`data: ${JSON.stringify(out)}\n\n`);
      // Mirror every emitted event into the replayable transcript (text and
      // thinking deltas coalesce inside appendTranscript).
      appendTranscript(active.transcript, { kind: 'event', event: out });
    };

    // Viewport state rides in the ToolContext and is read ON DEMAND via the
    // get_viewport tool — never injected into the prompt (an injected open
    // graph biased「建立」requests into modifying the open file).
    const viewport: { graphPath?: string; selectedNodeId?: string } = {};
    if (typeof body.graphPath === 'string' && body.graphPath.trim()) {
      viewport.graphPath = body.graphPath.trim();
    }
    if (typeof body.selectedNodeId === 'string' && body.selectedNodeId.trim()) {
      viewport.selectedNodeId = body.selectedNodeId.trim();
    }

    const ctx = {
      repoRoot: opts.repoRoot,
      graphsRoot,
      ueVersion: session.ueVersion,
      workMfIndexPath: resolve(agentPackRoot, 'workmf-index.json'),
      beforeWrite: async (absPath: string, turnId: string) => {
        await checkpointStore.snapshotFile(turnId, absPath);
      },
      memory: active.memory,
      getCrawlLog: () => runner.lastLog(),
      viewport,
      sessionCreatedPaths: active.createdPaths,
      // signal lets web_fetch/web_search abort promptly on stop; config carries
      // the user's search backend / proxy settings (read fresh per request).
      web: { signal: ac.signal, config: await readWebConfig() },
    };

    // Allowlist the per-turn thinking level from the request body.
    const thinking = body.thinking === 'low' || body.thinking === 'medium' || body.thinking === 'high'
      ? body.thinking
      : undefined;

    try {
      await runAgent(
        body.text,
        session,
        provider,
        llmConfig.model,
        ctx,
        emit,
        ac.signal,
        {
          maxTokens: llmConfig.maxTokens,
          thinking,
          // 0 = unlimited is the LOOP's semantic (single source of truth there);
          // unlimited runs are still bounded by the token ceiling and the
          // consecutive-failure breakers.
          maxIters: llmConfig.maxIters,
          // Context window drives both knobs: compact at half, hard-stop at the window.
          compactThreshold: llmConfig.contextLimit !== undefined ? Math.floor(llmConfig.contextLimit / 2) : undefined,
          tokenCeiling: llmConfig.contextLimit,
          // 🌐 switch: absent = on (the loop removes the web tools when false).
          webToolsEnabled: body.webSearch !== false,
        },
      );
    } catch (e) {
      // A user-initiated abort is a normal cancellation, not an error — the
      // adapters already swallow their own AbortErrors, but anything that
      // slips through (e.g. the initial provider fetch aborting) must not
      // surface as a fake「對話發生錯誤」.
      if (ac.signal.aborted || (e as Error)?.name === 'AbortError') {
        emit({ type: 'done' });
      } else {
        const msg = (e as Error)?.message ?? 'unknown error';
        // Tool-rejection messages get the model-switch hint via emit; everything
        // else gets the generic prefix.
        const toolRejected = /4\d\d/.test(msg) && /tool/i.test(msg);
        emit({ type: 'error', message: toolRejected ? msg : `對話發生錯誤：${msg}` });
        emit({ type: 'done' });
      }
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
      if (sessionClosed) {
        // Off-topic strike limit: delete instead of persist — the session and
        // all its artifacts (checkpoints, memory) are gone for good. Deleting
        // BEFORE ending the response makes "stream closed ⇒ session gone" hold
        // (clients acting on the done EVENT may still race by a few ms).
        const wasPublic = (await sessionStore.getPublicId()) === active.loop.id;
        await destroySession(active.loop.id);
        if (!res.writableEnded) res.end();
        // A destroyed announcement session must vanish for viewers too.
        if (wasPublic) broadcastPublicAgent(null, false);
      } else {
        if (!res.writableEnded) res.end();
        // Persist the turn (messages + transcript + meta). Best-effort: an
        // aborted turn is still saved — synthetic tool_results keep it legal.
        await persistSession(active);
        // Announcement channel: turn persisted → viewers re-fetch the transcript.
        try {
          if ((await sessionStore.getPublicId()) === active.loop.id) broadcastPublicAgent(active.loop.id, false);
        } catch (e) { console.error('public-agent broadcast failed:', e); }
      }
    }
  }

  // ─── /api/auth/* handlers (team mode; 404 in local mode) ───────────────────

  async function handleAuthStatus(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!authStore) {
      // Local mode: the single local user owns the box — report as an
      // implicitly-authed admin so the web client can branch on one shape.
      sendJson(res, 200, { mode: 'local', needsSetup: false, authed: true, role: 'admin' });
      return;
    }
    const user = await authenticate(req);
    sendJson(res, 200, {
      mode: 'team',
      needsSetup: !(await authStore.hasUsers()),
      authed: !!user,
      ...(user ? { username: user.username, role: user.role } : {}),
    });
  }

  /** First-boot bootstrap: creates the initial ADMIN account, then logs it in. */
  async function handleAuthSetup(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!authStore) { sendJson(res, 404, { error: 'not available in local mode' }); return; }
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }
    if (await authStore.hasUsers()) { sendJson(res, 409, { error: 'already set up' }); return; }
    let body: { username?: unknown; password?: unknown };
    try { body = JSON.parse(await readBody(req, 64_000)); }
    catch (e) { sendJson(res, 400, { error: `bad request body: ${(e as Error).message}` }); return; }
    const created = await authStore.createUser(String(body.username ?? ''), String(body.password ?? ''), 'admin');
    if (!created.ok) { sendJson(res, 400, { error: created.error }); return; }
    const username = String(body.username);
    const token = await authStore.issueToken(username);
    setAuthCookie(res, token);
    sendJson(res, 200, { authed: true, username, role: 'admin', token });
  }

  async function handleAuthLogin(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!authStore) { sendJson(res, 404, { error: 'not available in local mode' }); return; }
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (loginLimiter.blocked(ip)) { sendJson(res, 429, { error: 'too many failed logins — try again later' }); return; }
    let body: { username?: unknown; password?: unknown };
    try { body = JSON.parse(await readBody(req, 64_000)); }
    catch (e) { sendJson(res, 400, { error: `bad request body: ${(e as Error).message}` }); return; }
    const user = await authStore.verifyPassword(String(body.username ?? ''), String(body.password ?? ''));
    if (!user) {
      loginLimiter.fail(ip);
      sendJson(res, 401, { error: '帳號或密碼錯誤' });
      return;
    }
    loginLimiter.succeed(ip);
    // The raw token is also returned in the body for script/CLI use
    // (Authorization: Bearer) — the browser flow relies on the cookie alone.
    const token = await authStore.issueToken(user.username);
    setAuthCookie(res, token);
    sendJson(res, 200, { authed: true, username: user.username, role: user.role, token });
  }

  async function handleAuthLogout(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!authStore) { sendJson(res, 404, { error: 'not available in local mode' }); return; }
    if (!sameOrigin(req)) { sendJson(res, 403, { error: '跨來源請求已拒絕' }); return; }
    const token = readAuthToken(req);
    if (token) await authStore.revokeToken(token);
    setAuthCookie(res, null);
    sendJson(res, 200, { authed: false });
  }

  // User management (admin-only; the team gate enforces the role before these run).
  async function handleAuthUsersList(res: import('node:http').ServerResponse) {
    if (!authStore) { sendJson(res, 404, { error: 'not available in local mode' }); return; }
    sendJson(res, 200, { users: await authStore.listUsers() });
  }

  async function handleAuthUsersCreate(req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!authStore) { sendJson(res, 404, { error: 'not available in local mode' }); return; }
    let body: { username?: unknown; password?: unknown; role?: unknown };
    try { body = JSON.parse(await readBody(req, 64_000)); }
    catch (e) { sendJson(res, 400, { error: `bad request body: ${(e as Error).message}` }); return; }
    const role: Role = body.role === 'admin' ? 'admin' : 'user';
    const r = await authStore.createUser(String(body.username ?? ''), String(body.password ?? ''), role);
    if (!r.ok) { sendJson(res, 400, { error: r.error }); return; }
    sendJson(res, 200, { ok: true, username: String(body.username), role });
  }

  async function handleAuthUserDelete(name: string, res: import('node:http').ServerResponse) {
    if (!authStore) { sendJson(res, 404, { error: 'not available in local mode' }); return; }
    const r = await authStore.deleteUser(name);
    if (!r.ok) { sendJson(res, 400, { error: r.error }); return; }
    sendJson(res, 200, { ok: true });
  }

  async function handleAuthUserPassword(name: string, req: IncomingMessage, res: import('node:http').ServerResponse) {
    if (!authStore) { sendJson(res, 404, { error: 'not available in local mode' }); return; }
    let body: { password?: unknown };
    try { body = JSON.parse(await readBody(req, 64_000)); }
    catch (e) { sendJson(res, 400, { error: `bad request body: ${(e as Error).message}` }); return; }
    const v = validateCredentials(name, body.password);
    if (!v.ok) { sendJson(res, 400, { error: v.error }); return; }
    const r = await authStore.setPassword(name, String(body.password));
    if (!r.ok) { sendJson(res, 400, { error: r.error }); return; }
    sendJson(res, 200, { ok: true });
  }

  // Track all open HTTP sockets so we can destroy them during forced shutdown.
  // Without this, http.close() only stops accepting new connections but waits
  // for existing keep-alive connections to drain — which can take up to 300 s on
  // some Node versions, hanging every test that calls server.close().
  const openSockets = new Set<import('node:net').Socket>();
  const http: Server = createServer(async (req, res) => {
    const urlPath = (req.url || '/').split('?')[0];

    // ── Public auth endpoints (usable before login; 404 in local mode) ──────
    if (req.method === 'GET' && urlPath === '/api/auth/status') {
      try { await handleAuthStatus(req, res); }
      catch (e) { console.error('auth status error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/auth/setup') {
      try { await handleAuthSetup(req, res); }
      catch (e) { console.error('auth setup error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/auth/login') {
      try { await handleAuthLogin(req, res); }
      catch (e) { console.error('auth login error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/auth/logout') {
      try { await handleAuthLogout(req, res); }
      catch (e) { console.error('auth logout error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }

    // ── Team gate: every other /api route needs a valid token; the dangerous
    //    surface additionally needs the admin role. Local mode: no-op. ────────
    if (teamMode && urlPath.startsWith('/api/')) {
      let user: AuthUser | null = null;
      try { user = await authenticate(req); }
      catch (e) { console.error('authenticate error:', e); }
      if (!user) { sendJson(res, 401, { error: '需要登入' }); return; }
      if (isAdminOnly(urlPath) && user.role !== 'admin') { sendJson(res, 403, { error: '需要管理員權限' }); return; }
    }

    // ── User management (admin-gated above) ─────────────────────────────────
    if (urlPath === '/api/auth/users') {
      if (req.method === 'GET') {
        try { await handleAuthUsersList(res); }
        catch (e) { console.error('auth users list error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
        return;
      }
      if (req.method === 'POST') {
        try { await handleAuthUsersCreate(req, res); }
        catch (e) { console.error('auth users create error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
        return;
      }
    }
    {
      const m = urlPath.match(/^\/api\/auth\/users\/([A-Za-z0-9_.-]{1,32})(\/password)?$/);
      if (m && USERNAME_RE.test(m[1])) {
        if (req.method === 'DELETE' && !m[2]) {
          try { await handleAuthUserDelete(m[1], res); }
          catch (e) { console.error('auth user delete error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
          return;
        }
        if (req.method === 'POST' && m[2]) {
          try { await handleAuthUserPassword(m[1], req, res); }
          catch (e) { console.error('auth user password error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
          return;
        }
      }
    }

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
    if (urlPath === '/api/agent/sessions') {
      if (req.method === 'GET') {
        try { await handleAgentSessionsList(res); }
        catch (e) { console.error('agent sessions list error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
        return;
      }
      if (req.method === 'POST') {
        try { await handleAgentSessionsCreate(req, res); }
        catch (e) { console.error('agent sessions create error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
        return;
      }
    }
    if (req.method === 'GET' && urlPath === '/api/agent/public-session') {
      try { await handleAgentPublicSession(res); }
      catch (e) { console.error('agent public-session error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    {
      const m = urlPath.match(/^\/api\/agent\/sessions\/([A-Za-z0-9_-]{1,64})\/public$/);
      if (m && req.method === 'POST') {
        try { await handleAgentSessionPublic(m[1], req, res); }
        catch (e) { console.error('agent session public error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
        return;
      }
    }
    {
      const m = urlPath.match(/^\/api\/agent\/sessions\/([A-Za-z0-9_-]{1,64})$/);
      if (m) {
        const sid = m[1];
        if (req.method === 'GET') {
          try { await handleAgentSessionDetail(sid, res); }
          catch (e) { console.error('agent session detail error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
          return;
        }
        if (req.method === 'DELETE') {
          try { await handleAgentSessionDelete(sid, req, res); }
          catch (e) { console.error('agent session delete error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
          return;
        }
      }
    }
    if (req.method === 'POST' && urlPath === '/api/agent/test') {
      try { await handleAgentTest(req, res); }
      catch (e) { console.error('agent test handler error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/agent/web-test') {
      try { await handleAgentWebTest(req, res); }
      catch (e) { console.error('agent web-test handler error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/agent/undo') {
      try { await handleAgentUndo(req, res); }
      catch (e) { console.error('agent undo handler error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/agent/regenerate') {
      try { await handleAgentRegenerate(req, res); }
      catch (e) { console.error('agent regenerate handler error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/agent/reset') {
      try { await handleAgentReset(req, res); }
      catch (e) { console.error('agent reset handler error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
      return;
    }
    if (req.method === 'POST' && urlPath === '/api/agent/db-edit') {
      try { await handleAgentDbEdit(req, res); }
      catch (e) { console.error('agent db-edit handler error:', e); if (!res.headersSent) sendJson(res, 500, { error: 'internal error' }); }
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
    // Team mode: the upgrade request carries the HttpOnly auth cookie — no
    // token, no socket (the WS streams every graph + the file list).
    if (teamMode) {
      let user: AuthUser | null = null;
      try { user = await authenticate(req); }
      catch (e) { console.error('ws authenticate error:', e); }
      if (!user) { ws.close(4401, 'authentication required'); return; }
    }
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
      // Replay the announcement-channel pointer so a late joiner can render it.
      const publicId = await sessionStore.getPublicId();
      if (publicId) send(ws, { kind: 'publicAgent', id: publicId, streaming: agentStreaming && currentSessionId === publicId });
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

  // Local-first: bind loopback unless BIND_HOST opts into team mode. The crawl
  // endpoint spawns UnrealEditor-Cmd.exe, so a non-loopback bind is only safe
  // because the team gate above puts that surface behind admin auth.
  await new Promise<void>((res, rej) => {
    http.once('error', rej);
    http.listen(opts.port, opts.bindHost ?? '127.0.0.1', () => { http.removeListener('error', rej); res(); });
  });
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

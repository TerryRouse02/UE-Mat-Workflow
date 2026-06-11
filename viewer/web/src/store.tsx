import React, { createContext, useContext, useReducer, useEffect, useCallback, useMemo } from 'react';
import { connect } from './ws-client';
import { startCrawlRequest, cancelCrawlRequest, type CrawlAction, type CrawlKind } from './crawlRequest';
import type { ServerMessage, GraphPayload, FileEntry } from './protocol';
import type { EnvStatus } from '../../server/crawl-types';

export type { CrawlKind };

interface CrawlState {
  status: 'idle' | 'running' | 'success' | 'error';
  kind: string | null;
  jobId: string | null;
  logs: string[];
  exitCode: number | null;
}

interface State {
  files: FileEntry[];
  currentPath: string | null;
  breadcrumb: string[];
  graphs: Record<string, GraphPayload>;
  errors: Record<string, string[]>;
  connection: 'live' | 'reconnecting' | 'snapshot';
  lastUpdate: number | null;
  env: EnvStatus | null;
  crawl: CrawlState;
  // Bumps when a crawl regenerates agent-pack data, so dbContext re-fetches.
  metadataVersion: number;
  // Bumps when a WorkMF crawl succeeds, so dbContext re-fetches the project-MF
  // index for the Nodes tab (kept separate from metadataVersion: workmf is NOT a
  // public agent-pack file, so it must not trigger the agent-pack re-fetch).
  workMfVersion: number;
  // Nodes the agent just wrote/modified — the Graph pulses them once the file
  // opens. ts gates staleness (an old highlight never re-fires on later mounts).
  agentHighlight: { path: string; ids: string[]; nonce: number; ts: number } | null;
  // Agent asked for a UE-clipboard export of this graph; App performs it once
  // the graph is open and rendered (T3D needs the dagre positions). ts gates
  // staleness like agentHighlight.
  agentExportReq: { path: string; nonce: number; ts: number } | null;
  // Currently selected canvas node (lifted from App so the agent chat can
  // attach it as viewport context on every message).
  selectedNodeId: string | null;
  // One-shot "say this to the agent" request (問 AI button, post-import
  // explain). App switches to the Agent tab; AgentChat consumes the text —
  // send=true submits immediately, send=false prefills the input.
  agentAsk: { text: string; send: boolean; nonce: number; ts: number } | null;
}

type Action =
  | { type: 'hello'; files: FileEntry[] }
  | { type: 'fileList'; files: FileEntry[] }
  | { type: 'graph'; path: string; payload: GraphPayload }
  | { type: 'graphError'; path: string; errors: string[] }
  | { type: 'open'; path: string }
  | { type: 'enterMF'; mfPath: string }
  | { type: 'popBreadcrumb'; toIndex: number }
  | { type: 'wsOpen' }
  | { type: 'wsClosed' }
  | { type: 'snapshot' }
  | { type: 'setEnv'; env: EnvStatus }
  | { type: 'agentHighlight'; path: string; ids: string[] }
  | { type: 'agentExportReq'; path: string }
  | { type: 'selectNode'; id: string | null }
  | { type: 'metadataBumped' }
  | { type: 'agentAsk'; text: string; send: boolean }
  | { type: 'crawlReset' }
  | CrawlAction;

const idleCrawl: CrawlState = { status: 'idle', kind: null, jobId: null, logs: [], exitCode: null };

const initial: State = {
  files: [], currentPath: null, breadcrumb: [], graphs: {}, errors: {},
  connection: 'reconnecting', lastUpdate: null,
  env: null, crawl: idleCrawl, metadataVersion: 0, workMfVersion: 0,
  agentHighlight: null, agentExportReq: null,
  selectedNodeId: null, agentAsk: null,
};

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'wsOpen':   return { ...s, connection: 'live' };
    case 'wsClosed': return { ...s, connection: 'reconnecting' };
    case 'snapshot': return { ...s, connection: 'snapshot' };
    case 'hello':
    case 'fileList':
      return { ...s, files: a.files, lastUpdate: Date.now() };
    case 'graph':
      return { ...s, graphs: { ...s.graphs, [a.path]: a.payload }, errors: { ...s.errors, [a.path]: [] }, lastUpdate: Date.now() };
    case 'graphError':
      return { ...s, errors: { ...s.errors, [a.path]: a.errors } };
    case 'open':
      return { ...s, currentPath: a.path, breadcrumb: [a.path] };
    case 'enterMF':
      return { ...s, breadcrumb: [...s.breadcrumb, a.mfPath] };
    case 'popBreadcrumb':
      return { ...s, breadcrumb: s.breadcrumb.slice(0, a.toIndex + 1) };
    case 'setEnv':
      return { ...s, env: a.env };
    case 'agentHighlight':
      return { ...s, agentHighlight: { path: a.path, ids: a.ids, nonce: (s.agentHighlight?.nonce ?? 0) + 1, ts: Date.now() } };
    case 'agentExportReq':
      return { ...s, agentExportReq: { path: a.path, nonce: (s.agentExportReq?.nonce ?? 0) + 1, ts: Date.now() } };
    case 'selectNode':
      return { ...s, selectedNodeId: a.id };
    case 'metadataBumped':
      // A user-approved DB edit rewrote the public agent-pack files server-side.
      return { ...s, metadataVersion: s.metadataVersion + 1 };
    case 'agentAsk':
      return { ...s, agentAsk: { text: a.text, send: a.send, nonce: (s.agentAsk?.nonce ?? 0) + 1, ts: Date.now() } };
    case 'crawlReset':
      return { ...s, crawl: idleCrawl };
    case 'crawlStarted':
      return { ...s, crawl: { status: 'running', kind: a.kind, jobId: a.jobId, logs: [], exitCode: null } };
    case 'crawlAccepted':
      return { ...s, crawl: { ...s.crawl, jobId: a.jobId } };
    case 'crawlLog':
      // Cap the buffer — a multi-minute editor run emits a lot of lines.
      return { ...s, crawl: { ...s.crawl, logs: [...s.crawl.logs.slice(-199), a.line] } };
    case 'crawlDone':
      return {
        ...s,
        crawl: { ...s.crawl, status: a.status, exitCode: a.exitCode },
        // export/enginemf rewrite the public agent-pack files → bump so dbContext
        // re-fetches. workmf rewrites the gitignored project-MF index, which is applied
        // server-side at graph-open (not via agent-pack) → don't bump; its live refresh
        // is the graph re-resolve effect below.
        metadataVersion: a.status === 'success' && s.crawl.kind !== 'workmf' ? s.metadataVersion + 1 : s.metadataVersion,
        // A successful workmf crawl rewrote the project-MF index → bump so dbContext
        // re-fetches it for the Nodes-tab "Project Material Functions" browser.
        workMfVersion: a.status === 'success' && s.crawl.kind === 'workmf' ? s.workMfVersion + 1 : s.workMfVersion,
      };
    default: return s;
  }
}

interface Ctx {
  state: State;
  open(path: string): void;
  enterMF(path: string): void;
  popBreadcrumb(i: number): void;
  startCrawl(kind: CrawlKind, contentRoots?: string): void;
  stopCrawl(): void;
  resetCrawl(): void;
  refreshEnv(): void;
  saveConfig(projectPath: string, engineRoot: string): Promise<{ ok: boolean; error?: string }>;
  saveAgentConfig(llm: {
    provider: string; baseUrl?: string; apiKey?: string; model: string; maxTokens?: number;
    maxIters?: number; contextLimit?: number;
  }): Promise<{ ok: boolean; error?: string }>;
  /** Pulse the given nodes on the canvas once the graph at path is open (agent diff highlight). */
  highlightNodes(path: string, ids: string[]): void;
  /** Ask App to export the graph at path to the UE clipboard once it is rendered. */
  requestAgentExport(path: string): void;
  /** Select (or clear) the canvas node shown in the Inspector / sent as agent context. */
  selectNode(id: string | null): void;
  /** Hand a message to the agent chat: send=true submits it, send=false prefills the input. */
  askAgent(text: string, send: boolean): void;
  /** Re-fetch the agent-pack data after a server-side DB edit (approved db_edit_proposal). */
  bumpMetadata(): void;
}

const C = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const wsRef = React.useRef<ReturnType<typeof connect> | null>(null);

  useEffect(() => {
    const exportData = (window as unknown as { __UE_MAT_EXPORT__?: { entry: string; files: Record<string, unknown>; derivedPins: unknown; warnings: string[] } }).__UE_MAT_EXPORT__;
    if (exportData) {
      const exportEntries: FileEntry[] = Object.entries(exportData.files).map(([path, g]) => {
        const t = (g as { type?: string }).type;
        return {
          path,
          type: t === 'Material' || t === 'MaterialFunction' ? t : 'Unknown',
        };
      });
      dispatch({ type: 'hello', files: exportEntries });
      for (const [path, graph] of Object.entries(exportData.files)) {
        dispatch({
          type: 'graph', path,
          payload: {
            graph: graph as any,
            derivedPins: exportData.derivedPins as any,
            warnings: exportData.warnings,
          },
        });
      }
      dispatch({ type: 'open', path: exportData.entry });
      dispatch({ type: 'snapshot' });
      return;
    }
    const ws = connect({
      onOpen: () => dispatch({ type: 'wsOpen' }),
      onClose: () => dispatch({ type: 'wsClosed' }),
      onMessage: (m: ServerMessage) => {
        if (m.kind === 'hello') dispatch({ type: 'hello', files: m.files });
        else if (m.kind === 'fileList') dispatch({ type: 'fileList', files: m.files });
        else if (m.kind === 'graph') dispatch({ type: 'graph', path: m.path, payload: m.payload });
        else if (m.kind === 'graphError') dispatch({ type: 'graphError', path: m.path, errors: m.errors });
        else if (m.kind === 'crawlStarted') dispatch({ type: 'crawlStarted', kind: m.crawlKind, jobId: m.jobId });
        else if (m.kind === 'crawlLog') dispatch({ type: 'crawlLog', line: m.line });
        else if (m.kind === 'crawlDone') {
          dispatch({ type: 'crawlDone', status: m.status, exitCode: m.exitCode });
          if (m.status === 'success') void refreshEnv();
        }
      },
    });
    wsRef.current = ws;
    return () => ws.close();
  }, []);

  const refreshEnv = useCallback(async () => {
    try {
      const r = await fetch('/api/env', { cache: 'no-store' });
      if (r.ok) dispatch({ type: 'setEnv', env: await r.json() });
    } catch {
      // No server (snapshot / offline) — env stays null, crawl button stays off.
    }
  }, []);

  // Probe the local environment once the server connection is live; this is what
  // gates the crawl button ("link 成功就支持爬").
  useEffect(() => { if (state.connection === 'live') void refreshEnv(); }, [state.connection, refreshEnv]);

  // workmf data is resolved server-side at graph-open, not via the agent-pack fetch
  // path. So when a workmf crawl succeeds, re-request the currently-visible graphs (the
  // whole breadcrumb) over the WS WITHOUT dispatching 'open' — that re-resolves them with
  // the fresh project-MF index while preserving the user's drill-down.
  useEffect(() => {
    if (state.crawl.status === 'success' && state.crawl.kind === 'workmf') {
      for (const path of state.breadcrumb) wsRef.current?.send({ kind: 'open', path });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.crawl.status, state.crawl.kind]);

  const startCrawl = useCallback(async (kind: CrawlKind, contentRoots?: string) => {
    await startCrawlRequest(kind, dispatch, contentRoots ? { contentRoots } : {});
  }, []);

  const stopCrawl = useCallback(() => {
    void cancelCrawlRequest();
    dispatch({ type: 'crawlLog', line: '使用者已要求停止' });
  }, []);

  const resetCrawl = useCallback(() => {
    dispatch({ type: 'crawlReset' });
  }, []);

  // Write the per-machine crawl config from the Config tab, then apply the fresh
  // probe the server returns so the checklist + crawl gate update immediately.
  const saveConfig = useCallback(async (projectPath: string, engineRoot: string) => {
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ProjectPath: projectPath, EngineRoot: engineRoot }),
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: e.error || `HTTP ${r.status}` };
      }
      dispatch({ type: 'setEnv', env: await r.json() });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }, []);

  const open = useCallback((path: string) => { wsRef.current?.send({ kind: 'open', path }); dispatch({ type: 'open', path }); }, []);
  const enterMF = useCallback((path: string) => { wsRef.current?.send({ kind: 'open', path }); dispatch({ type: 'enterMF', mfPath: path }); }, []);
  const popBreadcrumb = useCallback((i: number) => { dispatch({ type: 'popBreadcrumb', toIndex: i }); }, []);

  // Save AI assistant configuration via POST /api/config with Llm field.
  // The response shape is EnvStatus (not Llm) per the server contract.
  const saveAgentConfig = useCallback(async (llm: {
    provider: string; baseUrl?: string; apiKey?: string; model: string; maxTokens?: number;
    maxIters?: number; contextLimit?: number;
  }) => {
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ Llm: llm }),
      });
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: e.error || `HTTP ${r.status}` };
      }
      dispatch({ type: 'setEnv', env: await r.json() });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }, []);

  const highlightNodes = useCallback((path: string, ids: string[]) => {
    if (ids.length > 0) dispatch({ type: 'agentHighlight', path, ids });
  }, []);

  const requestAgentExport = useCallback((path: string) => {
    dispatch({ type: 'agentExportReq', path });
  }, []);

  const selectNode = useCallback((id: string | null) => {
    dispatch({ type: 'selectNode', id });
  }, []);

  const askAgent = useCallback((text: string, send: boolean) => {
    dispatch({ type: 'agentAsk', text, send });
  }, []);

  const bumpMetadata = useCallback(() => {
    dispatch({ type: 'metadataBumped' });
  }, []);

  const value = useMemo(() => ({ state, open, enterMF, popBreadcrumb, startCrawl, stopCrawl, resetCrawl, refreshEnv, saveConfig, saveAgentConfig, highlightNodes, requestAgentExport, selectNode, askAgent, bumpMetadata }), [state, open, enterMF, popBreadcrumb, startCrawl, stopCrawl, resetCrawl, refreshEnv, saveConfig, saveAgentConfig, highlightNodes, requestAgentExport, selectNode, askAgent, bumpMetadata]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useStore() {
  const c = useContext(C);
  if (!c) throw new Error('useStore outside StoreProvider');
  return c;
}

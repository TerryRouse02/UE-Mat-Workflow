import type { MatGraph } from './types.js';
import type { ResolvedGraph } from './mf-resolver.js';

export type NodeSource = 'export' | 'workmf' | 'enginemf' | 'projectmat' | 'unresolved';

export interface NodeProvenance {
  source: NodeSource;
  freshnessTs: string | null;
}

export interface FileEntry {
  path: string;
  type: 'Material' | 'MaterialFunction' | 'Unknown';
  nodeCount?: number;
  origin?: 'agent' | 'crawled';
  /** Pre-scanned health so every file shows a status dot without being opened.
   *  'error' = failed to load/validate, 'warn' = loaded with warnings, 'ok' = clean.
   *  Computed with the same load+resolve as opening the file, so dots match. */
  health?: 'ok' | 'warn' | 'error';
  /** Constant-folded BaseColor/Emissive swatch (graph-preview.ts), 0-1 sRGB.
   *  Absent when the chain cannot be folded (textures, MFs, ...). */
  preview?: [number, number, number];
}

export type ServerMessage =
  | { kind: 'hello'; graphsRoot: string; files: FileEntry[] }
  | { kind: 'fileList'; files: FileEntry[] }
  | { kind: 'graph'; path: string; payload: GraphPayload }
  | { kind: 'graphError'; path: string; errors: string[] }
  // Web-triggered crawl progress, broadcast to all clients (the crawl is a
  // machine-wide operation, not per-connection).
  | { kind: 'crawlStarted'; jobId: string; crawlKind: string }
  | { kind: 'crawlLog'; jobId: string; line: string }
  | { kind: 'crawlDone'; jobId: string; status: 'success' | 'error'; exitCode: number | null }
  // Announcement-channel signal (team mode): the public agent session changed
  // (id), started streaming, or finished a turn (streaming false -> viewers
  // re-fetch GET /api/agent/public-session). Sent on connect + on change.
  | { kind: 'publicAgent'; id: string | null; streaming: boolean }
  // Member->admin approval queue size changed (team mode). Sent on connect +
  // on every add/resolve; the admin inbox re-fetches on it.
  | { kind: 'proposals'; pending: number }
  // A server-side report was injected into this session (approval outcome) -
  // the session's open chat view re-fetches its transcript.
  | { kind: 'sessionBumped'; id: string }
  // Team mode: who currently holds an open WS connection (unique usernames).
  | { kind: 'online'; users: string[] }
  // Live delta from the 系統主Agent (public) session while its turn streams -
  // viewers append it without waiting for the end-of-turn re-fetch.
  | { kind: 'publicAgentDelta'; id: string; event: unknown };

export interface GraphPayload {
  graph: MatGraph;
  derivedPins: ResolvedGraph['derivedPins'];
  warnings: string[];
  nodeProvenance?: Record<string, NodeProvenance>;
}

export type ClientMessage =
  | { kind: 'open'; path: string }
  | { kind: 'listFiles' };

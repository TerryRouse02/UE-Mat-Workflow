// Duplicate of viewer/server/ws-protocol.ts. Keep in sync.

export type NodeSource = 'export' | 'workmf' | 'enginemf' | 'projectmat' | 'unresolved';

export interface NodeProvenance {
  source: NodeSource;
  freshnessTs: string | null;
}

export interface NodeJson { id: string; type: string; params?: Record<string, unknown>; }
export interface ConnectionJson { from: string; to: string; }
export interface CommentJson { id: string; text: string; color?: string; contains: string[]; }

export interface MatGraph {
  schemaVersion: string;
  ueVersion: string;
  type: 'Material' | 'MaterialFunction';
  name: string;
  description?: string;
  nodes: NodeJson[];
  connections: ConnectionJson[];
  comments?: CommentJson[];
}

export interface DerivedPins {
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
}

export interface GraphPayload {
  graph: MatGraph;
  derivedPins: Record<string, DerivedPins>;
  warnings: string[];
  nodeProvenance?: Record<string, NodeProvenance>;
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
}

export type ServerMessage =
  | { kind: 'hello'; graphsRoot: string; files: FileEntry[] }
  | { kind: 'fileList'; files: FileEntry[] }
  | { kind: 'graph'; path: string; payload: GraphPayload }
  | { kind: 'graphError'; path: string; errors: string[] }
  | { kind: 'crawlStarted'; jobId: string; crawlKind: string }
  | { kind: 'crawlLog'; jobId: string; line: string }
  | { kind: 'crawlDone'; jobId: string; status: 'success' | 'error'; exitCode: number | null };

export type ClientMessage =
  | { kind: 'open'; path: string }
  | { kind: 'listFiles' };

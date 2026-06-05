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
  | { kind: 'crawlDone'; jobId: string; status: 'success' | 'error'; exitCode: number | null };

export interface GraphPayload {
  graph: MatGraph;
  derivedPins: ResolvedGraph['derivedPins'];
  warnings: string[];
  nodeProvenance?: Record<string, NodeProvenance>;
}

export type ClientMessage =
  | { kind: 'open'; path: string }
  | { kind: 'listFiles' };

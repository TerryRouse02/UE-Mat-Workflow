import type { MatGraph } from './types.js';
import type { ResolvedGraph } from './mf-resolver.js';

export type ServerMessage =
  | { kind: 'hello'; graphsRoot: string; files: string[] }
  | { kind: 'fileList'; files: string[] }
  | { kind: 'graph'; path: string; payload: GraphPayload }
  | { kind: 'graphError'; path: string; errors: string[] };

export interface GraphPayload {
  graph: MatGraph;
  derivedPins: ResolvedGraph['derivedPins'];
  warnings: string[];
}

export type ClientMessage =
  | { kind: 'open'; path: string }
  | { kind: 'listFiles' };

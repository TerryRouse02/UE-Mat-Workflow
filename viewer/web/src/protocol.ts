// Duplicate of viewer/server/ws-protocol.ts. Keep in sync.

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
}

export type ServerMessage =
  | { kind: 'hello'; graphsRoot: string; files: string[] }
  | { kind: 'fileList'; files: string[] }
  | { kind: 'graph'; path: string; payload: GraphPayload }
  | { kind: 'graphError'; path: string; errors: string[] };

export type ClientMessage =
  | { kind: 'open'; path: string }
  | { kind: 'listFiles' };

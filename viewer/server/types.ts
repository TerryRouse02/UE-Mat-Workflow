export type GraphType = 'Material' | 'MaterialFunction';

export interface Node {
  id: string;
  type: string;
  params?: Record<string, unknown>;
}

export interface Connection {
  from: string; // "<nodeId>:<pinName>"
  to: string;
}

export interface Comment {
  id: string;
  text: string;
  color?: string;
  contains: string[]; // node ids
}

export interface MatGraph {
  schemaVersion: string;
  ueVersion: string;
  type: GraphType;
  name: string;
  description?: string;
  nodes: Node[];
  connections: Connection[];
  comments?: Comment[];
}

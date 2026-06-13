export type GraphType = 'Material' | 'MaterialFunction';

export interface Node {
  id: string;
  type: string;
  params?: Record<string, unknown>;
  /** UE editor position (integer UE space). OPTIONAL — present on UE-imported /
   *  user-saved graphs (render at authored layout, round-trip to UE unchanged);
   *  absent on AI-authored graphs (dagre auto-layout). CLAUDE.md invariant #6. */
  pos?: { x: number; y: number };
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

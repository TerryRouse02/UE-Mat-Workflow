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
  /** UE object path this graph was crawled from (e.g. "/Game/Materials/M_Foo.M_Foo").
   *  OPTIONAL — set by the projectmat importer (from the crawl manifest) so the viewer
   *  can re-crawl just this asset; absent on AI-authored / clipboard-imported graphs.
   *  Lives only under the gitignored graphs/_project/, so a /Game path here is allowed
   *  (CLAUDE.md invariant #1/#3 cover COMMITTED files; this never ships). */
  sourcePath?: string;
}

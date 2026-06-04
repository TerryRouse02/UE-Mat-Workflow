// Node-free shared types for the work-MF index, imported by both the server
// (workmf-index.ts) and the web (NodeLibrary / agentPackClient). Kept free of node
// imports so pulling it into the web's tsc program adds no node typing requirement
// — same approach as crawl-types.ts. The DATA these describe stays server-only and
// is never bundled; only the shapes are shared.

export interface WorkMfPin {
  name: string;
  type: string;
  index?: number;
}

export interface WorkMfEntry {
  assetPath: string;
  displayName?: string;
  category?: string;
  inputs: WorkMfPin[];
  outputs: WorkMfPin[];
  missing?: boolean;
}

export interface WorkMfIndex {
  schemaVersion?: string;
  kind: 'workmf-index';
  ueVersion?: string;
  functions: Record<string, WorkMfEntry>;
}

export interface LoadedWorkMfIndex {
  index: WorkMfIndex | null;
  warnings: string[];
}

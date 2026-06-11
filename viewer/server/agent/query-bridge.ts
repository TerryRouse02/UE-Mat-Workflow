// server/agent/query-bridge.ts — typed ESM wrapper over agent-pack/query-lib.js.
// Uses createRequire with the absolute path so tsc dist/ location doesn't break.

import { createRequire } from 'node:module';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Minimal TS interfaces for query-lib return shapes
// ---------------------------------------------------------------------------

export interface SearchMatch {
  name: string;
  category: string;
  desc: string;
  verified: boolean;
  deprecated: boolean;
  dynamicPins: boolean;
  line: string;
}

export interface GetNodesResult {
  result: Record<string, unknown>;
  suggestions: Record<string, string[]>;
}

export type MfResult =
  | { found: true; entry: unknown }
  | { found: false; reason: 'not-in-index' | 'index-absent'; kind: 'engine' | 'work' };

export interface MfSearchMatch {
  assetPath: string;
  displayName: string;
  source: 'engine' | 'work';
  inputs: number;
  outputs: number;
  line: string;
}

interface QueryLib {
  discoverVersions(dataDir: string): string[];
  loadNodesDb(dataDir: string, version: string): unknown;
  searchNodes(dataDir: string, version: string, terms: string[], opts?: { category?: string }): SearchMatch[];
  getNodes(dataDir: string, version: string, names: string[]): GetNodesResult;
  getMf(dataDir: string, assetPath: string, version: string | null, workMfIndexPath?: string): MfResult;
  searchMf(dataDir: string, terms: string[], version?: string | null, workMfIndexPath?: string): MfSearchMatch[];
}

// ---------------------------------------------------------------------------
// Module cache — one instance per repoRoot
// ---------------------------------------------------------------------------

const _cache = new Map<string, QueryLib>();

function loadLib(repoRoot: string): QueryLib {
  const cached = _cache.get(repoRoot);
  if (cached) return cached;
  // Require by absolute path so the module is found regardless of where tsc
  // emitted this file (dist/ or server/).
  const require = createRequire(import.meta.url);
  const lib = require(join(repoRoot, 'agent-pack', 'query-lib.js')) as QueryLib;
  _cache.set(repoRoot, lib);
  return lib;
}

// ---------------------------------------------------------------------------
// Typed wrappers
// ---------------------------------------------------------------------------

export function discoverVersions(repoRoot: string): string[] {
  return loadLib(repoRoot).discoverVersions(join(repoRoot, 'agent-pack'));
}

export function searchNodes(
  repoRoot: string,
  version: string,
  terms: string[],
  opts?: { category?: string },
): SearchMatch[] {
  return loadLib(repoRoot).searchNodes(join(repoRoot, 'agent-pack'), version, terms, opts);
}

export function getNodes(
  repoRoot: string,
  version: string,
  names: string[],
): GetNodesResult {
  return loadLib(repoRoot).getNodes(join(repoRoot, 'agent-pack'), version, names);
}

export function loadNodesDb(
  repoRoot: string,
  version: string,
): { nodes: Record<string, unknown> } {
  return loadLib(repoRoot).loadNodesDb(join(repoRoot, 'agent-pack'), version) as {
    nodes: Record<string, unknown>;
  };
}

export function getMf(
  repoRoot: string,
  assetPath: string,
  version: string,
  workMfIndexPath?: string,
): MfResult {
  return loadLib(repoRoot).getMf(
    join(repoRoot, 'agent-pack'),
    assetPath,
    version,
    workMfIndexPath,
  );
}

export function searchMf(
  repoRoot: string,
  terms: string[],
  version?: string | null,
  workMfIndexPath?: string,
): MfSearchMatch[] {
  return loadLib(repoRoot).searchMf(
    join(repoRoot, 'agent-pack'),
    terms,
    version ?? null,
    workMfIndexPath,
  );
}

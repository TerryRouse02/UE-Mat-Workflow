// Official engine Material Function index — bundled at build time, exactly like the
// node DB (see dbRegistry.ts). Every UE version ships its committed index as
//   agent-pack/enginemf-index-ue<ver>.json
// and the glob below inlines it into the build (so the single-file HTML export stays
// self-contained, same as the DB).
//
// Why this one IS bundled but workmf-index.json is NOT: this is official engine data,
// shared by everyone and committed to the repo. The work-MF index holds the user's OWN
// /Game project asset paths, so it stays server-only and is never baked into a bundle.
//
// To refresh: regenerate the index on a UE machine (tools/node-t3d-metadata, mode
// "Engine MF") and commit it. No code change here — the glob picks it up on next build.

export interface EngineMfPin {
  name: string;
  type: string;
  index?: number;
}

export interface EngineMfEntry {
  assetPath: string;
  displayName?: string;
  category?: string;
  inputs: EngineMfPin[];
  outputs: EngineMfPin[];
}

export interface EngineMfIndex {
  ueVersion?: string;
  functions: Record<string, EngineMfEntry>;
}

const modules = import.meta.glob('../../../agent-pack/enginemf-index-ue*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const byVersion = new Map<string, EngineMfIndex>();
for (const mod of Object.values(modules)) {
  const idx = mod as EngineMfIndex;
  if (idx && typeof idx === 'object' && idx.functions) {
    byVersion.set(idx.ueVersion ?? 'unknown', idx);
  }
}

// The committed index for `ueVersion`, or any available one as a best-effort fallback
// (the official library barely changes between minor versions, and the browser is a
// read-only reference). Returns null only when no index ships at all.
export function engineMfFor(ueVersion: string | undefined): EngineMfIndex | null {
  if (ueVersion && byVersion.has(ueVersion)) return byVersion.get(ueVersion)!;
  const first = byVersion.values().next().value;
  return first ?? null;
}

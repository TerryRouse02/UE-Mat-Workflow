import { describe, it, expect } from 'vitest';
import { resolveBundle, latestBundleOf, resolveEngineMf, type RegistryData } from '../web/src/agentPackClient';
import type { NodeDB } from '../server/db-types';
import type { ExportMeta } from '../web/src/export/export-meta-types';
import type { EngineMfIndex } from '../web/src/engineMfRegistry';

// The resolution helpers dbContext relies on, exercised against a hand-built
// RegistryData (no glob/fetch) so the live-vs-snapshot wiring is irrelevant.
function bundle(v: string) {
  return { ueVersion: v, db: { ueVersion: v, nodes: {} } as unknown as NodeDB, exportMeta: { ueVersion: v } as unknown as ExportMeta };
}
function reg(versions: string[], engineMf: Record<string, EngineMfIndex> = {}): RegistryData {
  return {
    bundles: new Map(versions.map((v) => [v, bundle(v)])),
    engineMf: new Map(Object.entries(engineMf)),
    versions: [...versions].sort(),
  };
}

describe('agentPackClient resolution', () => {
  it('resolveBundle returns the matching version, or null for an unknown/undefined version', () => {
    const r = reg(['5.6', '5.7']);
    expect(resolveBundle(r, '5.7')?.ueVersion).toBe('5.7');
    expect(resolveBundle(r, '9.9')).toBeNull();
    expect(resolveBundle(r, undefined)).toBeNull();
  });

  it('latestBundleOf picks the highest available version', () => {
    expect(latestBundleOf(reg(['5.5', '5.7', '5.6']))?.ueVersion).toBe('5.7');
    expect(latestBundleOf(reg([]))).toBeNull();
  });

  it('resolveEngineMf returns the version index, else any available (best-effort fallback)', () => {
    const idx57: EngineMfIndex = { ueVersion: '5.7', functions: {} };
    const r = reg(['5.6', '5.7'], { '5.7': idx57 });
    expect(resolveEngineMf(r, '5.7')).toBe(idx57);
    // unknown version → falls back to the only index present
    expect(resolveEngineMf(r, '9.9')).toBe(idx57);
    // no indices at all → null
    expect(resolveEngineMf(reg(['5.7']), '5.7')).toBeNull();
  });
});

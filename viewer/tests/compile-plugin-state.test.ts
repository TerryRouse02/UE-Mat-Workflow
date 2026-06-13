import { describe, it, expect } from 'vitest';
import { compilePluginAction } from '../web/src/compilePluginState';
import type { EnvStatus } from '../server/crawl-types';

// Build a minimal EnvStatus with just the checks the compile button reads.
function makeEnv(partial: { platform?: string; checks: Record<string, boolean> }): EnvStatus {
  const checks = Object.fromEntries(
    Object.entries(partial.checks).map(([k, ok]) => [k, { ok, detail: '' }]),
  );
  return {
    ready: Object.values(checks).every((c) => c.ok),
    platform: partial.platform ?? 'win32',
    projectPath: null,
    engineRoot: null,
    checks,
  };
}

describe('compilePluginAction', () => {
  it('is disabled with a platform hint on an unsupported host', () => {
    const a = compilePluginAction(makeEnv({ platform: 'linux', checks: { platform: false, engine: false, plugin: false } }));
    expect(a.enabled).toBe(false);
    expect(a.hint).toMatch(/Windows|macOS/);
  });

  it('is disabled with an engine hint when the engine root is unset/invalid', () => {
    const a = compilePluginAction(makeEnv({ checks: { platform: true, engine: false, plugin: false } }));
    expect(a.enabled).toBe(false);
    expect(a.hint).toMatch(/引擎根目錄/);
  });

  it('is enabled and emphasized when platform+engine are ok but the binary is missing', () => {
    const a = compilePluginAction(makeEnv({ checks: { platform: true, engine: true, plugin: false } }));
    expect(a.enabled).toBe(true);
    expect(a.emphasize).toBe(true);
  });

  it('stays enabled but not emphasized once the plugin is already compiled (recompile path)', () => {
    const a = compilePluginAction(makeEnv({ checks: { platform: true, engine: true, plugin: true } }));
    expect(a.enabled).toBe(true);
    expect(a.emphasize).toBe(false);
  });

  it('labels the build target per OS (.dylib on mac, .dll on windows)', () => {
    const mac = compilePluginAction(makeEnv({ platform: 'darwin', checks: { platform: true, engine: true, plugin: false } }));
    expect(mac.hint).toMatch(/dylib/);
    const win = compilePluginAction(makeEnv({ platform: 'win32', checks: { platform: true, engine: true, plugin: false } }));
    expect(win.hint).toMatch(/dll/);
  });

  it('is safely disabled (no crash) when env has not been probed yet', () => {
    const a = compilePluginAction(null);
    expect(a.enabled).toBe(false);
    expect(a.emphasize).toBe(false);
  });
});

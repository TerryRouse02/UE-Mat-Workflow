import { describe, it, expect } from 'vitest';
import { probeEnv } from '../server/crawl-env';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';

// Build a fixture repo whose probed paths all exist, so the platform gate is the
// only thing separating a darwin host from a "ready" verdict.
function touch(p: string) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, ''); }

function readyRepo(): { root: string; tool: string; engine: string; project: string } {
  const root = mkdtempSync(resolve(tmpdir(), 'env-'));
  const tool = resolve(root, 'tools', 'node-t3d-metadata');
  const engine = resolve(root, 'UE');
  const project = resolve(root, 'proj', 'My.uproject');
  touch(resolve(engine, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'));
  touch(project);
  touch(resolve(tool, 'compiled', 'UEMatExportMetadata', 'Binaries', 'Win64', 'UnrealEditor-UEMatExportMetadata.dll'));
  touch(resolve(engine, 'Engine', 'Binaries', 'Mac', 'UnrealEditor-Cmd'));
  touch(resolve(tool, 'compiled', 'UEMatExportMetadata', 'Binaries', 'Mac', 'UnrealEditor-UEMatExportMetadata.dylib'));
  mkdirSync(tool, { recursive: true });
  writeFileSync(resolve(tool, 'local.config.json'), JSON.stringify({ ProjectPath: project, EngineRoot: engine }));
  return { root, tool, engine, project };
}

describe('probeEnv', () => {
  it('ready=true on win32 when config + engine + project + plugin are all present', async () => {
    const { root } = readyRepo();
    const env = await probeEnv(root, { platform: 'win32' });
    expect(env.ready).toBe(true);
    expect(Object.values(env.checks).every((c) => c.ok)).toBe(true);
    expect(env.engineRoot).toContain('UE');
    expect(env.projectPath).toContain('My.uproject');
  });

  it('ready=true on darwin when the Mac engine binary + Mac plugin are present', async () => {
    const { root } = readyRepo();
    const env = await probeEnv(root, { platform: 'darwin' });
    expect(env.ready).toBe(true);
    expect(env.checks.platform.ok).toBe(true);
    expect(env.checks.platform.detail).toBe('macOS');
  });

  it('flags a darwin host whose Mac UnrealEditor-Cmd is absent (Win64-only engine)', async () => {
    const { root, tool, project } = readyRepo();
    const winOnly = resolve(root, 'winOnly');
    touch(resolve(winOnly, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'));
    writeFileSync(resolve(tool, 'local.config.json'), JSON.stringify({ ProjectPath: project, EngineRoot: winOnly }));
    const env = await probeEnv(root, { platform: 'darwin' });
    expect(env.checks.engine.ok).toBe(false);
  });

  it('flags a missing local.config.json', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'env-'));
    mkdirSync(resolve(root, 'tools', 'node-t3d-metadata'), { recursive: true });
    const env = await probeEnv(root, { platform: 'win32' });
    expect(env.ready).toBe(false);
    expect(env.checks.config.ok).toBe(false);
    expect(env.projectPath).toBeNull();
  });

  it('flags an engine root whose UnrealEditor-Cmd.exe is absent', async () => {
    const { root, tool, project } = readyRepo();
    // Repoint EngineRoot at a directory with no editor binary.
    writeFileSync(resolve(tool, 'local.config.json'), JSON.stringify({ ProjectPath: project, EngineRoot: resolve(root, 'nope') }));
    const env = await probeEnv(root, { platform: 'win32' });
    expect(env.ready).toBe(false);
    expect(env.checks.engine.ok).toBe(false);
  });

  it('flags a ProjectPath that points at a folder, not the .uproject file', async () => {
    const { root, tool, engine } = readyRepo();
    writeFileSync(resolve(tool, 'local.config.json'), JSON.stringify({ ProjectPath: resolve(root, 'projDir'), EngineRoot: engine }));
    const env = await probeEnv(root, { platform: 'win32' });
    expect(env.checks.project.ok).toBe(false);
    expect(env.checks.project.detail).toMatch(/must point to the \.uproject file/);
  });

  it('flags a project-local plugin copy that would shadow the packaged plugin', async () => {
    const { root, project } = readyRepo();
    touch(resolve(dirname(project), 'Plugins', 'UEMatExportMetadata', 'UEMatExportMetadata.uplugin'));
    const env = await probeEnv(root, { platform: 'win32' });
    expect(env.ready).toBe(false);
    expect(env.checks.noShadow.ok).toBe(false);
  });
});

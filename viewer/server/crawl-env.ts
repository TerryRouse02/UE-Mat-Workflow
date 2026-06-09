import { readFile, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import type { EnvCheck, EnvStatus } from './crawl-types.js';

// Local-first environment probe for the web-triggered crawl. The crawl runs
// UnrealEditor-Cmd.exe on THIS machine, so before we light up the button we
// confirm — with cheap filesystem checks — that the engine, project, and the
// compiled plugin are all present and that nothing will make the run fail late.
// This is what "网页 link 成功就支持爬" means concretely: a green probe.

export type { EnvCheck, EnvStatus } from './crawl-types.js';

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

export interface ProbeOpts {
  // Injectable so the Windows-only platform gate is unit-testable off-Windows.
  platform?: string;
}

export async function probeEnv(repoRoot: string, opts: ProbeOpts = {}): Promise<EnvStatus> {
  const platform = opts.platform ?? process.platform;
  const onMac = platform === 'darwin';
  const editorName = onMac ? 'UnrealEditor-Cmd' : 'UnrealEditor-Cmd.exe';
  const tool = resolve(repoRoot, 'tools', 'node-t3d-metadata');
  const configPath = resolve(tool, 'local.config.json');

  let projectPath: string | null = null;
  let engineRoot: string | null = null;
  let configOk = false;
  let configDetail = 'missing local.config.json — copy local.config.example.json and fill ProjectPath + EngineRoot';
  if (await exists(configPath)) {
    try {
      const cfg = JSON.parse(await readFile(configPath, 'utf-8')) as { ProjectPath?: string; EngineRoot?: string };
      projectPath = cfg.ProjectPath?.trim() || null;
      engineRoot = cfg.EngineRoot?.trim() || null;
      configOk = Boolean(projectPath && engineRoot);
      configDetail = configOk
        ? 'local.config.json has ProjectPath + EngineRoot'
        : 'local.config.json present but ProjectPath/EngineRoot is empty';
    } catch (e) {
      configDetail = `local.config.json is not valid JSON: ${(e as Error).message}`;
    }
  }

  const editorCmd = engineRoot
    ? (onMac
        ? resolve(engineRoot, 'Engine', 'Binaries', 'Mac', 'UnrealEditor-Cmd')
        : resolve(engineRoot, 'Engine', 'Binaries', 'Win64', 'UnrealEditor-Cmd.exe'))
    : null;
  const engineOk = Boolean(editorCmd) && await exists(editorCmd as string);
  const projectHasUproject = Boolean(projectPath) && (projectPath as string).endsWith('.uproject');
  const projectOk = projectHasUproject && await exists(projectPath as string);
  const projectDetail = projectOk
    ? 'project .uproject found'
    : !projectPath
      ? '.uproject not found (ProjectPath unset)'
      : !projectHasUproject
        ? 'ProjectPath must point to the .uproject file, not the project folder'
        : `.uproject not found (${projectPath})`;
  const dll = onMac
    ? resolve(tool, 'compiled', 'UEMatExportMetadata', 'Binaries', 'Mac', 'UnrealEditor-UEMatExportMetadata.dylib')
    : resolve(tool, 'compiled', 'UEMatExportMetadata', 'Binaries', 'Win64', 'UnrealEditor-UEMatExportMetadata.dll');
  const dllOk = await exists(dll);
  // The tooling refuses to run when a project-local plugin copy would shadow the
  // packaged one (Invoke-NodeT3DMetadataMaintenance.ps1 preflight). Catch it here
  // so the button is disabled with a clear reason rather than failing mid-run.
  const shadow = projectPath
    ? join(dirname(projectPath), 'Plugins', 'UEMatExportMetadata', 'UEMatExportMetadata.uplugin')
    : null;
  const shadowPresent = Boolean(shadow) && await exists(shadow as string);
  const platformOk = platform === 'win32' || platform === 'darwin';

  const checks: Record<string, EnvCheck> = {
    platform: { ok: platformOk, detail: platformOk ? (onMac ? 'macOS' : 'Windows') : `the crawl runs ${editorName} — needs Windows or macOS (host is ${platform})` },
    config: { ok: configOk, detail: configDetail },
    engine: { ok: engineOk, detail: engineOk ? `${editorName} found` : `${editorName} not found${engineRoot ? ` under ${engineRoot}` : ' (EngineRoot unset)'}` },
    project: { ok: projectOk, detail: projectDetail },
    plugin: { ok: dllOk, detail: dllOk ? 'compiled plugin present' : `compiled plugin missing — build it once (${onMac ? 'Mac .dylib' : 'Windows .dll'})` },
    noShadow: { ok: !shadowPresent, detail: shadowPresent ? `remove the project-local plugin copy that shadows the packaged one (${shadow})` : 'no shadowing project-plugin copy' },
  };
  const ready = Object.values(checks).every((c) => c.ok);
  return { ready, platform, projectPath, engineRoot, checks };
}

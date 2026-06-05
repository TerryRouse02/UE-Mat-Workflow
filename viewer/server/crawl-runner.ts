import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

// Single-job runner for the web-triggered crawl. It spawns the existing
// PowerShell entrypoints (so their preflight / local.config fallback /
// auto-package / exit-code semantics are reused, not reimplemented) and streams
// their stdout/stderr line-by-line to a caller-supplied emit() — http-server
// wires that to the WebSocket broadcast. Only ONE crawl runs at a time.
//
// The real spawn only works on Windows (UnrealEditor-Cmd.exe). The runner takes
// an injectable spawnImpl + commandFor so it is fully unit-testable off-Windows
// with a mock script; the Windows end-to-end run is verified separately.

export type CrawlKind = 'export' | 'enginemf' | 'workmf' | 'projectmat';

export type CrawlEvent =
  | { type: 'started'; jobId: string; kind: CrawlKind }
  | { type: 'log'; jobId: string; line: string }
  | { type: 'done'; jobId: string; status: 'success' | 'error'; exitCode: number | null };

export interface CrawlStatus {
  status: 'idle' | 'running' | 'success' | 'error';
  jobId?: string;
  kind?: CrawlKind;
  exitCode?: number | null;
}

export interface SpawnSpec {
  command: string;
  args: string[];
}

export interface CrawlStartOpts {
  // Meaningful for 'workmf'/'projectmat': the UE content root(s) to crawl, e.g. "/Game"
  // or "/Game/Materials,/MyPlugin". Omitted → the script's own default (/Game,
  // the whole project Content/). Validated at the HTTP boundary before it reaches here.
  contentRoots?: string;
}

export type SpawnImpl = (spec: SpawnSpec, cwd: string) => ChildProcess;
export type CommandFor = (repoRoot: string, kind: CrawlKind, opts?: CrawlStartOpts) => SpawnSpec;

// The actual PowerShell invocation per crawl kind, kept in ONE place so the
// Windows side can confirm/adjust the exact args without touching the runner.
// All three scripts read ProjectPath/EngineRoot from local.config.json.
// Staging dir the projectmat commandlet writes UE T3D dumps into (gitignored,
// cleaned by the server after import). Shared with http-server's post-crawl hook.
export const PROJECTMAT_STAGING_REL = 'tools/node-t3d-metadata/projectmat-staging';

export const defaultCommandFor: CommandFor = (repoRoot, kind, opts) => {
  const tool = resolve(repoRoot, 'tools', 'node-t3d-metadata');
  const ps = (file: string, extra: string[]): SpawnSpec => ({
    command: 'powershell',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(tool, file), ...extra],
  });
  switch (kind) {
    case 'export':
      // Packages the plugin, regenerates nodes-ue5.7.export.json, audits. Skip the
      // viewer tests — the button is a metadata refresh, not a CI gate, and a
      // missing viewer/node_modules must not fail the crawl.
      return ps('Invoke-NodeT3DMetadataMaintenance.ps1', ['-SkipViewerTests']);
    case 'enginemf':
      return ps('plugin-src/Scripts/Run-EngineMfIndex.ps1', []);
    case 'workmf':
      // Regenerates the gitignored agent-pack/workmf-index.json — the user's OWN
      // project Material Functions. The script reads ProjectPath/EngineRoot from
      // local.config.json (same fallback as enginemf). Optional -ContentRoots
      // narrows/widens which project folders are crawled (default /Game).
      return ps('plugin-src/Scripts/Run-WorkMfIndex.ps1', opts?.contentRoots ? ['-ContentRoots', opts.contentRoots] : []);
    case 'projectmat':
      // Exports each /Game UMaterial as a T3D dump into the staging dir (the
      // Windows/Codex commandlet); the server converts the dumps after the crawl
      // (importProjectMaterials). Optional -ContentRoots narrows the /Game scan.
      return ps('plugin-src/Scripts/Run-ProjectMaterials.ps1',
        ['-StagingDir', resolve(repoRoot, PROJECTMAT_STAGING_REL), ...(opts?.contentRoots ? ['-ContentRoots', opts.contentRoots] : [])]);
  }
};

const realSpawn: SpawnImpl = (spec, cwd) => spawn(spec.command, spec.args, { cwd });

// A single emitted log line cannot exceed this; a runaway no-newline stream is
// truncated rather than growing the buffer without bound.
const LINE_BUF_CAP = 1_000_000;

// Buffer chunked stdout/stderr into whole lines; flush() emits any trailing
// partial line when the process ends. All carriage returns are stripped — UE and
// PowerShell emit bare \r progress overwrites, and the browser <pre> renders them
// as control debris rather than overwriting the line.
function lineSplitter(onLine: (line: string) => void): { push: (c: Buffer) => void; flush: () => void } {
  let buf = '';
  const clean = (s: string) => s.replace(/\r/g, '');
  return {
    push(c: Buffer) {
      buf += c.toString();
      if (buf.length > LINE_BUF_CAP) {
        onLine('[line truncated — exceeded 1 MB buffer cap]');
        const nl = buf.indexOf('\n');
        buf = nl !== -1 ? buf.slice(nl + 1) : '';
      }
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        onLine(clean(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
      }
    },
    flush() {
      if (buf.length) { onLine(clean(buf)); buf = ''; }
    },
  };
}

export interface RunnerOpts {
  spawnImpl?: SpawnImpl;
  commandFor?: CommandFor;
  timeoutMs?: number;
}

export interface CrawlRunner {
  start(kind: CrawlKind, emit: (e: CrawlEvent) => void, opts?: CrawlStartOpts): string;
  current(): CrawlStatus;
}

export function createCrawlRunner(repoRoot: string, opts: RunnerOpts = {}): CrawlRunner {
  const spawnImpl = opts.spawnImpl ?? realSpawn;
  const commandFor = opts.commandFor ?? defaultCommandFor;
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;

  let status: CrawlStatus = { status: 'idle' };
  let counter = 0;

  function start(kind: CrawlKind, emit: (e: CrawlEvent) => void, startOpts?: CrawlStartOpts): string {
    if (status.status === 'running') throw new Error('a crawl is already running');
    const jobId = `crawl-${++counter}`;
    status = { status: 'running', jobId, kind };

    const child = spawnImpl(commandFor(repoRoot, kind, startOpts), repoRoot);
    emit({ type: 'started', jobId, kind });

    const splitter = lineSplitter((line) => emit({ type: 'log', jobId, line }));
    child.stdout?.on('data', (c: Buffer) => splitter.push(c));
    child.stderr?.on('data', (c: Buffer) => splitter.push(c));

    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, timeoutMs);

    let finished = false;
    const finish = (exitCode: number | null) => {
      if (finished) return;      // 'error' then 'close' must not double-emit
      finished = true;
      clearTimeout(timer);
      splitter.flush();
      const ok = exitCode === 0;
      status = { status: ok ? 'success' : 'error', jobId, kind, exitCode };
      emit({ type: 'done', jobId, status: ok ? 'success' : 'error', exitCode });
    };

    child.on('error', (err) => { emit({ type: 'log', jobId, line: `spawn error: ${err.message}` }); finish(null); });
    child.on('close', (code) => finish(code));
    return jobId;
  }

  return { start, current: () => status };
}

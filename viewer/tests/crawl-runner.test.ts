import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { createCrawlRunner, defaultCommandFor, type CrawlEvent, type CommandFor } from '../server/crawl-runner';

// Drive the runner with a real `node -e` subprocess as the mock crawl, so the
// spawn plumbing, line splitting, and exit handling are all genuinely exercised
// off-Windows. The real powershell command path is verified separately on Windows.
const NODE = process.execPath;

function runToDone(runner: ReturnType<typeof createCrawlRunner>, kind: 'export' | 'enginemf' | 'workmf' | 'projectmat'): Promise<CrawlEvent[]> {
  return new Promise((res) => {
    const events: CrawlEvent[] = [];
    runner.start(kind, (e) => { events.push(e); if (e.type === 'done') res(events); });
  });
}
const logs = (events: CrawlEvent[]) => events.filter((e): e is Extract<CrawlEvent, { type: 'log' }> => e.type === 'log').map((e) => e.line);
const done = (events: CrawlEvent[]) => events.at(-1) as Extract<CrawlEvent, { type: 'done' }>;

describe('createCrawlRunner', () => {
  it('streams stdout/stderr lines and reports success on exit 0', async () => {
    const commandFor: CommandFor = () => ({ command: NODE, args: ['-e', "process.stdout.write('hello\\nworld\\n'); process.stderr.write('warn\\n')"] });
    const runner = createCrawlRunner(tmpdir(), { commandFor });
    const events = await runToDone(runner, 'export');

    expect(events[0]).toMatchObject({ type: 'started', kind: 'export' });
    expect(logs(events)).toEqual(expect.arrayContaining(['hello', 'world', 'warn']));
    expect(done(events)).toMatchObject({ type: 'done', status: 'success', exitCode: 0 });
    expect(runner.current().status).toBe('success');
  });

  it('reports error on a non-zero exit', async () => {
    const commandFor: CommandFor = () => ({ command: NODE, args: ['-e', 'process.exit(3)'] });
    const runner = createCrawlRunner(tmpdir(), { commandFor });
    const d = done(await runToDone(runner, 'export'));
    expect(d.status).toBe('error');
    expect(d.exitCode).toBe(3);
  });

  it('reports an empty WorkMF crawl as an error even when the command exits 0', async () => {
    const commandFor: CommandFor = () => ({ command: NODE, args: ['-e', "process.stdout.write('Wrote work-MF index: out (0 function(s), 0 load failure(s))\\n')"] });
    const runner = createCrawlRunner(tmpdir(), { commandFor });
    const events = await runToDone(runner, 'workmf');
    const d = done(events);
    expect(d.status).toBe('error');
    expect(logs(events)).toContain('crawl found no project Material Functions; check the Content Route.');
  });

  it('reports an empty project-material crawl as an error even when the command exits 0', async () => {
    const commandFor: CommandFor = () => ({ command: NODE, args: ['-e', "process.stdout.write('Project materials staged: staging (0 material(s), 0 function(s), 0 failure(s))\\n')"] });
    const runner = createCrawlRunner(tmpdir(), { commandFor });
    const events = await runToDone(runner, 'projectmat');
    const d = done(events);
    expect(d.status).toBe('error');
    expect(logs(events)).toContain('crawl found no project materials; check the Content Route.');
  });

  it('strips carriage returns from progress-style output', async () => {
    // UE/PowerShell emit bare \r progress overwrites — the log must not carry them.
    const commandFor: CommandFor = () => ({ command: NODE, args: ['-e', "process.stdout.write('A...10%\\rA...50%\\rA...100%\\n')"] });
    const runner = createCrawlRunner(tmpdir(), { commandFor });
    const out = logs(await runToDone(runner, 'export'));
    expect(out).toContain('A...10%A...50%A...100%');
    expect(out.some((l) => l.includes('\r'))).toBe(false);
  });

  it('reports error (and a spawn-error log) when the command cannot launch', async () => {
    const commandFor: CommandFor = () => ({ command: 'definitely-not-a-real-binary-zzz', args: [] });
    const runner = createCrawlRunner(tmpdir(), { commandFor });
    const events = await runToDone(runner, 'export');
    expect(done(events).status).toBe('error');
    expect(logs(events).some((l) => /spawn error/.test(l))).toBe(true);
  });

  it('maps each crawl kind to its PowerShell entrypoint (Windows)', () => {
    const cmd = (k: 'export' | 'enginemf' | 'workmf') => defaultCommandFor('/repo', k, undefined, 'win32');
    expect(cmd('export').command).toBe('powershell');
    expect(cmd('export').args.join(' ')).toMatch(/Invoke-NodeT3DMetadataMaintenance\.ps1.*-SkipViewerTests/);
    expect(cmd('enginemf').args.join(' ')).toMatch(/Run-EngineMfIndex\.ps1/);
    expect(cmd('workmf').args.join(' ')).toMatch(/Run-WorkMfIndex\.ps1/);
  });

  it('runs the same .ps1 entrypoints under pwsh on macOS (no -ExecutionPolicy)', () => {
    const cmd = defaultCommandFor('/repo', 'workmf', undefined, 'darwin');
    expect(cmd.command).toBe('pwsh');
    expect(cmd.args).toEqual(expect.arrayContaining(['-NoProfile', '-File']));
    expect(cmd.args).not.toContain('-ExecutionPolicy');
    expect(cmd.args.join(' ')).toMatch(/Run-WorkMfIndex\.ps1/);
    // contentRoots still threads through on darwin
    expect(defaultCommandFor('/repo', 'workmf', { contentRoots: '/Game/M' }, 'darwin').args).toContain('-ContentRoots');
  });

  it('maps the projectmat crawl to Run-ProjectMaterials.ps1 with a staging dir', () => {
    const cmd = defaultCommandFor('/repo', 'projectmat');
    expect(cmd.args.join(' ')).toMatch(/Run-ProjectMaterials\.ps1/);
    expect(cmd.args).toContain('-StagingDir');
    expect(defaultCommandFor('/repo', 'projectmat', { contentRoots: '/Game/Mats' }).args).toContain('-ContentRoots');
  });

  it('passes -ContentRoots to the workmf crawl only when given', () => {
    expect(defaultCommandFor('/repo', 'workmf').args).not.toContain('-ContentRoots');
    const withRoots = defaultCommandFor('/repo', 'workmf', { contentRoots: '/Game/Materials,/MyPlugin' });
    const i = withRoots.args.indexOf('-ContentRoots');
    expect(i).toBeGreaterThan(-1);
    expect(withRoots.args[i + 1]).toBe('/Game/Materials,/MyPlugin');
    // contentRoots is workmf-only — it must not leak into the other kinds.
    expect(defaultCommandFor('/repo', 'export', { contentRoots: '/Game' }).args).not.toContain('-ContentRoots');
  });

  it('maps export, enginemf, and projectmat to pwsh on macOS (no -ExecutionPolicy)', () => {
    const exportCmd = defaultCommandFor('/repo', 'export', undefined, 'darwin');
    expect(exportCmd.command).toBe('pwsh');
    expect(exportCmd.args).toEqual(expect.arrayContaining(['-NoProfile', '-File']));
    expect(exportCmd.args).not.toContain('-ExecutionPolicy');
    expect(exportCmd.args.join(' ')).toMatch(/Invoke-NodeT3DMetadataMaintenance\.ps1/);

    const enginemfCmd = defaultCommandFor('/repo', 'enginemf', undefined, 'darwin');
    expect(enginemfCmd.command).toBe('pwsh');
    expect(enginemfCmd.args).toEqual(expect.arrayContaining(['-NoProfile', '-File']));
    expect(enginemfCmd.args).not.toContain('-ExecutionPolicy');
    expect(enginemfCmd.args.join(' ')).toMatch(/Run-EngineMfIndex\.ps1/);

    const projectmatCmd = defaultCommandFor('/repo', 'projectmat', undefined, 'darwin');
    expect(projectmatCmd.command).toBe('pwsh');
    expect(projectmatCmd.args).toEqual(expect.arrayContaining(['-NoProfile', '-File']));
    expect(projectmatCmd.args).not.toContain('-ExecutionPolicy');
    expect(projectmatCmd.args.join(' ')).toMatch(/Run-ProjectMaterials\.ps1/);
    expect(projectmatCmd.args).toContain('-StagingDir');
  });

  it('rejects a second crawl while one is running (single-job lock)', async () => {
    const commandFor: CommandFor = () => ({ command: NODE, args: ['-e', 'setTimeout(() => {}, 300)'] });
    const runner = createCrawlRunner(tmpdir(), { commandFor });
    const finished = runToDone(runner, 'export');
    expect(() => runner.start('enginemf', () => {})).toThrow(/already running/);
    await finished;
    expect(runner.current().status).toBe('success');
  });

  it('cancel() returns false when idle (no crawl running)', () => {
    const commandFor: CommandFor = () => ({ command: NODE, args: ['-e', 'setTimeout(() => {}, 300)'] });
    const runner = createCrawlRunner(tmpdir(), { commandFor });
    expect(runner.cancel()).toBe(false);
  });

  it('cancel() returns true, kills the child, and emits a done error event', async () => {
    const commandFor: CommandFor = () => ({ command: NODE, args: ['-e', 'setTimeout(() => {}, 5000)'] });
    const runner = createCrawlRunner(tmpdir(), { commandFor });

    let killCalled = false;
    const events: CrawlEvent[] = [];
    const donePromise = new Promise<void>((resolve) => {
      runner.start('export', (e) => {
        events.push(e);
        if (e.type === 'done') resolve();
      });
    });

    // Give the child a chance to actually start
    await new Promise<void>((r) => setTimeout(r, 50));
    const result = runner.cancel();
    expect(result).toBe(true);

    await donePromise;
    const doneEvent = events.find(e => e.type === 'done') as Extract<CrawlEvent, { type: 'done' }> | undefined;
    expect(doneEvent).toBeDefined();
    expect(doneEvent?.status).toBe('error');
  });

  it('cancel() returns false after a crawl has already finished', async () => {
    const commandFor: CommandFor = () => ({ command: NODE, args: ['-e', 'process.exit(0)'] });
    const runner = createCrawlRunner(tmpdir(), { commandFor });
    await runToDone(runner, 'export');
    expect(runner.cancel()).toBe(false);
  });
});

describe('lastLog', () => {
  it('is null before any crawl, then holds the finished crawl tail (success and error)', async () => {
    const commandFor: CommandFor = () => ({ command: NODE, args: ['-e', "process.stdout.write('hello\\n'); process.exit(2)"] });
    const runner = createCrawlRunner(tmpdir(), { commandFor });
    expect(runner.lastLog()).toBeNull();
    await runToDone(runner, 'workmf');
    const snap = runner.lastLog();
    expect(snap).toMatchObject({ kind: 'workmf', status: 'error', exitCode: 2 });
    expect(snap!.lines).toContain('hello');
  });
});

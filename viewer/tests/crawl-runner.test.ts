import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { createCrawlRunner, type CrawlEvent, type CommandFor } from '../server/crawl-runner';

// Drive the runner with a real `node -e` subprocess as the mock crawl, so the
// spawn plumbing, line splitting, and exit handling are all genuinely exercised
// off-Windows. The real powershell command path is verified separately on Windows.
const NODE = process.execPath;

function runToDone(runner: ReturnType<typeof createCrawlRunner>, kind: 'export' | 'enginemf'): Promise<CrawlEvent[]> {
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
    const runner = createCrawlRunner(tmpdir(), { commandFor, changedFilesFor: () => ['agent-pack/x.json'] });
    const events = await runToDone(runner, 'export');

    expect(events[0]).toMatchObject({ type: 'started', kind: 'export' });
    expect(logs(events)).toEqual(expect.arrayContaining(['hello', 'world', 'warn']));
    expect(done(events)).toMatchObject({ type: 'done', status: 'success', exitCode: 0, changedFiles: ['agent-pack/x.json'] });
    expect(runner.current().status).toBe('success');
  });

  it('reports error and no changedFiles on a non-zero exit', async () => {
    const commandFor: CommandFor = () => ({ command: NODE, args: ['-e', 'process.exit(3)'] });
    const runner = createCrawlRunner(tmpdir(), { commandFor, changedFilesFor: () => ['agent-pack/x.json'] });
    const d = done(await runToDone(runner, 'export'));
    expect(d.status).toBe('error');
    expect(d.exitCode).toBe(3);
    expect(d.changedFiles).toEqual([]);
  });

  it('reports error (and a spawn-error log) when the command cannot launch', async () => {
    const commandFor: CommandFor = () => ({ command: 'definitely-not-a-real-binary-zzz', args: [] });
    const runner = createCrawlRunner(tmpdir(), { commandFor });
    const events = await runToDone(runner, 'export');
    expect(done(events).status).toBe('error');
    expect(logs(events).some((l) => /spawn error/.test(l))).toBe(true);
  });

  it('rejects a second crawl while one is running (single-job lock)', async () => {
    const commandFor: CommandFor = () => ({ command: NODE, args: ['-e', 'setTimeout(() => {}, 300)'] });
    const runner = createCrawlRunner(tmpdir(), { commandFor });
    const finished = runToDone(runner, 'export');
    expect(() => runner.start('enginemf', () => {})).toThrow(/already running/);
    await finished;
    expect(runner.current().status).toBe('success');
  });
});

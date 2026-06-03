const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Guards the CLI exit-code contract that callers (the PowerShell runners'
// Invoke-External, CI) depend on. These cases all resolve in parseArgs before
// any file read, so they need no agent-pack fixtures. Uses process.execPath so
// it runs under whatever Node invoked the test (Node 22 in CI, 24 locally).
const SCRIPT = path.join(__dirname, '..', 'build-db-candidates.js');

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('--help exits 0 and prints usage', () => {
  const r = run('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Usage:/);
});

test('an unknown flag exits 1', () => {
  const r = run('--bogus');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown argument: --bogus/);
});

test('a flag missing its value exits 1', () => {
  const r = run('--db');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Missing value for --db/);
});

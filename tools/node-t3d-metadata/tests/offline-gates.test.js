const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

// Guards the committed artifacts at test time, not just in CI. Both scripts
// default to --workflow-root = <script>/../.. but we pass it explicitly so the
// invocation is self-documenting and robust wherever the process cwd lands.
const WORKFLOW_ROOT = path.resolve(__dirname, '..', '..', '..');
const AUDIT_SCRIPT = path.join(__dirname, '..', 'audit-export-meta.js');
const PURITY_SCRIPT = path.join(__dirname, '..', 'check-public-purity.js');

function run(script, ...args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('audit-export-meta exits 0 against the committed repo', () => {
  const r = run(AUDIT_SCRIPT, '--workflow-root', WORKFLOW_ROOT);
  assert.equal(
    r.status,
    0,
    `audit-export-meta.js failed (exit ${r.status}):\n${r.stderr || r.stdout}`,
  );
});

test('check-public-purity exits 0 against the committed repo', () => {
  const r = run(PURITY_SCRIPT, '--workflow-root', WORKFLOW_ROOT);
  assert.equal(
    r.status,
    0,
    `check-public-purity.js failed (exit ${r.status}):\n${r.stderr || r.stdout}`,
  );
});

// Layout guard: every known test file must be present so validate-tooling.js
// and this very file can find them. This is existence-based — it does not
// assert an exact count, so adding new test files never breaks this check.
const KNOWN_TEST_FILES = [
  'audit.test.js',
  'build-db-candidates.test.js',
  'cli.test.js',
  'heal-export-meta.test.js',
  'check-public-purity.test.js',
  'offline-gates.test.js',
  'official-node-coverage.test.js',
  'sync-stress-node-coverage.test.js',
];

test('all known test files exist in tests/', () => {
  for (const name of KNOWN_TEST_FILES) {
    const full = path.join(__dirname, name);
    assert.ok(fs.existsSync(full), `Expected test file missing: tests/${name}`);
  }
});

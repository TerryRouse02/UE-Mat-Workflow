'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', '..', 'agent-pack', 'query.js');

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

// Tiny fixture data — generic names only, no private/project strings.
const FIXTURE_NODES = {
  schemaVersion: '1.0',
  ueVersion: '9.9',
  generatedAt: '1970-01-01',
  source: 'test fixture',
  reservedTypes: ['MaterialOutput', 'FunctionInput', 'FunctionOutput', 'MaterialFunctionCall'],
  nodes: {
    // A normal verified node
    ScalarOp: {
      category: 'Math',
      description: 'A generic scalar operation. Returns the result.',
      inputs: [{ name: 'A', type: 'Float1', required: true }],
      outputs: [{ name: 'Result', type: 'Float1' }],
      params: [],
      verified: true,
    },
    // A node with dynamicPins
    FlexNode: {
      category: 'Utility',
      description: 'A flexible node with dynamic pins. Fully configurable.',
      inputs: [],
      outputs: [{ name: 'Output', type: 'matchOutputType' }],
      params: [],
      verified: true,
      dynamicPins: true,
    },
    // An unverified node
    DraftOp: {
      category: 'Math',
      description: 'A draft math operation. Not yet verified.',
      inputs: [{ name: 'X', type: 'Float1' }],
      outputs: [{ name: 'Result', type: 'Float1' }],
      params: [],
      // verified intentionally absent
    },
  },
};

const FIXTURE_ENGINE_MF = {
  schemaVersion: '1.0',
  kind: 'workmf-index',
  ueVersion: '9.9',
  functions: {
    '/Engine/Functions/MF_Example.MF_Example': {
      assetPath: '/Engine/Functions/MF_Example.MF_Example',
      displayName: 'MF_Example',
      category: '/Engine/Functions',
      inputs: [{ name: 'Color', type: 'Float3', index: 0 }],
      outputs: [{ name: 'Result', type: 'Float3', index: 0 }],
      missing: false,
    },
  },
};

const FIXTURE_WORK_MF = {
  schemaVersion: '1.0',
  kind: 'workmf-index',
  ueVersion: '9.9',
  functions: {
    '/Game/Functions/MF_Example.MF_Example': {
      assetPath: '/Game/Functions/MF_Example.MF_Example',
      displayName: 'MF_Example',
      category: '/Game/Functions',
      inputs: [{ name: 'Amount', type: 'Float1', index: 0 }],
      outputs: [{ name: 'Result', type: 'Float3', index: 0 }],
      missing: false,
    },
  },
};

// Create the temp fixture directory once for all tests in this file.
const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'query-cli-test-'));
fs.writeFileSync(
  path.join(FIXTURE_DIR, 'nodes-ue9.9.json'),
  JSON.stringify(FIXTURE_NODES, null, 2),
);
fs.writeFileSync(
  path.join(FIXTURE_DIR, 'enginemf-index-ue9.9.json'),
  JSON.stringify(FIXTURE_ENGINE_MF, null, 2),
);
fs.writeFileSync(
  path.join(FIXTURE_DIR, 'workmf-index.json'),
  JSON.stringify(FIXTURE_WORK_MF, null, 2),
);

// Cleanup after all tests.
test.after(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function run(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, UEMAT_AGENT_PACK_DIR: FIXTURE_DIR },
  });
}

function runReal(...args) {
  // No UEMAT_AGENT_PACK_DIR override — uses real agent-pack dir.
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// Tests: help / usage
// ---------------------------------------------------------------------------

test('--help exits 0 and prints usage', () => {
  const r = run('--help');
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Usage:/);
});

test('-h exits 0 and prints usage', () => {
  const r = run('-h');
  assert.equal(r.status, 0);
  assert.match(r.stderr, /Usage:/);
});

test('no args exits 1 and prints usage', () => {
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage:/);
});

test('unknown subcommand exits 1 and prints usage', () => {
  const r = run('bogus');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage:/);
});

// ---------------------------------------------------------------------------
// Tests: node subcommand — version not found
// ---------------------------------------------------------------------------

test('node: unknown version exits 1 with available versions', () => {
  const r = run('node', '0.0', 'ScalarOp');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /9\.9/); // fixture version mentioned
});

// ---------------------------------------------------------------------------
// Tests: node subcommand — happy path (multiple names)
// ---------------------------------------------------------------------------

test('node: returns exact match entry for a single name', () => {
  const r = run('node', '9.9', 'ScalarOp');
  assert.equal(r.status, 0);
  assert.equal(r.stderr.trim(), '');
  const out = JSON.parse(r.stdout);
  assert.ok(out.ScalarOp);
  assert.equal(out.ScalarOp.category, 'Math');
});

test('node: returns multiple names in one JSON object', () => {
  const r = run('node', '9.9', 'ScalarOp', 'FlexNode');
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.ok(out.ScalarOp);
  assert.ok(out.FlexNode);
});

// ---------------------------------------------------------------------------
// Tests: node subcommand — case-insensitive fallback
// ---------------------------------------------------------------------------

test('node: case-insensitive fallback returns entry and prints stderr note', () => {
  const r = run('node', '9.9', 'scalarop');
  assert.equal(r.status, 0);
  assert.match(r.stderr, /canonical casing/i);
  const out = JSON.parse(r.stdout);
  // The result is keyed under the requested (wrong-case) name
  assert.ok(out.scalarop);
  assert.equal(out.scalarop.category, 'Math');
});

// ---------------------------------------------------------------------------
// Tests: node subcommand — reserved types
// ---------------------------------------------------------------------------

test('node: reserved type returns reserved flag and note', () => {
  const r = run('node', '9.9', 'MaterialOutput');
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.MaterialOutput.reserved, true);
  assert.match(out.MaterialOutput.note, /Reserved type/);
  assert.match(out.MaterialOutput.note, /SPEC\.md/);
});

test('node: reserved type mixed with known node both appear', () => {
  const r = run('node', '9.9', 'FunctionInput', 'ScalarOp');
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.FunctionInput.reserved, true);
  assert.ok(out.ScalarOp);
});

// ---------------------------------------------------------------------------
// Tests: node subcommand — unknown name, exit 1, suggestion
// ---------------------------------------------------------------------------

test('node: unknown name exits 1', () => {
  const r = run('node', '9.9', 'NoSuchNode');
  assert.equal(r.status, 1);
});

test('node: partial match of unknown name gives suggestions on stderr', () => {
  // "scalar" is a substring of "ScalarOp"
  const r = run('node', '9.9', 'scalar');
  assert.equal(r.status, 1);
  // Should suggest ScalarOp
  assert.match(r.stderr, /ScalarOp/);
});

test('node: one unknown + one known returns known in stdout, exits 1', () => {
  const r = run('node', '9.9', 'ScalarOp', 'DoesNotExist');
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.ok(out.ScalarOp, 'Known name should appear in output');
  assert.equal(out.DoesNotExist, undefined);
});

// ---------------------------------------------------------------------------
// Tests: mf subcommand — /Engine/ path hit
// ---------------------------------------------------------------------------

test('mf: /Engine/ path returns matching entry, exits 0', () => {
  const r = run('mf', '/Engine/Functions/MF_Example.MF_Example');
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.displayName, 'MF_Example');
  assert.equal(out.assetPath, '/Engine/Functions/MF_Example.MF_Example');
});

test('mf: /Engine/ path with explicit version returns entry', () => {
  const r = run('mf', '/Engine/Functions/MF_Example.MF_Example', '9.9');
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.displayName, 'MF_Example');
});

// ---------------------------------------------------------------------------
// Tests: mf subcommand — /Game/ path hit
// ---------------------------------------------------------------------------

test('mf: /Game/ path returns matching workmf entry, exits 0', () => {
  const r = run('mf', '/Game/Functions/MF_Example.MF_Example');
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.displayName, 'MF_Example');
  assert.equal(out.assetPath, '/Game/Functions/MF_Example.MF_Example');
});

// ---------------------------------------------------------------------------
// Tests: mf subcommand — miss → exit 1 + crawl message
// ---------------------------------------------------------------------------

test('mf: /Engine/ miss exits 1 with crawl message', () => {
  const r = run('mf', '/Engine/Functions/MF_NotHere.MF_NotHere');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Engine MF index/);
  assert.match(r.stderr, /crawl/i);
  assert.match(r.stderr, /do not invent pin names/i);
});

test('mf: /Game/ miss exits 1 with crawl message', () => {
  const r = run('mf', '/Game/Functions/MF_NotHere.MF_NotHere');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /WorkMF index/);
  assert.match(r.stderr, /crawl/i);
  assert.match(r.stderr, /do not invent pin names/i);
});

// ---------------------------------------------------------------------------
// Tests: mf subcommand — workmf-index.json absent → exit 1
// ---------------------------------------------------------------------------

test('mf: /Game/ path with absent workmf-index.json exits 1', () => {
  // Create a fixture dir without workmf-index.json
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-cli-nowork-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'nodes-ue9.9.json'),
      JSON.stringify(FIXTURE_NODES, null, 2),
    );
    fs.writeFileSync(
      path.join(dir, 'enginemf-index-ue9.9.json'),
      JSON.stringify(FIXTURE_ENGINE_MF, null, 2),
    );
    // workmf-index.json intentionally not written
    const r = spawnSync(
      process.execPath,
      [SCRIPT, 'mf', '/Game/Functions/MF_Example.MF_Example'],
      { encoding: 'utf8', env: { ...process.env, UEMAT_AGENT_PACK_DIR: dir } },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /WorkMF index/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests: search subcommand
// ---------------------------------------------------------------------------

test('search: finds node matching single term', () => {
  const r = run('search', '9.9', 'math');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /ScalarOp/);
  assert.match(r.stderr, /match/);
});

test('search: filters by multiple terms (AND logic)', () => {
  const r = run('search', '9.9', 'math', 'draft');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /DraftOp/);
  // ScalarOp is math but has no "draft" in name/category/description
  assert.doesNotMatch(r.stdout, /ScalarOp/);
});

test('search: dynamicPins marker appears for FlexNode', () => {
  const r = run('search', '9.9', 'utility');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /FlexNode/);
  assert.match(r.stdout, /\(dynamicPins\)/);
});

test('search: unverified marker appears for DraftOp', () => {
  const r = run('search', '9.9', 'draftop');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\(unverified\)/);
});

test('search: zero matches exits 0 with count 0', () => {
  const r = run('search', '9.9', 'xyzzy_nonexistent_term_9876');
  assert.equal(r.status, 0);
  assert.match(r.stderr, /0 match/);
});

test('search: results are sorted by name', () => {
  // Both ScalarOp and DraftOp are in Math category
  const r = run('search', '9.9', 'math');
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  const names = lines.map((l) => l.split(/\s+/)[0]);
  const sorted = [...names].sort();
  assert.deepEqual(names, sorted);
});

test('search: output line format is Name  [Category]  first-sentence', () => {
  const r = run('search', '9.9', 'scalarop');
  assert.equal(r.status, 0);
  // Format: "ScalarOp  [Math]  <first sentence>"
  assert.match(r.stdout, /ScalarOp\s+\[Math\]/);
});

test('search: unknown version exits 1', () => {
  const r = run('search', '0.0', 'math');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /9\.9/);
});

// ---------------------------------------------------------------------------
// Smoke test: real agent-pack data
// ---------------------------------------------------------------------------

test('smoke: real node 5.7 Multiply returns entry with A and B inputs', () => {
  const r = runReal('node', '5.7', 'Multiply');
  assert.equal(r.status, 0, `Expected exit 0, got ${r.status}. stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.ok(out.Multiply, 'Multiply key must be present');
  const inputNames = (out.Multiply.inputs || []).map((i) => i.name);
  assert.ok(inputNames.includes('A'), 'Multiply must have input A');
  assert.ok(inputNames.includes('B'), 'Multiply must have input B');
});

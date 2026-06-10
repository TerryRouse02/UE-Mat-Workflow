'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lib = require('../../../agent-pack/query-lib.js');

// ---------------------------------------------------------------------------
// Fixture setup (same fixture data as query-cli.test.js)
// ---------------------------------------------------------------------------

const FIXTURE_NODES = {
  schemaVersion: '1.0',
  ueVersion: '9.9',
  generatedAt: '1970-01-01',
  source: 'test fixture',
  reservedTypes: ['MaterialOutput', 'FunctionInput', 'FunctionOutput', 'MaterialFunctionCall'],
  nodes: {
    ScalarOp: {
      category: 'Math',
      description: 'A generic scalar operation. Returns the result.',
      inputs: [{ name: 'A', type: 'Float1', required: true }],
      outputs: [{ name: 'Result', type: 'Float1' }],
      params: [],
      verified: true,
    },
    FlexNode: {
      category: 'Utility',
      description: 'A flexible node with dynamic pins. Fully configurable.',
      inputs: [],
      outputs: [{ name: 'Output', type: 'matchOutputType' }],
      params: [],
      verified: true,
      dynamicPins: true,
    },
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

const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'query-lib-test-'));
fs.writeFileSync(
  path.join(FIXTURE_DIR, 'nodes-ue9.9.json'),
  JSON.stringify(FIXTURE_NODES, null, 2),
);
fs.writeFileSync(
  path.join(FIXTURE_DIR, 'enginemf-index-ue9.9.json'),
  JSON.stringify(FIXTURE_ENGINE_MF, null, 2),
);
const WORK_MF_PATH = path.join(FIXTURE_DIR, 'workmf-index.json');
fs.writeFileSync(WORK_MF_PATH, JSON.stringify(FIXTURE_WORK_MF, null, 2));

test.after(() => {
  fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// discoverVersions
// ---------------------------------------------------------------------------

test('discoverVersions: returns fixture version 9.9', () => {
  const versions = lib.discoverVersions(FIXTURE_DIR);
  assert.ok(Array.isArray(versions));
  assert.ok(versions.includes('9.9'));
});

test('discoverVersions: does not include .export.json or .index.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-lib-ver-'));
  try {
    fs.writeFileSync(path.join(dir, 'nodes-ue1.0.json'), '{}');
    fs.writeFileSync(path.join(dir, 'nodes-ue1.0.export.json'), '{}');
    fs.writeFileSync(path.join(dir, 'nodes-ue1.0.index.json'), '{}');
    const versions = lib.discoverVersions(dir);
    assert.deepEqual(versions, ['1.0']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverVersions: returns empty array for missing directory', () => {
  const versions = lib.discoverVersions('/nonexistent/dir/xyzzy');
  assert.deepEqual(versions, []);
});

test('discoverVersions: returns sorted versions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-lib-sorted-'));
  try {
    fs.writeFileSync(path.join(dir, 'nodes-ue5.7.json'), '{}');
    fs.writeFileSync(path.join(dir, 'nodes-ue5.6.json'), '{}');
    const versions = lib.discoverVersions(dir);
    assert.deepEqual(versions, ['5.6', '5.7']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// searchNodes — shape
// ---------------------------------------------------------------------------

test('searchNodes: returns match with expected shape fields', () => {
  const results = lib.searchNodes(FIXTURE_DIR, '9.9', ['math']);
  assert.ok(results.length > 0);
  const r = results[0];
  assert.ok(typeof r.name === 'string');
  assert.ok(typeof r.category === 'string');
  assert.ok(typeof r.desc === 'string');
  assert.ok(typeof r.verified === 'boolean');
  assert.ok(typeof r.deprecated === 'boolean');
  assert.ok(typeof r.dynamicPins === 'boolean');
  assert.ok(typeof r.line === 'string');
});

test('searchNodes: verified flag is true for ScalarOp', () => {
  const results = lib.searchNodes(FIXTURE_DIR, '9.9', ['scalarop']);
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'ScalarOp');
  assert.equal(results[0].verified, true);
});

test('searchNodes: unverified flag is false for DraftOp', () => {
  const results = lib.searchNodes(FIXTURE_DIR, '9.9', ['draftop']);
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'DraftOp');
  assert.equal(results[0].verified, false);
});

test('searchNodes: dynamicPins flag is true for FlexNode', () => {
  const results = lib.searchNodes(FIXTURE_DIR, '9.9', ['flexnode']);
  assert.equal(results.length, 1);
  assert.equal(results[0].dynamicPins, true);
});

test('searchNodes: AND logic — both terms must match', () => {
  const all = lib.searchNodes(FIXTURE_DIR, '9.9', ['math']);
  const filtered = lib.searchNodes(FIXTURE_DIR, '9.9', ['math', 'draft']);
  assert.ok(filtered.length < all.length);
  assert.ok(filtered.some((r) => r.name === 'DraftOp'));
  assert.ok(!filtered.some((r) => r.name === 'ScalarOp'));
});

test('searchNodes: results are sorted by name', () => {
  const results = lib.searchNodes(FIXTURE_DIR, '9.9', ['math']);
  const names = results.map((r) => r.name);
  assert.deepEqual(names, [...names].sort());
});

test('searchNodes: throws for unknown version', () => {
  assert.throws(() => lib.searchNodes(FIXTURE_DIR, '0.0', ['math']), /No node DB/);
});

test('searchNodes: zero matches returns empty array', () => {
  const results = lib.searchNodes(FIXTURE_DIR, '9.9', ['xyzzy_nonexistent_9876']);
  assert.deepEqual(results, []);
});

// ---------------------------------------------------------------------------
// getNodes — hit + miss with suggestions
// ---------------------------------------------------------------------------

test('getNodes: hit returns full DB entry', () => {
  const { result, suggestions } = lib.getNodes(FIXTURE_DIR, '9.9', ['ScalarOp']);
  assert.ok(result.ScalarOp);
  assert.equal(result.ScalarOp.category, 'Math');
  assert.deepEqual(suggestions, {});
});

test('getNodes: multiple hits all present in result', () => {
  const { result } = lib.getNodes(FIXTURE_DIR, '9.9', ['ScalarOp', 'FlexNode']);
  assert.ok(result.ScalarOp);
  assert.ok(result.FlexNode);
});

test('getNodes: reserved type returns reserved stub', () => {
  const { result } = lib.getNodes(FIXTURE_DIR, '9.9', ['MaterialOutput']);
  assert.equal(result.MaterialOutput.reserved, true);
  assert.match(result.MaterialOutput.note, /Reserved type/);
  assert.match(result.MaterialOutput.note, /SPEC\.md/);
});

test('getNodes: miss populates suggestions map', () => {
  const { result, suggestions } = lib.getNodes(FIXTURE_DIR, '9.9', ['scalar']);
  assert.equal(result.scalar, undefined);
  assert.ok(Array.isArray(suggestions.scalar));
  assert.ok(suggestions.scalar.includes('ScalarOp'));
});

test('getNodes: unknown name with no suggestions has empty suggestions array', () => {
  const { result, suggestions } = lib.getNodes(FIXTURE_DIR, '9.9', ['xyzzy_totally_unknown_9876']);
  assert.equal(result.xyzzy_totally_unknown_9876, undefined);
  assert.ok(Array.isArray(suggestions.xyzzy_totally_unknown_9876));
});

test('getNodes: mixed hit and miss — hit in result, miss in suggestions', () => {
  const { result, suggestions } = lib.getNodes(FIXTURE_DIR, '9.9', ['ScalarOp', 'NoSuch']);
  assert.ok(result.ScalarOp);
  assert.equal(result.NoSuch, undefined);
  assert.ok(Array.isArray(suggestions.NoSuch));
});

test('getNodes: case-insensitive fallback returns entry under original name', () => {
  const { result } = lib.getNodes(FIXTURE_DIR, '9.9', ['scalarop']);
  assert.ok(result.scalarop);
  assert.equal(result.scalarop.category, 'Math');
});

test('getNodes: throws for unknown version', () => {
  assert.throws(() => lib.getNodes(FIXTURE_DIR, '0.0', ['ScalarOp']), /No node DB/);
});

// ---------------------------------------------------------------------------
// getMf — engine hit
// ---------------------------------------------------------------------------

test('getMf: engine path hit returns found=true with entry', () => {
  const r = lib.getMf(FIXTURE_DIR, '/Engine/Functions/MF_Example.MF_Example', '9.9', WORK_MF_PATH);
  assert.equal(r.found, true);
  assert.equal(r.entry.displayName, 'MF_Example');
  assert.equal(r.entry.assetPath, '/Engine/Functions/MF_Example.MF_Example');
});

test('getMf: engine path auto-detects single version when version omitted', () => {
  const r = lib.getMf(FIXTURE_DIR, '/Engine/Functions/MF_Example.MF_Example', null, WORK_MF_PATH);
  assert.equal(r.found, true);
  assert.equal(r.entry.displayName, 'MF_Example');
});

test('getMf: engine path miss returns found=false reason=not-in-index kind=engine', () => {
  const r = lib.getMf(FIXTURE_DIR, '/Engine/Functions/MF_NotHere.MF_NotHere', '9.9', WORK_MF_PATH);
  assert.equal(r.found, false);
  assert.equal(r.reason, 'not-in-index');
  assert.equal(r.kind, 'engine');
});

test('getMf: engine index absent returns found=false reason=index-absent kind=engine', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'query-lib-noeng-'));
  try {
    const r = lib.getMf(emptyDir, '/Engine/Functions/MF_Example.MF_Example', '9.9', WORK_MF_PATH);
    assert.equal(r.found, false);
    assert.equal(r.reason, 'index-absent');
    assert.equal(r.kind, 'engine');
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// getMf — work hit
// ---------------------------------------------------------------------------

test('getMf: work path hit returns found=true with entry', () => {
  const r = lib.getMf(FIXTURE_DIR, '/Game/Functions/MF_Example.MF_Example', '9.9', WORK_MF_PATH);
  assert.equal(r.found, true);
  assert.equal(r.entry.displayName, 'MF_Example');
  assert.equal(r.entry.assetPath, '/Game/Functions/MF_Example.MF_Example');
});

// ---------------------------------------------------------------------------
// getMf — not-in-index
// ---------------------------------------------------------------------------

test('getMf: work path miss returns found=false reason=not-in-index kind=work', () => {
  const r = lib.getMf(FIXTURE_DIR, '/Game/Functions/MF_NotHere.MF_NotHere', '9.9', WORK_MF_PATH);
  assert.equal(r.found, false);
  assert.equal(r.reason, 'not-in-index');
  assert.equal(r.kind, 'work');
});

// ---------------------------------------------------------------------------
// getMf — index-file-absent (work)
// ---------------------------------------------------------------------------

test('getMf: work index absent returns found=false reason=index-absent kind=work', () => {
  const missingPath = path.join(os.tmpdir(), 'nonexistent-workmf-index-xyzzy.json');
  const r = lib.getMf(FIXTURE_DIR, '/Game/Functions/MF_Example.MF_Example', '9.9', missingPath);
  assert.equal(r.found, false);
  assert.equal(r.reason, 'index-absent');
  assert.equal(r.kind, 'work');
});

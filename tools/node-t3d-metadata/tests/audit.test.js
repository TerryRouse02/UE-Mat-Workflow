const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { audit } = require('../audit-export-meta');
const { fileNames } = require('../version');

// --- fixture helpers -------------------------------------------------------

// A reserved block satisfying the audit's required reserved keys with valid shapes.
function reservedOk() {
  const entry = (ueClass) => ({ ueClass, inputs: {}, outputs: {}, params: {} });
  return {
    MaterialFunctionCall: entry('/Script/Engine.MaterialExpressionMaterialFunctionCall'),
    FunctionInput: entry('/Script/Engine.MaterialExpressionFunctionInput'),
    FunctionOutput: entry('/Script/Engine.MaterialExpressionFunctionOutput'),
  };
}

// A minimal valid export node: verified, well-shaped, with one input/output/param map.
function exportNodeOk() {
  return {
    ueClass: '/Script/Engine.MaterialExpressionFrac',
    inputs: { A: { index: 0 } },
    outputs: { Result: { index: 0 } },
    params: { Mode: { property: 'Mode', kind: 'enum' } },
    verified: true,
  };
}

// A matching DB node whose declared pins/params line up with exportNodeOk().
function dbNodeOk() {
  return {
    category: 'Utility',
    description: 'test node',
    inputs: [{ name: 'A', type: 'Float1|2|3|4' }],
    outputs: [{ name: 'Result', type: 'Float1|2|3|4' }],
    params: [{ name: 'Mode', type: 'Enum' }],
    verified: true,
  };
}

// Write a workflowRoot under tmpdir with the given db/export objects, return its path.
function makeRoot(db, exp) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  const packDir = path.join(root, 'agent-pack');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, fileNames.db), JSON.stringify(db));
  fs.writeFileSync(path.join(packDir, fileNames.export), JSON.stringify(exp));
  return root;
}

const created = [];
function root(db, exp) {
  const r = makeRoot(db, exp);
  created.push(r);
  return r;
}

test.after(() => {
  for (const r of created) {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

// A clean baseline pair (db <-> export parity, all maps present).
function cleanPair() {
  return {
    db: { nodes: { Frac: dbNodeOk() } },
    exp: { nodes: { Frac: exportNodeOk() }, reserved: reservedOk() },
  };
}

// --- tests -----------------------------------------------------------------

test('clean pair => failed:false with zero counts', () => {
  const { db, exp } = cleanPair();
  const result = audit(root(db, exp));
  assert.equal(result.failed, false);
  assert.equal(result.summary.missing, 0);
  assert.equal(result.summary.orphans, 0);
  assert.equal(result.summary.unresolved, 0);
  assert.equal(result.summary.badShape, 0);
  assert.equal(result.summary.missingMaps, 0);
});

test('a verified:false DB node is NOT counted as missing', () => {
  const { db, exp } = cleanPair();
  // Add a provisional DB node with no export counterpart; must be tolerated.
  db.nodes.Provisional = { ...dbNodeOk(), verified: false };
  const result = audit(root(db, exp));
  assert.equal(result.summary.missing, 0);
  assert.equal(result.details.missing.includes('Provisional'), false);
  assert.equal(result.failed, false);
});

test('missing: a verified DB node absent from export', () => {
  const { db, exp } = cleanPair();
  db.nodes.Ghost = { ...dbNodeOk(), verified: true }; // no export entry
  const result = audit(root(db, exp));
  assert.equal(result.summary.missing, 1);
  assert.deepEqual(result.details.missing, ['Ghost']);
  assert.equal(result.failed, true);
  // and nothing else tripped
  assert.equal(result.summary.orphans, 0);
  assert.equal(result.summary.unresolved, 0);
  assert.equal(result.summary.badShape, 0);
  assert.equal(result.summary.missingMaps, 0);
});

test('orphans: an export node absent from the DB', () => {
  const { db, exp } = cleanPair();
  exp.nodes.Stray = { ...exportNodeOk(), verified: true };
  const result = audit(root(db, exp));
  assert.equal(result.summary.orphans, 1);
  assert.deepEqual(result.details.orphans, ['Stray']);
  assert.equal(result.failed, true);
  assert.equal(result.summary.missing, 0);
  assert.equal(result.summary.unresolved, 0);
  assert.equal(result.summary.badShape, 0);
  // Stray has matching maps and lives only in export, so no missingMaps.
  assert.equal(result.summary.missingMaps, 0);
});

test('unresolved: an export node that is neither verified nor dynamic', () => {
  const { db, exp } = cleanPair();
  // Add a DB+export pair where the export side is unresolved (verified:false,
  // not dynamic). Keep maps matching so only `unresolved` trips.
  db.nodes.Pending = dbNodeOk();
  const pendingExp = exportNodeOk();
  delete pendingExp.verified; // verified !== true, dynamicExport !== true
  exp.nodes.Pending = pendingExp;
  const result = audit(root(db, exp));
  assert.equal(result.summary.unresolved, 1);
  assert.deepEqual(result.details.unresolved, ['Pending']);
  assert.equal(result.failed, true);
  assert.equal(result.summary.missing, 0);
  assert.equal(result.summary.orphans, 0);
  assert.equal(result.summary.badShape, 0);
  assert.equal(result.summary.missingMaps, 0);
});

test('badShape: an export node with a malformed field', () => {
  const { db, exp } = cleanPair();
  // Break only the shape (outputs is not a plain object); keep parity so the
  // missingMaps loop skips it (it short-circuits on non-object meta fields via
  // optional chaining, but to isolate badShape we drop the DB declarations).
  db.nodes.Broken = { category: 'Utility', description: 'x', inputs: [], outputs: [], params: [], verified: true };
  exp.nodes.Broken = {
    ueClass: '/Script/Engine.MaterialExpressionBroken',
    inputs: {},
    outputs: [], // not a plain object -> badShape
    params: {},
    verified: true,
  };
  const result = audit(root(db, exp));
  assert.equal(result.summary.badShape, 1);
  assert.deepEqual(result.details.badShape, ['Broken.outputs']);
  assert.equal(result.failed, true);
  assert.equal(result.summary.missing, 0);
  assert.equal(result.summary.orphans, 0);
  assert.equal(result.summary.unresolved, 0);
  assert.equal(result.summary.missingMaps, 0);
});

test('missingMaps: a DB-declared pin with no export map entry', () => {
  const { db, exp } = cleanPair();
  // Declare an extra input in the DB that the export side does not map.
  db.nodes.Frac.inputs = [
    { name: 'A', type: 'Float1|2|3|4' },
    { name: 'B', type: 'Float1|2|3|4' }, // unmapped on export side
  ];
  const result = audit(root(db, exp));
  assert.equal(result.summary.missingMaps, 1);
  assert.deepEqual(result.details.missingMaps, ['Frac.inputs.B']);
  assert.equal(result.failed, true);
  assert.equal(result.summary.missing, 0);
  assert.equal(result.summary.orphans, 0);
  assert.equal(result.summary.unresolved, 0);
  assert.equal(result.summary.badShape, 0);
});

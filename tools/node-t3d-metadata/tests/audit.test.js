const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { audit } = require('../audit-export-meta');
const { buildIndex } = require('../gen-node-index');
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

// Write a workflowRoot under tmpdir with the given db/export objects and a
// fresh generated index, return its path.
function makeRoot(db, exp) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-test-'));
  const packDir = path.join(root, 'agent-pack');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, fileNames.db), JSON.stringify(db));
  fs.writeFileSync(path.join(packDir, fileNames.export), JSON.stringify(exp));
  // Write a valid node index derived from the DB so existing tests stay green.
  const idx = buildIndex(db, '5.7');
  fs.writeFileSync(path.join(packDir, fileNames.index), JSON.stringify(idx, null, 2) + '\n');
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
  assert.equal(result.summary.arrayPins, 0);
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

// A well-formed QualitySwitch export node (DB parity, verified, all maps present) so
// only the array-pin drift check can trip. Mirrors the real node's shape.
function qualitySwitchPair(mediumProperty) {
  return {
    db: {
      category: 'Utility',
      description: 'quality switch',
      inputs: [{ name: 'Medium', type: 'Float1|2|3|4' }],
      outputs: [{ name: 'Result', type: 'Float1|2|3|4' }],
      params: [],
      verified: true,
    },
    exp: {
      ueClass: '/Script/Engine.MaterialExpressionQualitySwitch',
      inputs: { Medium: { property: mediumProperty } },
      outputs: { Result: { index: 0 } },
      params: {},
      verified: true,
    },
  };
}

test('arrayPins: an array-element property that drifted to its raw pin name trips the audit', () => {
  const { db, exp } = cleanPair();
  const qs = qualitySwitchPair('Medium'); // regressed: should be Inputs(2)
  db.nodes.QualitySwitch = qs.db;
  exp.nodes.QualitySwitch = qs.exp;
  const result = audit(root(db, exp));
  assert.equal(result.summary.arrayPins, 1);
  assert.deepEqual(result.details.arrayPins, ['QualitySwitch.inputs.Medium: Medium (expected Inputs(2))']);
  assert.equal(result.failed, true);
  // and nothing else tripped
  assert.equal(result.summary.missing, 0);
  assert.equal(result.summary.orphans, 0);
  assert.equal(result.summary.unresolved, 0);
  assert.equal(result.summary.badShape, 0);
  assert.equal(result.summary.missingMaps, 0);
});

test('arrayPins: the canonical "(N)" property produces zero drift', () => {
  const { db, exp } = cleanPair();
  const qs = qualitySwitchPair('Inputs(2)'); // canonical
  db.nodes.QualitySwitch = qs.db;
  exp.nodes.QualitySwitch = qs.exp;
  const result = audit(root(db, exp));
  assert.equal(result.summary.arrayPins, 0);
  assert.equal(result.failed, false);
});

// --- index drift tests -----------------------------------------------------

test('index in sync => indexMissing=0 indexDrift=0 failed:false', () => {
  const { db, exp } = cleanPair();
  const result = audit(root(db, exp));
  assert.equal(result.summary.indexMissing, 0);
  assert.equal(result.summary.indexDrift, 0);
  assert.equal(result.failed, false);
});

test('index file missing => indexMissing=1 failed:true', () => {
  const { db, exp } = cleanPair();
  const r = makeRoot(db, exp);
  created.push(r);
  // Remove the index file so the audit sees it missing.
  fs.unlinkSync(path.join(r, 'agent-pack', fileNames.index));
  const result = audit(r);
  assert.equal(result.summary.indexMissing, 1);
  assert.equal(result.summary.indexDrift, 0);
  assert.equal(result.failed, true);
  // No other categories should trip.
  assert.equal(result.summary.missing, 0);
  assert.equal(result.summary.orphans, 0);
  assert.equal(result.summary.unresolved, 0);
  assert.equal(result.summary.badShape, 0);
  assert.equal(result.summary.missingMaps, 0);
  assert.equal(result.summary.arrayPins, 0);
});

test('tampered desc in index => indexDrift>0 failed:true', () => {
  const { db, exp } = cleanPair();
  const r = makeRoot(db, exp);
  created.push(r);
  // Tamper the desc field in the index.
  const indexPath = path.join(r, 'agent-pack', fileNames.index);
  const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  idx.nodes.Frac.desc = 'wrong description';
  fs.writeFileSync(indexPath, JSON.stringify(idx, null, 2) + '\n');
  const result = audit(r);
  assert.ok(result.summary.indexDrift > 0, 'indexDrift should be > 0');
  assert.equal(result.summary.indexMissing, 0);
  assert.equal(result.failed, true);
  assert.ok(
    result.details.indexDrift.some((s) => s.includes('Frac.desc')),
    'drift details should mention Frac.desc',
  );
});

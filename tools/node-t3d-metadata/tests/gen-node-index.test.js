const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { deriveDesc, buildIndex, run } = require('../gen-node-index');
const { fileNames } = require('../version');

// --- fixture helpers -------------------------------------------------------

// Write a minimal agent-pack DB to a temp dir and return the workflow root.
function makeRoot(db) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-index-test-'));
  const packDir = path.join(root, 'agent-pack');
  fs.mkdirSync(packDir, { recursive: true });
  fs.writeFileSync(path.join(packDir, fileNames.db), JSON.stringify(db));
  return root;
}

const created = [];
function tmpRoot(db) {
  const r = makeRoot(db);
  created.push(r);
  return r;
}

test.after(() => {
  for (const r of created) {
    fs.rmSync(r, { recursive: true, force: true });
  }
});

// --- deriveDesc unit tests -------------------------------------------------

test('deriveDesc: first sentence ends at "." followed by space', () => {
  assert.equal(deriveDesc('Hello world. Extra text.'), 'Hello world.');
});

test('deriveDesc: "." at end-of-string counts as sentence end', () => {
  assert.equal(deriveDesc('Hello world.'), 'Hello world.');
});

test('deriveDesc: no "." followed by space/end falls back to whole description', () => {
  assert.equal(deriveDesc('Hello world.Extra text'), 'Hello world.Extra text');
});

test('deriveDesc: empty string returns empty string', () => {
  assert.equal(deriveDesc(''), '');
});

test('deriveDesc: null/undefined returns empty string', () => {
  assert.equal(deriveDesc(null), '');
  assert.equal(deriveDesc(undefined), '');
});

test('deriveDesc: caps at 140 chars with "..." suffix', () => {
  const raw = 'A'.repeat(150) + '.';
  const result = deriveDesc(raw);
  assert.equal(result.length, 140);
  assert.ok(result.endsWith('...'), 'should end with ...');
});

test('deriveDesc: exactly 140 chars is not truncated', () => {
  const raw = 'A'.repeat(139) + '.';
  const result = deriveDesc(raw);
  assert.equal(result.length, 140);
  assert.ok(!result.endsWith('...'));
});

// --- buildIndex unit tests -------------------------------------------------

test('buildIndex: basic shape with category, desc, verified', () => {
  const db = {
    nodes: {
      Multiply: {
        category: 'Math',
        description: 'Multiplies two values. Extra text.',
        verified: true,
      },
    },
  };
  const index = buildIndex(db, '5.7');
  assert.equal(index.ueVersion, '5.7');
  assert.equal(index.generatedFrom, 'nodes-ue5.7.json');
  const node = index.nodes.Multiply;
  assert.ok(node, 'Multiply should exist in index');
  assert.equal(node.category, 'Math');
  assert.equal(node.desc, 'Multiplies two values.');
  assert.equal(node.verified, true);
  assert.equal(node.dynamicPins, undefined, 'dynamicPins absent when not true');
  assert.equal(node.deprecated, undefined, 'deprecated absent when not true');
});

test('buildIndex: missing description => desc ""', () => {
  const db = {
    nodes: {
      Ghost: {
        category: 'Misc',
        verified: false,
      },
    },
  };
  const index = buildIndex(db, '5.7');
  assert.equal(index.nodes.Ghost.desc, '');
});

test('buildIndex: missing category => "Uncategorized"', () => {
  const db = {
    nodes: {
      Orphan: {
        description: 'A node.',
        verified: false,
      },
    },
  };
  const index = buildIndex(db, '5.7');
  assert.equal(index.nodes.Orphan.category, 'Uncategorized');
});

test('buildIndex: dynamicPins only present when true', () => {
  const db = {
    nodes: {
      Dynamic: { category: 'X', description: 'Dyn.', verified: true, dynamicPins: true },
      Static: { category: 'X', description: 'Static.', verified: true },
      FalseDynamic: { category: 'X', description: 'FDyn.', verified: true, dynamicPins: false },
    },
  };
  const index = buildIndex(db, '5.7');
  assert.equal(index.nodes.Dynamic.dynamicPins, true);
  assert.equal(index.nodes.Static.dynamicPins, undefined);
  assert.equal(index.nodes.FalseDynamic.dynamicPins, undefined);
});

test('buildIndex: deprecated only present when true', () => {
  const db = {
    nodes: {
      Old: { category: 'X', description: 'Old.', verified: true, deprecated: true },
      New: { category: 'X', description: 'New.', verified: true },
      FalseDeprecated: { category: 'X', description: 'FD.', verified: true, deprecated: false },
    },
  };
  const index = buildIndex(db, '5.7');
  assert.equal(index.nodes.Old.deprecated, true);
  assert.equal(index.nodes.New.deprecated, undefined);
  assert.equal(index.nodes.FalseDeprecated.deprecated, undefined);
});

test('buildIndex: key order preserved (JS insertion order)', () => {
  const db = {
    nodes: {
      Zebra: { category: 'Z', description: 'Z node.', verified: true },
      Alpha: { category: 'A', description: 'A node.', verified: true },
      Mango: { category: 'M', description: 'M node.', verified: false },
    },
  };
  const index = buildIndex(db, '5.7');
  const keys = Object.keys(index.nodes);
  assert.deepEqual(keys, ['Zebra', 'Alpha', 'Mango']);
});

// --- run() integration test ------------------------------------------------

test('run() writes index file with correct shape and trailing newline', () => {
  const db = {
    nodes: {
      Frac: {
        category: 'Utility',
        description: 'Returns the fractional part. More text.',
        verified: true,
      },
      Lerp: {
        category: 'Math',
        description: 'Linear interpolate.',
        verified: false,
        dynamicPins: true,
      },
    },
  };
  const root = tmpRoot(db);
  run(root, null);

  const indexPath = path.join(root, 'agent-pack', fileNames.index);
  assert.ok(fs.existsSync(indexPath), 'index file should be created');

  const raw = fs.readFileSync(indexPath, 'utf8');
  assert.ok(raw.endsWith('\n'), 'index file should end with newline');

  const idx = JSON.parse(raw);
  assert.equal(idx.ueVersion, '5.7');
  assert.equal(idx.generatedFrom, 'nodes-ue5.7.json');

  const frac = idx.nodes.Frac;
  assert.equal(frac.category, 'Utility');
  assert.equal(frac.desc, 'Returns the fractional part.');
  assert.equal(frac.verified, true);
  assert.equal(frac.dynamicPins, undefined);

  const lerp = idx.nodes.Lerp;
  assert.equal(lerp.verified, false);
  assert.equal(lerp.dynamicPins, true);
});

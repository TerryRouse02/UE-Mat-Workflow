const test = require('node:test');
const assert = require('node:assert/strict');

const {
  categoryFor,
  dedupe,
  buildCandidates,
} = require('../build-db-candidates');

test('categoryFor maps known type families', () => {
  assert.equal(categoryFor('SubstrateSlabBSDF'), 'Substrate');
  assert.equal(categoryFor('TextureObject'), 'Texture');
  assert.equal(categoryFor('SceneTexture'), 'Texture');
  assert.equal(categoryFor('RuntimeVirtualTextureSample'), 'Texture');
  assert.equal(categoryFor('LandscapeLayerBlend'), 'Landscape');
  assert.equal(categoryFor('ScalarParameter'), 'Parameters');
  assert.equal(categoryFor('VertexInterpolatorCustomOutput'), 'Output');
  assert.equal(categoryFor('BentNormalCustomOutput'), 'Output');
  assert.equal(categoryFor('SkyAtmosphereLightDirection'), 'Atmosphere');
  assert.equal(categoryFor('CloudSampleAttribute'), 'Atmosphere');
  assert.equal(categoryFor('Frac'), 'Utility');
});

test('dedupe suffixes repeated pin names (Unused, Unused_2)', () => {
  const result = dedupe([
    { name: 'Unused', type: 'Float1|2|3|4' },
    { name: 'Unused', type: 'Float1|2|3|4' },
    { name: 'A', type: 'Float1|2|3|4' },
    { name: 'Unused', type: 'Float1|2|3|4' },
  ]);
  assert.deepEqual(result.map((p) => p.name), ['Unused', 'Unused_2', 'A', 'Unused_3']);
});

test('buildCandidates skips reserved types and types already in db', () => {
  const report = {
    missing: [
      { type: 'Comment', inputs: [], outputs: [] },
      { type: 'MaterialFunctionCall', inputs: [], outputs: [] },
      { type: 'LinearInterpolate', inputs: ['A', 'B'], outputs: ['None'] },
      { type: 'AlreadyInDb', inputs: [], outputs: ['None'] },
      { type: 'BrandNewNode', inputs: ['X'], outputs: ['None'] },
    ],
  };
  const db = { nodes: { AlreadyInDb: { verified: true } } };
  const out = buildCandidates(report, db);

  assert.ok(!('Comment' in out.nodes), 'Comment is reserved/skipped');
  assert.ok(!('MaterialFunctionCall' in out.nodes), 'MaterialFunctionCall is reserved/skipped');
  assert.ok(!('LinearInterpolate' in out.nodes), 'LinearInterpolate alias is skipped');
  assert.ok(!('AlreadyInDb' in out.nodes), 'types already in db are skipped');
  assert.ok('BrandNewNode' in out.nodes, 'genuinely new node is kept');
  assert.equal(out.count, 1);
  assert.deepEqual(out.skippedReservedOrAlias.includes('Comment'), true);
  assert.deepEqual(out.skippedReservedOrAlias.includes('AlreadyInDb'), true);
  // skippedReservedOrAlias is sorted
  const sorted = [...out.skippedReservedOrAlias].sort();
  assert.deepEqual(out.skippedReservedOrAlias, sorted);
});

test('every generated entry is verified:false with placeholder types', () => {
  const report = {
    missing: [
      { type: 'BrandNewNode', inputs: ['X', 'Y'], outputs: ['R'], ueClass: '/Script/Engine.X' },
    ],
  };
  const out = buildCandidates(report, { nodes: {} });
  const entry = out.nodes.BrandNewNode;
  assert.equal(entry.verified, false);
  for (const pin of [...entry.inputs, ...entry.outputs]) {
    assert.equal(pin.type, 'Float1|2|3|4');
  }
});

test('a single unnamed output (None) becomes Result', () => {
  const report = {
    missing: [
      { type: 'NodeA', inputs: [], outputs: ['None'] },
    ],
  };
  const out = buildCandidates(report, { nodes: {} });
  assert.deepEqual(out.nodes.NodeA.outputs, [{ name: 'Result', type: 'Float1|2|3|4' }]);
});

test('multiple unnamed outputs become Out0/Out1 and empty outputs is a sink', () => {
  const report = {
    missing: [
      { type: 'MultiOut', inputs: [], outputs: ['None', 'None'] },
      { type: 'SinkNode', inputs: ['In'], outputs: [] },
    ],
  };
  const out = buildCandidates(report, { nodes: {} });
  assert.deepEqual(out.nodes.MultiOut.outputs.map((o) => o.name), ['Out0', 'Out1']);
  assert.deepEqual(out.nodes.SinkNode.outputs, []);
  assert.ok(out.outputlessNodes.includes('SinkNode'));
});

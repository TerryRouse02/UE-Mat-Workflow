const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  check,
  findForbiddenInText,
  findNonEngineKeys,
  findTrackedSensitive,
} = require('../check-public-purity');

const workflowRoot = path.resolve(__dirname, '..', '..', '..');

// Integration guard: the shipped public artifacts must be clean right now. This
// fails CI if a crawl ever pollutes agent-pack with project data, or a sensitive
// file gets git-tracked.
test('the committed repo passes the purity gate', () => {
  const result = check(workflowRoot);
  assert.deepEqual(result.details.forbidden, []);
  assert.deepEqual(result.details.engineKeys, []);
  assert.deepEqual(result.details.trackedSensitive, []);
  assert.equal(result.failed, false);
});

test('findForbiddenInText flags /Game/ paths and _project references with line numbers', () => {
  const text = 'clean line\n  "MaterialFunction": "/Game/Functions/MF_Foo.MF_Foo"\nanother\n  "x": "_project/staging"';
  const hits = findForbiddenInText(text, 'agent-pack/x.json');
  assert.equal(hits.length, 2);
  assert.match(hits[0], /agent-pack\/x\.json:2: \/Game\/ asset path/);
  assert.match(hits[1], /agent-pack\/x\.json:4: _project reference/);
});

test('findForbiddenInText passes clean public data', () => {
  const text = '{\n  "ueClass": "/Script/Engine.MaterialExpressionFrac",\n  "property": "CustomizedUVs(0)"\n}';
  assert.deepEqual(findForbiddenInText(text, 'f.json'), []);
});

test('findNonEngineKeys flags any non-/Engine engine-MF index key', () => {
  const idx = {
    functions: {
      '/Engine/Functions/Foo.Foo': {},
      '/Engine/ArtTools/Bar.Bar': {},
      '/Game/Functions/Leak.Leak': {},
    },
  };
  const hits = findNonEngineKeys(idx);
  assert.equal(hits.length, 1);
  assert.match(hits[0], /\/Game\/Functions\/Leak\.Leak/);
});

test('findNonEngineKeys tolerates a missing functions map', () => {
  assert.deepEqual(findNonEngineKeys({}), []);
  assert.deepEqual(findNonEngineKeys(null), []);
});

test('findTrackedSensitive flags server-only, per-machine, project, and Mac-binary paths', () => {
  const tracked = [
    'README.md',
    'agent-pack/nodes-ue5.7.json',
    'agent-pack/workmf-index.json',
    'tools/node-t3d-metadata/local.config.json',
    'graphs/_project/M_Foo/M_Foo.matgraph.json',
    'tools/node-t3d-metadata/compiled/UEMatExportMetadata/Binaries/Mac/UnrealEditor-UEMatExportMetadata.dylib',
  ];
  const hits = findTrackedSensitive(tracked);
  assert.equal(hits.length, 4);
  assert.ok(hits.some((h) => h.includes('workmf-index.json')));
  assert.ok(hits.some((h) => h.includes('local.config.json')));
  assert.ok(hits.some((h) => h.includes('graphs/_project/')));
  assert.ok(hits.some((h) => /\.dylib/.test(h)));
});

test('findTrackedSensitive flags the server-only workmf export and freshness files', () => {
  const tracked = ['agent-pack/workmf-index.export.json', 'agent-pack/crawl-freshness.json'];
  const hits = findTrackedSensitive(tracked);
  assert.equal(hits.length, 2);
  assert.ok(hits.some((h) => h.includes('workmf-index.export.json')));
  assert.ok(hits.some((h) => h.includes('crawl-freshness.json')));
});

test('findTrackedSensitive passes a clean tracked list', () => {
  const tracked = ['README.md', 'agent-pack/nodes-ue5.7.json', 'tools/node-t3d-metadata/audit-export-meta.js'];
  assert.deepEqual(findTrackedSensitive(tracked), []);
});

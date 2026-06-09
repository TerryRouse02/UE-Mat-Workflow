const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { heal, setPinPropertyInText } = require('../heal-export-meta');
const { ARRAY_PIN_PROPERTIES, findArrayPinDrift } = require('../array-pin-properties');
const { agentPackPath } = require('../version');

const workflowRoot = path.resolve(__dirname, '..', '..', '..');
const exportPath = agentPackPath(workflowRoot, 'export');
const canonical = fs.readFileSync(exportPath, 'utf8');

// Build a regressed copy of the real export file by setting the named pins back to
// their raw DB pin name (exactly what the commandlet emits before healing).
function regress(text, pins) {
  let out = text;
  for (const { node, pin } of pins) {
    out = setPinPropertyInText(out, node, pin, pin);
  }
  return out;
}

function pinList(filter) {
  const list = [];
  for (const [node, pins] of Object.entries(ARRAY_PIN_PROPERTIES)) {
    for (const pin of Object.keys(pins)) {
      if (!filter || filter(node, pin)) list.push({ node, pin });
    }
  }
  return list;
}

// The pins the commandlet actually regresses (no override + array-name mismatch):
// MakeMaterialAttributes.CustomizedUVs_*, QualitySwitch Medium/Epic, FeatureLevelSwitch SM6.
const REVERTING = pinList((node, pin) => (
  node === 'MakeMaterialAttributes'
  || (node === 'QualitySwitch' && (pin === 'Medium' || pin === 'Epic'))
  || (node === 'FeatureLevelSwitch' && pin === 'SM6')
));

test('committed export.json is already canonical (regression guard on shipped data)', () => {
  assert.deepEqual(findArrayPinDrift(JSON.parse(canonical)), []);
});

test('heal restores the realistic 11-pin crawl regression byte-for-byte', () => {
  const regressed = regress(canonical, REVERTING);
  assert.notEqual(regressed, canonical);
  assert.equal(findArrayPinDrift(JSON.parse(regressed)).length, REVERTING.length);

  const result = heal(regressed);
  assert.equal(result.changed, true);
  assert.equal(result.fixes.length, REVERTING.length);
  assert.equal(result.text, canonical); // exact format preserved
});

test('heal restores ALL canonical array pins regardless of which ones drifted', () => {
  const regressed = regress(canonical, pinList());
  const result = heal(regressed);
  assert.equal(result.text, canonical);
  assert.deepEqual(findArrayPinDrift(JSON.parse(result.text)), []);
});

test('heal is idempotent on a canonical file (no change)', () => {
  const result = heal(canonical);
  assert.equal(result.changed, false);
  assert.equal(result.fixes.length, 0);
  assert.equal(result.text, canonical);
});

test('healing twice equals healing once', () => {
  const regressed = regress(canonical, REVERTING);
  const once = heal(regressed).text;
  const twice = heal(once).text;
  assert.equal(twice, once);
});

test('a single fix only touches that one property line', () => {
  const regressed = setPinPropertyInText(canonical, 'QualitySwitch', 'Medium', 'Medium');
  const result = heal(regressed);
  assert.equal(result.text, canonical);
  // The change is confined to one line: only one line differs between the two texts.
  const a = regressed.split('\n');
  const b = result.text.split('\n');
  assert.equal(a.length, b.length);
  const diffLines = a.filter((line, i) => line !== b[i]);
  assert.equal(diffLines.length, 1);
});

test('FeatureLevelSwitch and QualitySwitch Inputs() are scoped per node', () => {
  // Both nodes use the "Inputs" array; healing one must not touch the other.
  const regressed = regress(canonical, [
    { node: 'QualitySwitch', pin: 'Medium' },
    { node: 'FeatureLevelSwitch', pin: 'SM6' },
  ]);
  const result = heal(regressed);
  const obj = JSON.parse(result.text);
  assert.equal(obj.nodes.QualitySwitch.inputs.Medium.property, 'Inputs(2)');
  assert.equal(obj.nodes.FeatureLevelSwitch.inputs.SM6.property, 'Inputs(4)');
  assert.equal(result.text, canonical);
});

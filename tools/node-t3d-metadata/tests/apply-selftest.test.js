const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  summarize, hardProblems, markVerified, fillDefaults, parseUeValue, parseArgs, main,
} = require('../apply-selftest');

// --- fixtures ---------------------------------------------------------------

function makeReport(overrides = {}) {
  return {
    schemaVersion: '1.0',
    kind: 'node-selftest',
    engineVersion: '5.7.4-0+UE5',
    generatedAt: '2026-06-12T00:00:00Z',
    counts: { checked: 4, clean: 2, withDiffs: 1, classMissing: 1, skipped: 0 },
    nodes: {
      Add: { status: 'clean', diffs: [], t3dRoundTrip: 'ok' },
      Power: {
        status: 'clean', diffs: [], t3dRoundTrip: 'ok',
        defaults: { ConstExponent: '2.000000' },
      },
      Sine: {
        status: 'diff', t3dRoundTrip: 'ok',
        diffs: ["DB input 'Period' has no matching engine pin"],
        typeNotes: ["input 'Input': DB type 'Float1' vs engine 'Float1|2|3|4'"],
      },
      GhostNode: { status: 'class-missing' },
    },
    ...overrides,
  };
}

function makeDb() {
  return {
    schemaVersion: '1.0',
    ueVersion: '5.7',
    nodes: {
      Add: { category: 'Math', description: 'Adds two inputs.', verified: false },
      Power: {
        category: 'Math', description: 'Raises Base to the power of Exp.', verified: false,
        params: [
          { name: 'ConstExponent', type: 'Float' },
          { name: 'SomeFlag', type: 'Bool' },
        ],
      },
      Sine: { category: 'Math', description: 'Sine wave.', verified: false },
      GhostNode: { category: 'Misc', description: 'Does not exist.', verified: false },
      NoDesc: { category: 'Misc', description: '', verified: false },
    },
  };
}

// --- pure helpers -----------------------------------------------------------

test('summarize groups nodes by status and counts type notes', () => {
  const s = summarize(makeReport());
  assert.deepEqual(s.byStatus.clean.sort(), ['Add', 'Power']);
  assert.deepEqual(s.byStatus.diff, ['Sine']);
  assert.deepEqual(s.byStatus['class-missing'], ['GhostNode']);
  assert.equal(s.typeNotes, 1);
});

test('hardProblems lists diffs and class-missing, not type notes', () => {
  const problems = hardProblems(makeReport());
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.node === 'Sine' && /Period/.test(p.problem)));
  assert.ok(problems.some((p) => p.node === 'GhostNode'));
});

test('markVerified flips only clean+described+unverified nodes', () => {
  const db = makeDb();
  const report = makeReport();
  // NoDesc is clean in the report but has no description -> must not flip.
  report.nodes.NoDesc = { status: 'clean', diffs: [] };
  // Add is already verified -> must not be re-listed.
  db.nodes.Add.verified = true;

  const flipped = markVerified(db, report);
  assert.deepEqual(flipped, ['Power']);
  assert.equal(db.nodes.Power.verified, true);
  assert.equal(db.nodes.Sine.verified, false); // diff status untouched
  assert.equal(db.nodes.GhostNode.verified, false); // class-missing untouched
  assert.equal(db.nodes.NoDesc.verified, false); // no description
});

test('parseUeValue handles UE export text for scalars only', () => {
  assert.equal(parseUeValue('Float', '2.000000'), 2);
  assert.equal(parseUeValue('Float', '0.500000'), 0.5);
  assert.equal(parseUeValue('Int', '3'), 3);
  assert.equal(parseUeValue('Int', '3.5'), undefined);
  assert.equal(parseUeValue('Bool', 'True'), true);
  assert.equal(parseUeValue('Bool', 'False'), false);
  assert.equal(parseUeValue('Enum', 'SAMPLERTYPE_Color'), undefined);
  assert.equal(parseUeValue('Float', '(R=1.000000,G=0.000000)'), undefined);
  assert.equal(parseUeValue('Float', undefined), undefined);
});

test('fillDefaults fills only missing scalar defaults', () => {
  const db = makeDb();
  const report = makeReport();
  report.nodes.Power.defaults = { ConstExponent: '2.000000', SomeFlag: 'False' };
  db.nodes.Power.params[0].default = 1; // already present -> untouched

  const filled = fillDefaults(db, report);
  assert.deepEqual(filled, [{ node: 'Power', param: 'SomeFlag', value: false }]);
  assert.equal(db.nodes.Power.params[0].default, 1);
  assert.equal(db.nodes.Power.params[1].default, false);
});

// --- end-to-end against a temp workflow root --------------------------------

const created = [];
test.after(() => {
  for (const r of created) fs.rmSync(r, { recursive: true, force: true });
});

function makeRoot(db, report) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-selftest-'));
  created.push(root);
  fs.mkdirSync(path.join(root, 'agent-pack'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools', 'node-t3d-metadata'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agent-pack', 'nodes-ue5.7.json'), JSON.stringify(db, null, 2) + '\n');
  const reportPath = path.join(root, 'tools', 'node-t3d-metadata', 'node-selftest.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return { root, reportPath };
}

test('main --mark-verified rewrites the DB and regenerates the index', () => {
  const { root, reportPath } = makeRoot(makeDb(), makeReport());
  const code = main(parseArgs(['--workflow-root', root, '--report', reportPath, '--mark-verified']));
  assert.equal(code, 0);

  const db = JSON.parse(fs.readFileSync(path.join(root, 'agent-pack', 'nodes-ue5.7.json'), 'utf8'));
  assert.equal(db.nodes.Add.verified, true);
  assert.equal(db.nodes.Power.verified, true);
  assert.equal(db.nodes.Sine.verified, false);

  // gen-node-index ran and the index mirrors the new flags (the audit's parity rule).
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'agent-pack', 'nodes-ue5.7.index.json'), 'utf8'));
  assert.equal(idx.nodes.Add.verified, true);
  assert.equal(idx.nodes.Sine.verified, false);
});

test('main --dry-run changes nothing on disk', () => {
  const { root, reportPath } = makeRoot(makeDb(), makeReport());
  const before = fs.readFileSync(path.join(root, 'agent-pack', 'nodes-ue5.7.json'), 'utf8');
  const code = main(parseArgs(['--workflow-root', root, '--report', reportPath, '--mark-verified', '--fill-defaults', '--dry-run']));
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(path.join(root, 'agent-pack', 'nodes-ue5.7.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(root, 'agent-pack', 'nodes-ue5.7.index.json')), false);
});

test('main --check exits non-zero on hard diffs and zero when clean', () => {
  const { root, reportPath } = makeRoot(makeDb(), makeReport());
  assert.equal(main(parseArgs(['--workflow-root', root, '--report', reportPath, '--check'])), 1);

  const cleanReport = makeReport();
  cleanReport.nodes.Sine = { status: 'clean', diffs: [] };
  cleanReport.nodes.GhostNode = { status: 'clean', diffs: [] };
  const second = makeRoot(makeDb(), cleanReport);
  assert.equal(main(parseArgs(['--workflow-root', second.root, '--report', second.reportPath, '--check'])), 0);
});

test('main rejects a non-selftest report', () => {
  const { root, reportPath } = makeRoot(makeDb(), { kind: 'node-discovery' });
  assert.throws(() => main(parseArgs(['--workflow-root', root, '--report', reportPath])));
});

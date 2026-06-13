// apply-selftest.js — consume the node self-test report written by the
// UEMatExportMetadata commandlet's -SelfTestOut mode (see docs/SELF_TEST.md).
//
// The report machine-verifies every authoring-DB node against the live engine
// (pin diff, T3D round-trip, export-metadata property check, engine defaults).
// This tool turns that report into action:
//
//   node tools/node-t3d-metadata/apply-selftest.js                 summary
//   node tools/node-t3d-metadata/apply-selftest.js --check         CI gate: exit 1 on any hard diff
//   node tools/node-t3d-metadata/apply-selftest.js --mark-verified flip clean+described nodes to
//                                                                  verified:true and regen the index
//   node tools/node-t3d-metadata/apply-selftest.js --fill-defaults fill missing float/int/bool param
//                                                                  defaults from the engine values
//   --dry-run                                                      print planned writes, change nothing
//   --report <path> / --workflow-root <path>                       override locations
//
// Marking semantics: a node is flipped to verified:true only when the engine
// round-trip found ZERO hard diffs AND the node already carries a description.
// The remaining human responsibility is description accuracy — pins, types,
// T3D properties, and defaults were verified by the engine itself.
//
// Only the authoring DB is rewritten (it round-trips through JSON.stringify
// 2-space cleanly). The export metadata is NEVER touched here — it is written
// by UE's JSON writer and must only be string-spliced (see heal-export-meta.js).
//
// Plain Node.js, zero external dependencies.

const fs = require('fs');
const path = require('path');

/** Hard problems: anything the engine itself contradicted. */
function hardProblems(report) {
  const out = [];
  const nodes = report && typeof report.nodes === 'object' ? report.nodes : {};
  for (const [name, entry] of Object.entries(nodes)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.status === 'class-missing') {
      out.push({ node: name, problem: 'expression class not found in engine' });
    } else if (entry.status === 'diff') {
      for (const d of Array.isArray(entry.diffs) ? entry.diffs : []) {
        out.push({ node: name, problem: String(d) });
      }
    }
  }
  return out;
}

function summarize(report) {
  const counts = report && typeof report.counts === 'object' ? report.counts : {};
  const nodes = report && typeof report.nodes === 'object' ? report.nodes : {};
  const byStatus = { clean: [], diff: [], 'class-missing': [], skipped: [] };
  let typeNotes = 0;
  for (const [name, entry] of Object.entries(nodes)) {
    if (!entry || typeof entry !== 'object') continue;
    (byStatus[entry.status] || (byStatus[entry.status] = [])).push(name);
    if (Array.isArray(entry.typeNotes)) typeNotes += entry.typeNotes.length;
  }
  return { counts, byStatus, typeNotes };
}

/**
 * Flip clean, described, not-yet-verified DB nodes to verified:true.
 * Mutates db; returns the flipped node names.
 */
function markVerified(db, report) {
  const dbNodes = db && typeof db.nodes === 'object' ? db.nodes : {};
  const repNodes = report && typeof report.nodes === 'object' ? report.nodes : {};
  const flipped = [];
  for (const [name, entry] of Object.entries(repNodes)) {
    if (!entry || entry.status !== 'clean') continue;
    const node = dbNodes[name];
    if (!node || node.verified === true) continue;
    if (typeof node.description !== 'string' || !node.description.trim()) continue;
    node.verified = true;
    flipped.push(name);
  }
  return flipped;
}

/**
 * Parse a UE ExportTextItem value for a scalar DB param type.
 * Returns undefined when the value is not representable as that type.
 */
function parseUeValue(dbType, text) {
  if (typeof text !== 'string') return undefined;
  const t = text.trim();
  if (dbType === 'Bool') {
    if (/^true$/i.test(t)) return true;
    if (/^false$/i.test(t)) return false;
    return undefined;
  }
  if (dbType === 'Int') {
    const n = Number(t);
    return Number.isInteger(n) ? n : undefined;
  }
  if (dbType === 'Float') {
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Fill missing float/int/bool param defaults in the DB from engine values.
 * Mutates db; returns [{node, param, value}].
 */
function fillDefaults(db, report) {
  const dbNodes = db && typeof db.nodes === 'object' ? db.nodes : {};
  const repNodes = report && typeof report.nodes === 'object' ? report.nodes : {};
  const filled = [];
  for (const [name, entry] of Object.entries(repNodes)) {
    if (!entry || typeof entry !== 'object' || !entry.defaults) continue;
    const node = dbNodes[name];
    if (!node || !Array.isArray(node.params)) continue;
    for (const param of node.params) {
      if (!param || typeof param !== 'object' || 'default' in param) continue;
      const value = parseUeValue(param.type, entry.defaults[param.name]);
      if (value !== undefined) {
        param.default = value;
        filled.push({ node: name, param: param.name, value });
      }
    }
  }
  return filled;
}

function parseArgs(argv) {
  const args = {
    workflowRoot: path.resolve(__dirname, '..', '..'),
    report: null,
    check: false,
    markVerified: false,
    fillDefaults: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workflow-root') args.workflowRoot = path.resolve(argv[++i]);
    else if (arg === '--report') args.report = path.resolve(argv[++i]);
    else if (arg === '--check') args.check = true;
    else if (arg === '--mark-verified') args.markVerified = true;
    else if (arg === '--fill-defaults') args.fillDefaults = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.report) {
    args.report = path.join(args.workflowRoot, 'tools', 'node-t3d-metadata', 'node-selftest.json');
  }
  return args;
}

function main(args) {
  const report = JSON.parse(fs.readFileSync(args.report, 'utf8'));
  if (report.kind !== 'node-selftest') {
    throw new Error(`Not a node-selftest report (kind=${report.kind}): ${args.report}`);
  }
  const ueVersion = /^(\d+\.\d+)/.exec(String(report.engineVersion || ''))?.[1] || '5.7';
  const dbPath = path.join(args.workflowRoot, 'agent-pack', `nodes-ue${ueVersion}.json`);
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

  const { counts, byStatus, typeNotes } = summarize(report);
  console.log(`Self-test report: ${args.report}`);
  console.log(`Engine: ${report.engineVersion || 'unknown'}  generated: ${report.generatedAt || 'unknown'}`);
  console.log(`checked=${counts.checked ?? '?'} clean=${counts.clean ?? '?'} withDiffs=${counts.withDiffs ?? '?'} classMissing=${counts.classMissing ?? '?'} skipped=${counts.skipped ?? '?'} typeNotes=${typeNotes}`);

  const problems = hardProblems(report);
  if (problems.length > 0) {
    console.log('\nHard diffs (engine contradicts the DB / export metadata):');
    for (const p of problems) console.log(`  ${p.node}: ${p.problem}`);
  }

  let wroteDb = false;
  if (args.markVerified) {
    const flipped = markVerified(db, report);
    if (flipped.length === 0) {
      console.log('\n--mark-verified: nothing to flip (no clean, described, unverified nodes).');
    } else if (args.dryRun) {
      console.log(`\n--mark-verified (dry-run): would flip ${flipped.length} node(s): ${flipped.join(', ')}`);
    } else {
      wroteDb = true;
      console.log(`\n--mark-verified: flipped ${flipped.length} node(s) to verified:true: ${flipped.join(', ')}`);
    }
  }
  if (args.fillDefaults) {
    const filled = fillDefaults(db, report);
    if (filled.length === 0) {
      console.log('--fill-defaults: nothing to fill.');
    } else if (args.dryRun) {
      console.log(`--fill-defaults (dry-run): would fill ${filled.length} default(s): ${filled.map((f) => `${f.node}.${f.param}=${f.value}`).join(', ')}`);
    } else {
      wroteDb = true;
      console.log(`--fill-defaults: filled ${filled.length} default(s): ${filled.map((f) => `${f.node}.${f.param}=${f.value}`).join(', ')}`);
    }
  }

  if (wroteDb && !args.dryRun) {
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2) + '\n');
    console.log(`Wrote ${dbPath}`);
    // Keep the generated index in parity (the audit fails on verified drift).
    require('./gen-node-index.js').run(args.workflowRoot, ueVersion);
    console.log('Reminder: run `node tools/node-t3d-metadata/audit-export-meta.js` before committing.');
  }

  if (args.check && problems.length > 0) {
    console.error(`\n--check: ${problems.length} hard diff(s) found.`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(parseArgs(process.argv.slice(2))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = { summarize, hardProblems, markVerified, fillDefaults, parseUeValue, parseArgs, main };

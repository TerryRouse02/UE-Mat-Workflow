#!/usr/bin/env node
// Turn a node-discovery.json report into reviewable candidate authoring-DB
// entries. Output is a staging file (NOT nodes-ue*.json, so it is neither
// bundled into the web build nor audited) that the UE-side step merges into
// agent-pack/nodes-ue5.7.json and then regenerates the export metadata for —
// the two halves must land together (the audit requires authoring<->export
// parity). See docs/NODE_DISCOVERY.md.
//
// Usage:
//   node tools/node-t3d-metadata/build-db-candidates.js \
//     [--report <node-discovery.json>] [--db <nodes-ue5.7.json>] [--out <db-candidates.json>]

const fs = require('fs');
const path = require('path');
const { fileNames } = require('./version');

// Types that should NOT become authoring nodes: reserved types the format handles
// specially, abstract/structural bases, the reroute we collapse on import, and
// aliases whose friendly name is already in the DB (Lerp == LinearInterpolate).
const SKIP = new Set([
  'Comment', 'FunctionInput', 'FunctionOutput', 'MaterialFunctionCall',
  'Reroute', 'NamedRerouteDeclaration', 'NamedRerouteUsage',
  'PinBase', 'Parameter', 'Composite', 'Operator', 'Convert', 'Aggregate',
  'MaterialSample', 'LinearInterpolate', // Lerp alias already in DB
]);

// Friendly name -> the spelling we keep in the DB. Lerp stays an alias; the
// PreSkinnedLocal* DB keys are wrong (the real classes are PreSkinned*).
const ORPHAN_FIXES = {
  rename: { PreSkinnedLocalNormal: 'PreSkinnedNormal', PreSkinnedLocalPosition: 'PreSkinnedPosition' },
  remove: ['TextureSampleParameterMovie'], // no matching engine class in 5.7
  keep:   ['Lerp', 'BlendAngleCorrectedNormals'], // legit alias / engine Material Function
};

function categoryFor(type, caption) {
  if (/^Substrate/.test(type)) return 'Substrate';
  if (/SparseVolume|Texture|RuntimeVirtualTexture|SceneTexture|DBuffer|MeshPaint/.test(type)) return 'Texture';
  if (/^Landscape/.test(type)) return 'Landscape';
  if (/Parameter$/.test(type)) return 'Parameters';
  if (/Output$/.test(type) || /CustomOutput$/.test(type)) return 'Output';
  if (/SkyAtmosphere|Atmospheric|Cloud|Fog/.test(type)) return 'Atmosphere';
  return 'Utility';
}

function inputPin(entry) {
  const name = typeof entry === 'string' ? entry : entry && entry.name;
  if (!name || name === 'None') return null;
  return {
    name,
    type: typeof entry === 'string' ? 'Float1|2|3|4' : entry.type || 'Float1|2|3|4',
    required: false,
  };
}

// UE can reflect several pins with the same name (e.g. SubstrateShadingModels
// has multiple "Unused" inputs). The authoring DB requires unique pin names, so
// disambiguate repeats with a numeric suffix (Unused, Unused_2, …).
function dedupe(pins) {
  const seen = new Map();
  return pins.map((p) => {
    const n = seen.get(p.name) || 0;
    seen.set(p.name, n + 1);
    return n === 0 ? p : { ...p, name: `${p.name}_${n + 1}` };
  });
}

// Pure transform: report + current DB -> the candidates staging object. No IO.
function buildCandidates(report, db) {
  const existing = new Set(Object.keys(db.nodes || {}));

  const candidates = {};
  const outputless = [];
  const skipped = [];
  let count = 0;
  const byCategory = {};

  for (const m of report.missing || []) {
    const type = m.type;
    if (SKIP.has(type) || existing.has(type)) { skipped.push(type); continue; }

    const inputs = (m.inputs || []).map(inputPin).filter(Boolean);
    const category = categoryFor(type, m.caption);

    // UE stores a single output's name as None (unnamed); only a truly empty
    // outputs array means a sink (material-output) node. So [] -> outputless,
    // ["None"] -> one default-named output, named ones kept as-is.
    const rawOut = Array.isArray(m.outputs) ? m.outputs : [];
    const outputs = rawOut.map((n, i) => ({
      name: n && n !== 'None' ? n : (rawOut.length === 1 ? 'Result' : `Out${i}`),
      type: 'Float1|2|3|4',
    }));

    const entry = {
      category,
      description: (m.caption || type) + ' (auto-discovered; verify pins/types).',
      inputs: dedupe(inputs),
      // Output types stay placeholders ("Float1|2|3|4", the DB's polymorphic
      // catch-all); UE does not provide reliable FExpressionOutput types here.
      outputs: dedupe(outputs),
      verified: false,
      ueClass: m.ueClass, // hint for the export regen / reviewer; harmless extra field
    };
    if (outputs.length === 0) outputless.push(type); // genuine sink/material-output node
    candidates[type] = entry;
    byCategory[category] = (byCategory[category] || 0) + 1;
    count++;
  }

  return {
    schemaVersion: '1.0',
    kind: 'db-candidates',
    note: 'Merge `nodes` into agent-pack/nodes-ue5.7.json, then regenerate the export metadata on the UE machine. Add `outputlessNodes` to viewer/server/db-loader.ts OUTPUTLESS_NODES. Apply orphanFixes. All entries are verified:false until cross-checked.',
    generatedFrom: { engineVersion: report.engineVersion, counts: report.counts },
    count,
    byCategory,
    outputlessNodes: outputless,
    orphanFixes: ORPHAN_FIXES,
    skippedReservedOrAlias: skipped.sort(),
    nodes: candidates,
  };
}

module.exports = { categoryFor, dedupe, buildCandidates, SKIP, ORPHAN_FIXES };

if (require.main === module) {
  const root = path.resolve(__dirname, '..', '..');
  const defaults = {
    report: path.join(__dirname, 'node-discovery.json'),
    db: path.join(root, 'agent-pack', fileNames.db),
    out: path.join(__dirname, 'db-candidates.json'),
  };

  function usage() {
    return [
      'Build reviewable authoring-DB candidate entries from a node-discovery report.',
      '',
      'Usage:',
      '  node tools/node-t3d-metadata/build-db-candidates.js [options]',
      '',
      'Options:',
      `  --report <path>  node-discovery.json report (default: ${defaults.report})`,
      `  --db <path>      current authoring DB (default: ${defaults.db})`,
      `  --out <path>     candidates output file (default: ${defaults.out})`,
      '  -h, --help       show this help and exit',
    ].join('\n');
  }

  function parseArgs(argv) {
    const args = { ...defaults };
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === '-h' || arg === '--help') {
        console.log(usage());
        process.exit(0);
      } else if (arg === '--report' || arg === '--db' || arg === '--out') {
        const value = argv[i + 1];
        if (value === undefined) {
          throw new Error(`Missing value for ${arg}`);
        }
        args[arg.slice(2)] = value;
        i += 1;
      } else {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
    return args;
  }

  try {
    const args = parseArgs(process.argv.slice(2));
    const reportPath = path.resolve(args.report);
    const dbPath = path.resolve(args.db);
    const outPath = path.resolve(args.out);

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

    const out = buildCandidates(report, db);

    fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log(`Wrote ${outPath}`);
    console.log(`candidates: ${out.count} | byCategory: ${JSON.stringify(out.byCategory)}`);
    console.log(`outputless (need OUTPUTLESS_NODES): ${out.outputlessNodes.length}`);
    console.log(`skipped (reserved/alias/already-in-DB): ${out.skippedReservedOrAlias.length}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

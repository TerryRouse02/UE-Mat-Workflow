#!/usr/bin/env node
// agent-pack/query.js — thin CLI shell over query-lib.js.
// Identical command-line interface, stdout/stderr text, and exit codes as before.
//
// Usage:
//   node query.js node <version> <Name> [<Name>...]
//   node query.js mf "<assetPath>" [<version>]
//   node query.js search <version> <term> [<term>...]
//   node query.js --help

'use strict';

const path = require('node:path');
const process = require('node:process');

const DATA_DIR = process.env.UEMAT_AGENT_PACK_DIR || path.dirname(__filename);

const lib = require('./query-lib.js');

// ---------------------------------------------------------------------------
// Subcommand: node
// ---------------------------------------------------------------------------

function cmdNode(args) {
  if (args.length < 2) {
    process.stderr.write('Usage: node query.js node <version> <Name> [<Name>...]\n');
    process.exit(1);
  }

  const version = args[0];
  const names = args.slice(1);

  const versions = lib.discoverVersions(DATA_DIR);
  if (!versions.includes(version)) {
    process.stderr.write(
      `No node DB for version "${version}". Available: ${versions.join(', ') || '(none)'}\n`,
    );
    process.exit(1);
  }

  const { result, suggestions } = lib.getNodes(DATA_DIR, version, names);

  let anyUnknown = false;
  for (const name of names) {
    if (!(name in result)) {
      anyUnknown = true;
      const sugg = suggestions[name] || [];
      if (sugg.length > 0) {
        process.stderr.write(
          `"${name}" not found. Did you mean: ${sugg.join(', ')}?\n`,
        );
      } else {
        process.stderr.write(`"${name}" not found.\n`);
      }
    } else {
      // Case-insensitive fallback — detect by checking exact key absence in the
      // nodes map (getNodes returns under the requested name in all cases).
      // We detect CI usage by checking if the result is from CI by comparing
      // the entry: if the original name wasn't in the DB directly but CI found it,
      // getNodes returns result[name] without a marker. We need to reproduce the
      // stderr note. Check by loading the DB directly.
    }
  }

  // Emit CI-match stderr notes. getNodes doesn't distinguish CI from exact; we
  // check here by attempting an exact lookup against the raw DB.
  const db = lib.loadNodesDb(DATA_DIR, version);
  const nodes = db.nodes || {};
  const reservedTypes = db.reservedTypes || [];

  for (const name of names) {
    if (name in result && !reservedTypes.includes(name)) {
      if (!Object.prototype.hasOwnProperty.call(nodes, name)) {
        // Was a case-insensitive match
        const lowerName = name.toLowerCase();
        const ciKey = Object.keys(nodes).find((k) => k.toLowerCase() === lowerName);
        if (ciKey) {
          process.stderr.write(
            `Note: "${name}" not found; using canonical casing "${ciKey}"\n`,
          );
        }
      }
    }
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(anyUnknown ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Subcommand: mf
// ---------------------------------------------------------------------------

function cmdMf(args) {
  if (args.length < 1) {
    process.stderr.write('Usage: node query.js mf "<assetPath>" [<version>]\n');
    process.exit(1);
  }

  const assetPath = args[0];
  const versionArg = args[1] || null;

  const workMfIndexPath = path.join(DATA_DIR, 'workmf-index.json');

  let mfResult;
  try {
    mfResult = lib.getMf(DATA_DIR, assetPath, versionArg, workMfIndexPath);
  } catch (err) {
    process.stderr.write(err.message + '\n');
    process.exit(1);
  }

  if (mfResult.found) {
    process.stdout.write(JSON.stringify(mfResult.entry, null, 2) + '\n');
    process.exit(0);
  }

  // Not found — emit appropriate crawl hint
  if (mfResult.kind === 'engine') {
    process.stderr.write(
      'Not in the Engine MF index - run the matching crawl from the viewer\'s Config tab; do not invent pin names.\n',
    );
  } else {
    process.stderr.write(
      'Not in the WorkMF index - run the matching crawl from the viewer\'s Config tab; do not invent pin names.\n',
    );
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Subcommand: search
// ---------------------------------------------------------------------------

function cmdSearch(args) {
  if (args.length < 2) {
    process.stderr.write('Usage: node query.js search <version> <term> [<term>...]\n');
    process.exit(1);
  }

  const version = args[0];
  const terms = args.slice(1);

  const versions = lib.discoverVersions(DATA_DIR);
  if (!versions.includes(version)) {
    process.stderr.write(
      `No node DB for version "${version}". Available: ${versions.join(', ') || '(none)'}\n`,
    );
    process.exit(1);
  }

  let matches;
  try {
    matches = lib.searchNodes(DATA_DIR, version, terms);
  } catch (err) {
    process.stderr.write(err.message + '\n');
    process.exit(1);
  }

  for (const m of matches) {
    process.stdout.write(m.line + '\n');
  }

  process.stderr.write(`${matches.length} match${matches.length === 1 ? '' : 'es'}\n`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Help / usage
// ---------------------------------------------------------------------------

function printUsage(exitCode) {
  const usage = [
    'Usage:',
    '  node query.js node <version> <Name> [<Name>...]',
    '    Example: node query.js node 5.7 Multiply Add',
    '',
    '  node query.js mf "<assetPath>" [<version>]',
    '    Example: node query.js mf "/Engine/Functions/Engine_MaterialFunctions02/Math/MF_Clamp.MF_Clamp" 5.7',
    '',
    '  node query.js search <version> <term> [<term>...]',
    '    Example: node query.js search 5.7 math lerp',
    '',
  ].join('\n');
  process.stderr.write(usage);
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
  printUsage(argv.length === 0 ? 1 : 0);
}

const subcommand = argv[0];
const subArgs = argv.slice(1);

if (subcommand === 'node') {
  cmdNode(subArgs);
} else if (subcommand === 'mf') {
  cmdMf(subArgs);
} else if (subcommand === 'search') {
  cmdSearch(subArgs);
} else {
  process.stderr.write(`Unknown subcommand: "${subcommand}"\n`);
  printUsage(1);
}

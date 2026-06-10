#!/usr/bin/env node
// agent-pack/query.js — zero-dependency lookup CLI for UE material node data.
// Returns single entries (~100-500 tokens) so authoring agents never read huge JSON files.
//
// Usage:
//   node query.js node <version> <Name> [<Name>...]
//   node query.js mf "<assetPath>" [<version>]
//   node query.js search <version> <term> [<term>...]
//   node query.js --help

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

// ---------------------------------------------------------------------------
// Data directory resolution
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.UEMAT_AGENT_PACK_DIR || path.dirname(__filename);

// ---------------------------------------------------------------------------
// Version discovery
// ---------------------------------------------------------------------------

function discoverVersions() {
  let entries;
  try {
    entries = fs.readdirSync(DATA_DIR);
  } catch {
    return [];
  }
  const versions = [];
  for (const f of entries) {
    // Match nodes-ueX.Y.json but NOT *.export.json or *.index.json
    const m = f.match(/^nodes-ue(.+)\.json$/);
    if (m && !f.endsWith('.export.json') && !f.endsWith('.index.json')) {
      versions.push(m[1]);
    }
  }
  return versions.sort();
}

function loadNodesDb(version) {
  const file = path.join(DATA_DIR, `nodes-ue${version}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function loadEngineMfIndex(version) {
  const file = path.join(DATA_DIR, `enginemf-index-ue${version}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function loadWorkMfIndex() {
  const file = path.join(DATA_DIR, 'workmf-index.json');
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function discoverEngineMfVersions() {
  let entries;
  try {
    entries = fs.readdirSync(DATA_DIR);
  } catch {
    return [];
  }
  const versions = [];
  for (const f of entries) {
    const m = f.match(/^enginemf-index-ue(.+)\.json$/);
    if (m) versions.push(m[1]);
  }
  return versions.sort();
}

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

  const versions = discoverVersions();
  if (!versions.includes(version)) {
    process.stderr.write(
      `No node DB for version "${version}". Available: ${versions.join(', ') || '(none)'}\n`,
    );
    process.exit(1);
  }

  const db = loadNodesDb(version);
  const nodes = db.nodes || {};
  const reservedTypes = db.reservedTypes || [];

  const result = {};
  let anyUnknown = false;

  for (const name of names) {
    // Check reserved types first
    if (reservedTypes.includes(name)) {
      result[name] = {
        reserved: true,
        note: "Reserved type - pins documented in SPEC.md 'Reserved node types'",
      };
      continue;
    }

    // Exact match
    if (Object.prototype.hasOwnProperty.call(nodes, name)) {
      result[name] = nodes[name];
      continue;
    }

    // Case-insensitive match
    const lowerName = name.toLowerCase();
    const ciKey = Object.keys(nodes).find((k) => k.toLowerCase() === lowerName);
    if (ciKey) {
      process.stderr.write(
        `Note: "${name}" not found; using canonical casing "${ciKey}"\n`,
      );
      result[name] = nodes[ciKey];
      continue;
    }

    // Not found — generate suggestions
    anyUnknown = true;
    const suggestions = findSuggestions(name, nodes, 5);
    if (suggestions.length > 0) {
      process.stderr.write(
        `"${name}" not found. Did you mean: ${suggestions.join(', ')}?\n`,
      );
    } else {
      process.stderr.write(`"${name}" not found.\n`);
    }
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(anyUnknown ? 1 : 0);
}

function findSuggestions(name, nodes, maxCount) {
  const lowerName = name.toLowerCase();
  const allKeys = Object.keys(nodes);

  // Case-insensitive substring of name
  const substringMatches = allKeys.filter((k) =>
    k.toLowerCase().includes(lowerName) || lowerName.includes(k.toLowerCase()),
  );

  if (substringMatches.length > 0) {
    return substringMatches.slice(0, maxCount);
  }

  // Category match: find the category of existing nodes whose name is close
  // Find any node whose name shares a category with a node that matches
  // For simplicity: find nodes in the same category as nodes that substring-match the term
  const categoryFallback = allKeys.filter((k) => {
    const entry = nodes[k];
    return (
      entry &&
      entry.category &&
      entry.category.toLowerCase().includes(lowerName)
    );
  });

  return categoryFallback.slice(0, maxCount);
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

  if (assetPath.startsWith('/Engine/')) {
    // Engine MF lookup
    let version = versionArg;
    if (!version) {
      const engineVersions = discoverEngineMfVersions();
      if (engineVersions.length === 1) {
        version = engineVersions[0];
      } else if (engineVersions.length === 0) {
        process.stderr.write(
          'Not in the Engine MF index - run the matching crawl from the viewer\'s Config tab; do not invent pin names.\n',
        );
        process.exit(1);
      } else {
        process.stderr.write(
          `Multiple enginemf-index versions found (${engineVersions.join(', ')}). Please specify a version.\n`,
        );
        process.exit(1);
      }
    }

    let index;
    try {
      index = loadEngineMfIndex(version);
    } catch {
      process.stderr.write(
        'Not in the Engine MF index - run the matching crawl from the viewer\'s Config tab; do not invent pin names.\n',
      );
      process.exit(1);
    }

    const entry = (index.functions || {})[assetPath];
    if (entry) {
      process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
      process.exit(0);
    } else {
      process.stderr.write(
        'Not in the Engine MF index - run the matching crawl from the viewer\'s Config tab; do not invent pin names.\n',
      );
      process.exit(1);
    }
  } else {
    // WorkMF lookup (any non-/Engine/ absolute path e.g. /Game/...)
    let index;
    try {
      index = loadWorkMfIndex();
    } catch {
      process.stderr.write(
        'Not in the WorkMF index - run the matching crawl from the viewer\'s Config tab; do not invent pin names.\n',
      );
      process.exit(1);
    }

    const entry = (index.functions || {})[assetPath];
    if (entry) {
      process.stdout.write(JSON.stringify(entry, null, 2) + '\n');
      process.exit(0);
    } else {
      process.stderr.write(
        'Not in the WorkMF index - run the matching crawl from the viewer\'s Config tab; do not invent pin names.\n',
      );
      process.exit(1);
    }
  }
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
  const terms = args.slice(1).map((t) => t.toLowerCase());

  const versions = discoverVersions();
  if (!versions.includes(version)) {
    process.stderr.write(
      `No node DB for version "${version}". Available: ${versions.join(', ') || '(none)'}\n`,
    );
    process.exit(1);
  }

  const db = loadNodesDb(version);
  const nodes = db.nodes || {};

  const matches = [];
  for (const [name, entry] of Object.entries(nodes)) {
    const haystack = [
      name,
      entry.category || '',
      entry.description || '',
    ]
      .join('\n')
      .toLowerCase();

    const allMatch = terms.every((t) => haystack.includes(t));
    if (!allMatch) continue;

    // Format: Name  [Category]  <first sentence of description>
    const firstSentence = (entry.description || '').split(/[.!?]/)[0].trim();
    let line = `${name}  [${entry.category || ''}]  ${firstSentence}`;

    if (entry.verified !== true) line += ' (unverified)';
    if (entry.dynamicPins === true) line += ' (dynamicPins)';

    matches.push({ name, line });
  }

  // Sort by name
  matches.sort((a, b) => a.name.localeCompare(b.name));

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

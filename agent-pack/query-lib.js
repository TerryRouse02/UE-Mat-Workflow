// agent-pack/query-lib.js — pure lookup logic for UE material node data.
// CommonJS, zero dependencies. All functions take an explicit dataDir argument;
// no process.env reads, no process.exit, no printing. Throws Error on failure;
// returns plain data on success.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Version discovery
// ---------------------------------------------------------------------------

function discoverVersions(dataDir) {
  let entries;
  try {
    entries = fs.readdirSync(dataDir);
  } catch {
    return [];
  }
  const versions = [];
  for (const f of entries) {
    const m = f.match(/^nodes-ue(.+)\.json$/);
    if (m && !f.endsWith('.export.json') && !f.endsWith('.index.json')) {
      versions.push(m[1]);
    }
  }
  return versions.sort();
}

function discoverEngineMfVersions(dataDir) {
  let entries;
  try {
    entries = fs.readdirSync(dataDir);
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
// DB loaders
// ---------------------------------------------------------------------------

function loadNodesDb(dataDir, version) {
  const file = path.join(dataDir, `nodes-ue${version}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function loadEngineMfIndex(dataDir, version) {
  const file = path.join(dataDir, `enginemf-index-ue${version}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

function loadWorkMfIndex(workMfIndexPath) {
  const raw = fs.readFileSync(workMfIndexPath, 'utf8');
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Node search helpers
// ---------------------------------------------------------------------------

function findSuggestions(name, nodes, maxCount) {
  const lowerName = name.toLowerCase();
  const allKeys = Object.keys(nodes);

  const substringMatches = allKeys.filter((k) =>
    k.toLowerCase().includes(lowerName) || lowerName.includes(k.toLowerCase()),
  );

  if (substringMatches.length > 0) {
    return substringMatches.slice(0, maxCount);
  }

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
// searchNodes — returns structured matches
// ---------------------------------------------------------------------------

/**
 * Search nodes in the DB matching all terms (AND logic).
 * @param {string} dataDir
 * @param {string} version
 * @param {string[]} terms — already lowercased
 * @param {{ category?: string }} [opts]
 * @returns {{ name: string; category: string; desc: string; verified: boolean; deprecated: boolean; dynamicPins: boolean; line: string }[]}
 */
function searchNodes(dataDir, version, terms, opts) {
  const versions = discoverVersions(dataDir);
  if (!versions.includes(version)) {
    throw new Error(
      `No node DB for version "${version}". Available: ${versions.join(', ') || '(none)'}`,
    );
  }

  const db = loadNodesDb(dataDir, version);
  const nodes = db.nodes || {};
  const lowerTerms = terms.map((t) => t.toLowerCase());

  const matches = [];
  for (const [name, entry] of Object.entries(nodes)) {
    if (opts && opts.category) {
      if ((entry.category || '').toLowerCase() !== opts.category.toLowerCase()) continue;
    }

    const haystack = [
      name,
      entry.category || '',
      entry.description || '',
    ]
      .join('\n')
      .toLowerCase();

    const allMatch = lowerTerms.every((t) => haystack.includes(t));
    if (!allMatch) continue;

    const firstSentence = (entry.description || '').split(/[.!?]/)[0].trim();
    let line = `${name}  [${entry.category || ''}]  ${firstSentence}`;
    if (entry.verified !== true) line += ' (unverified)';
    if (entry.dynamicPins === true) line += ' (dynamicPins)';

    matches.push({
      name,
      category: entry.category || '',
      desc: entry.description || '',
      verified: entry.verified === true,
      deprecated: entry.deprecated === true,
      dynamicPins: entry.dynamicPins === true,
      line,
    });
  }

  matches.sort((a, b) => a.name.localeCompare(b.name));
  return matches;
}

// ---------------------------------------------------------------------------
// getNodes — full DB entries + suggestions for misses
// ---------------------------------------------------------------------------

/**
 * Get full DB entries for the given names.
 * @param {string} dataDir
 * @param {string} version
 * @param {string[]} names
 * @returns {{ result: Record<string, unknown>; suggestions: Record<string, string[]> }}
 *   result: map of name → DB entry (or reserved stub)
 *   suggestions: map of missing name → suggestion array
 */
function getNodes(dataDir, version, names) {
  const versions = discoverVersions(dataDir);
  if (!versions.includes(version)) {
    throw new Error(
      `No node DB for version "${version}". Available: ${versions.join(', ') || '(none)'}`,
    );
  }

  const db = loadNodesDb(dataDir, version);
  const nodes = db.nodes || {};
  const reservedTypes = db.reservedTypes || [];

  const result = {};
  const suggestions = {};

  for (const name of names) {
    if (reservedTypes.includes(name)) {
      result[name] = {
        reserved: true,
        note: "Reserved type - pins documented in SPEC.md 'Reserved node types'",
      };
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(nodes, name)) {
      result[name] = nodes[name];
      continue;
    }

    const lowerName = name.toLowerCase();
    const ciKey = Object.keys(nodes).find((k) => k.toLowerCase() === lowerName);
    if (ciKey) {
      result[name] = nodes[ciKey];
      continue;
    }

    suggestions[name] = findSuggestions(name, nodes, 5);
  }

  return { result, suggestions };
}

// ---------------------------------------------------------------------------
// getMf — MF signature lookup
// ---------------------------------------------------------------------------

/**
 * Look up a Material Function signature by asset path.
 *
 * Routes:
 *   /Engine/... → enginemf-index-ue<version>.json in dataDir
 *   anything else → workMfIndexPath
 *
 * Return values:
 *   { found: true; entry: object }                  — hit
 *   { found: false; reason: 'not-in-index'; kind: 'engine'|'work' }
 *       — index was loaded but asset not present → hint to run matching crawl
 *   { found: false; reason: 'index-absent'; kind: 'engine'|'work' }
 *       — index file missing → hint to run matching crawl
 *
 * Throws for programmer errors (no assetPath, version missing for engine).
 *
 * @param {string} dataDir
 * @param {string} assetPath
 * @param {string} version
 * @param {string} [workMfIndexPath]
 */
function getMf(dataDir, assetPath, version, workMfIndexPath) {
  if (!assetPath) throw new Error('assetPath is required');

  if (assetPath.startsWith('/Engine/')) {
    // Engine MF — requires version
    let resolvedVersion = version;
    if (!resolvedVersion) {
      const engineVersions = discoverEngineMfVersions(dataDir);
      if (engineVersions.length === 1) {
        resolvedVersion = engineVersions[0];
      } else if (engineVersions.length === 0) {
        return { found: false, reason: 'index-absent', kind: 'engine' };
      } else {
        throw new Error(
          `Multiple enginemf-index versions found (${engineVersions.join(', ')}). Please specify a version.`,
        );
      }
    }

    let index;
    try {
      index = loadEngineMfIndex(dataDir, resolvedVersion);
    } catch {
      return { found: false, reason: 'index-absent', kind: 'engine' };
    }

    const entry = (index.functions || {})[assetPath];
    if (entry) {
      return { found: true, entry };
    }
    return { found: false, reason: 'not-in-index', kind: 'engine' };
  }

  // WorkMF — uses workMfIndexPath
  const indexPath = workMfIndexPath || (dataDir ? require('node:path').join(dataDir, 'workmf-index.json') : null);
  if (!indexPath) {
    return { found: false, reason: 'index-absent', kind: 'work' };
  }

  let index;
  try {
    index = loadWorkMfIndex(indexPath);
  } catch {
    return { found: false, reason: 'index-absent', kind: 'work' };
  }

  const entry = (index.functions || {})[assetPath];
  if (entry) {
    return { found: true, entry };
  }
  return { found: false, reason: 'not-in-index', kind: 'work' };
}

// ---------------------------------------------------------------------------
// searchMf — keyword search across the engine + work MF indexes
// ---------------------------------------------------------------------------

/**
 * Search Material Functions by keyword across the engine index (for the
 * given version) and, when available, the work index. All terms must match
 * (AND, case-insensitive) against assetPath + displayName + category.
 *
 * Missing indexes are skipped silently — searching must not fail just
 * because one side has not been crawled yet.
 *
 * @param {string} dataDir
 * @param {string[]} terms
 * @param {string} [version]            — engine index version; omitted →
 *                                        single discovered version, else engine skipped
 * @param {string} [workMfIndexPath]
 * @returns {{ assetPath: string; displayName: string; source: 'engine'|'work'; inputs: number; outputs: number; line: string }[]}
 */
function searchMf(dataDir, terms, version, workMfIndexPath) {
  const lowerTerms = terms.map((t) => t.toLowerCase()).filter(Boolean);
  if (lowerTerms.length === 0) throw new Error('at least one search term is required');

  const matches = [];

  function scan(functions, source) {
    for (const [assetPath, entry] of Object.entries(functions || {})) {
      const haystack = [
        assetPath,
        (entry && entry.displayName) || '',
        (entry && entry.category) || '',
      ]
        .join('\n')
        .toLowerCase();
      if (!lowerTerms.every((t) => haystack.includes(t))) continue;

      const displayName = (entry && entry.displayName) || assetPath.split('/').pop() || assetPath;
      const inputs = Array.isArray(entry && entry.inputs) ? entry.inputs.length : 0;
      const outputs = Array.isArray(entry && entry.outputs) ? entry.outputs.length : 0;
      matches.push({
        assetPath,
        displayName,
        source,
        inputs,
        outputs,
        line: `${displayName}  [${source}]  in:${inputs} out:${outputs}  ${assetPath}`,
      });
    }
  }

  // Engine index — resolve version like getMf does.
  let engineVersion = version;
  if (!engineVersion) {
    const engineVersions = discoverEngineMfVersions(dataDir);
    if (engineVersions.length === 1) engineVersion = engineVersions[0];
  }
  if (engineVersion) {
    try {
      scan(loadEngineMfIndex(dataDir, engineVersion).functions, 'engine');
    } catch {
      // engine index absent — skip
    }
  }

  // Work index — optional.
  if (workMfIndexPath) {
    try {
      scan(loadWorkMfIndex(workMfIndexPath).functions, 'work');
    } catch {
      // work index absent — skip
    }
  }

  matches.sort((a, b) => a.assetPath.localeCompare(b.assetPath));
  return matches;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  discoverVersions,
  loadNodesDb,
  searchNodes,
  getNodes,
  getMf,
  searchMf,
};

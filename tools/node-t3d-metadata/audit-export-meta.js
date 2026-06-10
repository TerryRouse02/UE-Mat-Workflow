const fs = require('fs');
const path = require('path');
const { agentPackPath } = require('./version');
const { findArrayPinDrift } = require('./array-pin-properties');
const { deriveDesc } = require('./gen-node-index');

function parseArgs(argv) {
  const args = {
    workflowRoot: path.resolve(__dirname, '..', '..'),
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--workflow-root') {
      args.workflowRoot = path.resolve(argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function declaredNames(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => (typeof item === 'string' ? item : item?.name))
    .filter((name) => typeof name === 'string' && name.length > 0);
}

function hasParamMap(meta, name) {
  if (meta.params?.[name]) return true;
  return Object.values(meta.params ?? {}).some((paramMeta) => (
    isPlainObject(paramMeta)
      && isPlainObject(paramMeta.components)
      && typeof paramMeta.components[name] === 'string'
  ));
}

function auditIndexDrift(workflowRoot, db) {
  const indexPath = agentPackPath(workflowRoot, 'index');
  const dbNodes = isPlainObject(db.nodes) ? db.nodes : {};
  const dbKeys = Object.keys(dbNodes);

  if (!fs.existsSync(indexPath)) {
    return { indexMissing: 1, indexDrift: 0, driftDetails: [] };
  }

  const idx = readJson(indexPath);
  const idxNodes = isPlainObject(idx.nodes) ? idx.nodes : {};
  const idxKeys = Object.keys(idxNodes);

  let driftCount = 0;
  const driftDetails = [];

  // Key-set parity: every DB key must be in the index and vice versa.
  const dbKeySet = new Set(dbKeys);
  const idxKeySet = new Set(idxKeys);
  for (const k of dbKeys) {
    if (!idxKeySet.has(k)) {
      driftCount += 1;
      driftDetails.push(`${k}: missing from index`);
    }
  }
  for (const k of idxKeys) {
    if (!dbKeySet.has(k)) {
      driftCount += 1;
      driftDetails.push(`${k}: extra key in index`);
    }
  }

  // Per-node field checks for nodes present in both.
  for (const k of dbKeys) {
    if (!idxKeySet.has(k)) continue;
    const node = dbNodes[k];
    const entry = idxNodes[k];

    const expectedVerified = Boolean(node.verified);
    if (entry.verified !== expectedVerified) {
      driftCount += 1;
      driftDetails.push(`${k}.verified: ${entry.verified} (expected ${expectedVerified})`);
    }

    const expectedDynamic = node.dynamicPins === true;
    const hasDynamic = entry.dynamicPins === true;
    if (hasDynamic !== expectedDynamic) {
      driftCount += 1;
      driftDetails.push(`${k}.dynamicPins: ${hasDynamic} (expected ${expectedDynamic})`);
    }

    const expectedDeprecated = node.deprecated === true;
    const hasDeprecated = entry.deprecated === true;
    if (hasDeprecated !== expectedDeprecated) {
      driftCount += 1;
      driftDetails.push(`${k}.deprecated: ${hasDeprecated} (expected ${expectedDeprecated})`);
    }

    const expectedDesc = deriveDesc(node.description);
    if (entry.desc !== expectedDesc) {
      driftCount += 1;
      driftDetails.push(`${k}.desc: "${entry.desc}" (expected "${expectedDesc}")`);
    }
  }

  return { indexMissing: 0, indexDrift: driftCount, driftDetails };
}

function audit(workflowRoot) {
  const dbPath = agentPackPath(workflowRoot, 'db');
  const exportPath = agentPackPath(workflowRoot, 'export');
  const db = readJson(dbPath);
  const exp = readJson(exportPath);

  const dbNodes = isPlainObject(db.nodes) ? db.nodes : {};
  const expNodes = isPlainObject(exp.nodes) ? exp.nodes : {};
  const reserved = isPlainObject(exp.reserved) ? exp.reserved : {};
  const dbKeys = Object.keys(dbNodes);
  const nodeKeys = Object.keys(expNodes);
  const reservedKeys = Object.keys(reserved);

  // `verified: false` authoring nodes are provisional — proposed (e.g. by node
  // discovery) but not yet regenerated into the export metadata on a UE host.
  // They are allowed to lag export coverage; verified:true nodes are not.
  const missing = dbKeys.filter((key) => !(key in expNodes) && dbNodes[key]?.verified !== false);
  const orphans = nodeKeys.filter((key) => !(key in dbNodes));
  const dynamic = nodeKeys.filter((key) => expNodes[key]?.dynamicExport === true);
  const verified = nodeKeys.filter((key) => expNodes[key]?.verified === true);
  const unresolved = nodeKeys.filter((key) => expNodes[key]?.verified !== true && expNodes[key]?.dynamicExport !== true);
  const reservedMissing = ['MaterialFunctionCall', 'FunctionInput', 'FunctionOutput'].filter((key) => !(key in reserved));
  const reservedUnexpected = reservedKeys.filter((key) => key === 'MaterialOutput');
  const structuralParams = {
    Custom: new Set(['Inputs', 'AdditionalOutputs', 'IncludeFilePaths', 'AdditionalDefines']),
  };

  const badShape = [];
  for (const [key, meta] of [...Object.entries(expNodes), ...Object.entries(reserved).map(([key, value]) => [`reserved:${key}`, value])]) {
    if (!isPlainObject(meta)) {
      badShape.push(`${key}: entry is not an object`);
      continue;
    }
    if (typeof meta.ueClass !== 'string' || meta.ueClass.length === 0) {
      badShape.push(`${key}.ueClass`);
    }
    for (const field of ['inputs', 'outputs', 'params']) {
      if (!isPlainObject(meta[field])) {
        badShape.push(`${key}.${field}`);
      }
    }
  }

  const missingMaps = [];
  for (const [key, node] of Object.entries(dbNodes)) {
    const meta = expNodes[key];
    if (!isPlainObject(meta) || meta.dynamicExport === true) {
      continue;
    }

    for (const name of declaredNames(node.inputs)) {
      if (!meta.inputs?.[name]) {
        missingMaps.push(`${key}.inputs.${name}`);
      }
    }
    for (const name of declaredNames(node.outputs)) {
      if (!meta.outputs?.[name]) {
        missingMaps.push(`${key}.outputs.${name}`);
      }
    }
    for (const name of declaredNames(node.params)) {
      if (structuralParams[key]?.has(name)) {
        continue;
      }
      if (!hasParamMap(meta, name)) {
        missingMaps.push(`${key}.params.${name}`);
      }
    }
  }

  // Array-element pin properties (e.g. CustomizedUVs(0), Inputs(2)) that a fresh
  // crawl regresses to their raw pin name. The parity checks above only compare pin
  // NAMES, so this is the only check that catches a property-VALUE regression.
  const arrayPins = findArrayPinDrift(exp).map(
    (d) => `${d.node}.inputs.${d.pin}: ${d.actual} (expected ${d.expected})`,
  );

  // Index drift: verify agent-pack/nodes-ue<v>.index.json is present and in sync with the DB.
  const indexResult = auditIndexDrift(workflowRoot, db);

  const failed = missing.length > 0
    || orphans.length > 0
    || unresolved.length > 0
    || reservedMissing.length > 0
    || reservedUnexpected.length > 0
    || badShape.length > 0
    || missingMaps.length > 0
    || arrayPins.length > 0
    || indexResult.indexMissing > 0
    || indexResult.indexDrift > 0;

  return {
    failed,
    summary: {
      db: dbKeys.length,
      export: nodeKeys.length,
      reserved: reservedKeys.length,
      missing: missing.length,
      orphans: orphans.length,
      verified: verified.length,
      dynamic: dynamic.length,
      unresolved: unresolved.length,
      badShape: badShape.length,
      missingMaps: missingMaps.length,
      arrayPins: arrayPins.length,
      indexMissing: indexResult.indexMissing,
      indexDrift: indexResult.indexDrift,
    },
    details: {
      missing,
      orphans,
      dynamic,
      unresolved,
      reservedMissing,
      reservedUnexpected,
      badShape,
      missingMaps,
      arrayPins,
      indexDrift: indexResult.driftDetails,
    },
  };
}

function printList(label, values) {
  if (values.length === 0) return;
  console.error(`${label}:`);
  for (const value of values) {
    console.error(`- ${value}`);
  }
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = audit(args.workflowRoot);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const s = result.summary;
      console.log(`db=${s.db} export=${s.export} reserved=${s.reserved} missing=${s.missing} orphans=${s.orphans} verified=${s.verified} dynamic=${s.dynamic} unresolved=${s.unresolved} badShape=${s.badShape} missingMaps=${s.missingMaps} arrayPins=${s.arrayPins} indexMissing=${s.indexMissing} indexDrift=${s.indexDrift}`);
      if (result.failed) {
        printList('Missing export metadata', result.details.missing);
        printList('Orphan export metadata', result.details.orphans);
        printList('Unresolved non-dynamic metadata', result.details.unresolved);
        printList('Missing reserved metadata', result.details.reservedMissing);
        printList('Unexpected reserved metadata', result.details.reservedUnexpected);
        printList('Bad metadata shape', result.details.badShape);
        printList('Missing declared pin/param maps', result.details.missingMaps);
        printList('Array-pin property drift (run heal-export-meta.js)', result.details.arrayPins);
        if (s.indexMissing > 0) {
          console.error('Index file missing: run node tools/node-t3d-metadata/gen-node-index.js');
        }
        printList('Node index drift (run gen-node-index.js)', result.details.indexDrift);
      }
    }
    process.exit(result.failed ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

module.exports = { audit, parseArgs };

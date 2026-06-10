// gen-node-index.js — generate agent-pack/nodes-ue<v>.index.json
// Plain Node.js, zero external dependencies.
//
// Usage:
//   node gen-node-index.js [--workflow-root <path>] [--ueVersion <v>]
//
// For each agent-pack/nodes-ue<v>.json (excluding *.export.json, *.index.json),
// or only the one named by --ueVersion <v>, writes agent-pack/nodes-ue<v>.index.json.
// Prints "nodes-ue<v>.index.json: <N> nodes" to stdout.

const fs = require('fs');
const path = require('path');

// Derive the "first sentence" description from a raw description string.
// Up to and including the first "." followed by a space or end-of-string.
// Falls back to the whole description if no sentence-ending "." is found.
// Hard-capped at 140 chars; if truncated, appends "..." (no ellipsis char).
function deriveDesc(raw) {
  if (!raw) return '';
  // Find first "." followed by a space or end-of-string.
  const m = raw.match(/^(.*?\.)(?:\s|$)/);
  let sentence = m ? m[1] : raw;
  if (sentence.length > 140) {
    sentence = sentence.slice(0, 137) + '...';
  }
  return sentence;
}

function buildIndex(db, version) {
  const dbNodes = db.nodes && typeof db.nodes === 'object' ? db.nodes : {};
  const nodes = {};
  for (const [name, node] of Object.entries(dbNodes)) {
    const entry = {
      category: node.category || 'Uncategorized',
      desc: deriveDesc(node.description),
      verified: Boolean(node.verified),
    };
    if (node.dynamicPins === true) entry.dynamicPins = true;
    if (node.deprecated === true) entry.deprecated = true;
    nodes[name] = entry;
  }
  return {
    ueVersion: version,
    generatedFrom: `nodes-ue${version}.json`,
    nodes,
  };
}

function parseArgs(argv) {
  const args = {
    workflowRoot: path.resolve(__dirname, '..', '..'),
    ueVersion: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workflow-root') {
      args.workflowRoot = path.resolve(argv[++i]);
    } else if (arg === '--ueVersion') {
      args.ueVersion = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

// Find all nodes-ue<v>.json files in agent-pack (excluding *.export.json, *.index.json).
function findDbFiles(agentPackDir) {
  const files = fs.readdirSync(agentPackDir);
  const results = [];
  for (const file of files) {
    const m = file.match(/^nodes-ue(\d+\.\d+)\.json$/);
    if (m) {
      results.push({ file, version: m[1] });
    }
  }
  return results;
}

function run(workflowRoot, ueVersion) {
  const agentPackDir = path.join(workflowRoot, 'agent-pack');
  let targets;
  if (ueVersion) {
    const file = `nodes-ue${ueVersion}.json`;
    const full = path.join(agentPackDir, file);
    if (!fs.existsSync(full)) {
      throw new Error(`DB file not found: ${full}`);
    }
    targets = [{ file, version: ueVersion }];
  } else {
    targets = findDbFiles(agentPackDir);
    if (targets.length === 0) {
      throw new Error(`No nodes-ue*.json files found in ${agentPackDir}`);
    }
  }

  for (const { file, version } of targets) {
    const dbPath = path.join(agentPackDir, file);
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    const index = buildIndex(db, version);
    const outFile = `nodes-ue${version}.index.json`;
    const outPath = path.join(agentPackDir, outFile);
    fs.writeFileSync(outPath, JSON.stringify(index, null, 2) + '\n');
    const count = Object.keys(index.nodes).length;
    console.log(`${outFile}: ${count} nodes`);
  }
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    run(args.workflowRoot, args.ueVersion);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = { deriveDesc, buildIndex, run, parseArgs };

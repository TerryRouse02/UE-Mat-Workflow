// Public-artifact purity gate (CLAUDE.md invariants 1-3).
//
// The committed agent-pack DATA files and the stress_* regression graphs must
// contain ONLY clean public Epic/UE data — never a private project's /Game asset
// paths or _project staging data — and the server-only / per-machine files must
// never be git-tracked. This is the check we run by hand after every crawl
// (e.g. confirming a regenerated enginemf-index is all /Engine/); CI runs it on
// every push so a crawl pointed at the wrong root, or a stray `git add`, fails loud.
//
// It uses GENERIC patterns only (/Game/, _project) — never a private project name,
// since the check itself is committed (invariant 2: no identifying data, even in guards).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { agentPackPath } = require('./version');

// --- pure, testable cores -------------------------------------------------

// Forbidden substrings for committed public DATA files. /Game/ = a project asset
// path; _project = the local staging/output convention. Both are generic.
const FORBIDDEN = [
  { re: /\/Game\//, label: '/Game/ asset path' },
  { re: /_project/, label: '_project reference' },
];

function findForbiddenInText(text, rel) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const { re, label } of FORBIDDEN) {
      if (re.test(lines[i])) out.push(`${rel}:${i + 1}: ${label}`);
    }
  }
  return out;
}

// Every engine-MF index key must be an /Engine/ object path.
function findNonEngineKeys(indexObj) {
  const fns = (indexObj && typeof indexObj.functions === 'object' && indexObj.functions) || {};
  return Object.keys(fns).filter((k) => !k.startsWith('/Engine/')).map((k) => `enginemf-index key not /Engine/: ${k}`);
}

// Sensitive paths that must never be git-tracked (server-only / per-machine / local).
const SENSITIVE_EXACT = [
  'agent-pack/workmf-index.json',
  'agent-pack/workmf-index.export.json',
  'agent-pack/crawl-freshness.json',
  'tools/node-t3d-metadata/local.config.json',
];
function findTrackedSensitive(trackedFiles) {
  const out = [];
  const set = new Set(trackedFiles);
  for (const p of SENSITIVE_EXACT) {
    if (set.has(p)) out.push(`sensitive file is git-tracked: ${p}`);
  }
  for (const p of trackedFiles) {
    if (p.startsWith('graphs/_project/')) out.push(`project graph is git-tracked: ${p}`);
    if (/\/Binaries\/Mac\/.*\.dylib$/.test(p)) out.push(`Mac binary is git-tracked: ${p}`);
  }
  return out;
}

// --- file/git wiring ------------------------------------------------------

function publicDataFiles(workflowRoot) {
  const files = [
    agentPackPath(workflowRoot, 'db'),
    agentPackPath(workflowRoot, 'export'),
    agentPackPath(workflowRoot, 'engineMf'),
  ];
  const graphsDir = path.join(workflowRoot, 'graphs');
  if (fs.existsSync(graphsDir)) {
    for (const entry of fs.readdirSync(graphsDir)) {
      if (!entry.startsWith('stress_')) continue;
      const dir = path.join(graphsDir, entry);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.matgraph.json')) files.push(path.join(dir, f));
      }
    }
  }
  return files.filter((f) => fs.existsSync(f));
}

function gitTrackedFiles(workflowRoot) {
  try {
    const out = execFileSync('git', ['ls-files'], { cwd: workflowRoot, encoding: 'utf8' });
    return { tracked: out.split('\n').filter(Boolean), available: true };
  } catch {
    return { tracked: [], available: false };
  }
}

function check(workflowRoot) {
  const forbidden = [];
  for (const file of publicDataFiles(workflowRoot)) {
    forbidden.push(...findForbiddenInText(fs.readFileSync(file, 'utf8'), path.relative(workflowRoot, file)));
  }

  const engineKeys = [];
  const engineFile = agentPackPath(workflowRoot, 'engineMf');
  if (fs.existsSync(engineFile)) {
    engineKeys.push(...findNonEngineKeys(JSON.parse(fs.readFileSync(engineFile, 'utf8'))));
  }

  const { tracked, available } = gitTrackedFiles(workflowRoot);
  const trackedSensitive = available ? findTrackedSensitive(tracked) : [];

  const failed = forbidden.length > 0 || engineKeys.length > 0 || trackedSensitive.length > 0;
  return {
    failed,
    gitChecked: available,
    summary: { forbidden: forbidden.length, engineKeys: engineKeys.length, trackedSensitive: trackedSensitive.length },
    details: { forbidden, engineKeys, trackedSensitive },
  };
}

// --- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const args = { workflowRoot: path.resolve(__dirname, '..', '..'), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--workflow-root') args.workflowRoot = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printList(label, values) {
  if (values.length === 0) return;
  console.error(`${label}:`);
  for (const v of values) console.error(`- ${v}`);
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = check(args.workflowRoot);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const s = result.summary;
      const git = result.gitChecked ? '' : ' (git tracking check skipped: git unavailable)';
      console.log(`forbidden=${s.forbidden} engineKeys=${s.engineKeys} trackedSensitive=${s.trackedSensitive}${git}`);
      if (result.failed) {
        printList('Forbidden tokens in public data', result.details.forbidden);
        printList('Non-/Engine engine-MF keys', result.details.engineKeys);
        printList('Git-tracked sensitive files', result.details.trackedSensitive);
      }
    }
    process.exit(result.failed ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

module.exports = { check, parseArgs, findForbiddenInText, findNonEngineKeys, findTrackedSensitive };

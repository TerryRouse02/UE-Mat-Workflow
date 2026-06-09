// Self-heal the export metadata's array-element pin properties after a crawl.
//
// The export commandlet regenerates agent-pack/nodes-ue5.7.export.json but emits
// the raw DB pin name (e.g. "Medium", "CustomizedUVs_0") for a handful of pins
// that must be UE T3D array-element syntax ("Inputs(2)", "CustomizedUVs(0)") to
// paste correctly — see array-pin-properties.js for the full list and the root
// cause. This step re-applies the canonical values right after generation so the
// crawl never regresses them, and is wired into Invoke-NodeT3DMetadataMaintenance.ps1.
//
// The export file is written by UE's JSON writer (tab indent, brace on its own
// line, NO trailing newline) which JSON.stringify does NOT reproduce. So this does
// a surgical, format-preserving splice: it changes ONLY the affected `property`
// values and leaves every other byte identical. It is idempotent (a canonical file
// is a no-op) and re-validates the result as JSON before writing.

const fs = require('fs');
const path = require('path');
const { agentPackPath } = require('./version');
const { findArrayPinDrift } = require('./array-pin-properties');

function parseArgs(argv) {
  const args = {
    workflowRoot: path.resolve(__dirname, '..', '..'),
    json: false,
    check: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--check') {
      args.check = true;
    } else if (arg === '--workflow-root') {
      args.workflowRoot = path.resolve(argv[++i]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Locate the [start, end) range of a top-level node block in the UE-JSON export
// text. Node keys sit at exactly two tabs of indent (`\n\t\t"<NodeKey>":`); a block
// runs until the next two-tab key (`\n\t\t"`) or the close of the `nodes` object
// (`\n\t}`). Returns null when the node is absent from the text.
function locateNodeBlock(text, nodeKey) {
  const marker = `\n\t\t${JSON.stringify(nodeKey)}:`;
  const start = text.indexOf(marker);
  if (start === -1) return null;
  const after = start + marker.length;
  const candidates = [text.indexOf('\n\t\t"', after), text.indexOf('\n\t}', after)]
    .filter((index) => index !== -1);
  const end = candidates.length ? Math.min(...candidates) : text.length;
  return { start, end };
}

// Set one input pin's `property` value within a single node block, preserving all
// other bytes. Throws unless the pin's property line is matched exactly once in the
// block (guards against ambiguous matches or silent no-ops). A pin key is unique
// within a node, so scoping to the block makes the match unambiguous even when two
// nodes share a pin name (e.g. QualitySwitch and FeatureLevelSwitch both use Inputs).
function setPinPropertyInText(text, node, pin, value) {
  const block = locateNodeBlock(text, node);
  if (!block) {
    throw new Error(`heal: cannot locate node block "${node}" in export metadata`);
  }
  const head = text.slice(0, block.start);
  const body = text.slice(block.start, block.end);
  const tail = text.slice(block.end);
  const pattern = new RegExp(
    `(${escapeRegExp(JSON.stringify(pin))}\\s*:\\s*\\{\\s*"property"\\s*:\\s*)"[^"]*"`,
    'g',
  );
  let count = 0;
  const newBody = body.replace(pattern, (match, prefix) => {
    count += 1;
    return `${prefix}${JSON.stringify(value)}`;
  });
  if (count !== 1) {
    throw new Error(
      `heal: expected exactly one "${pin}".property in node "${node}", found ${count}`,
    );
  }
  return head + newBody + tail;
}

// Apply every array-pin drift fix to the export text. Returns
// { text, fixes: [{ node, pin, from, to }], changed }. Pure on the input string.
function heal(text) {
  const before = JSON.parse(text); // validates input is JSON and reads current values
  const drift = findArrayPinDrift(before);
  let out = text;
  const fixes = [];
  for (const { node, pin, expected, actual } of drift) {
    out = setPinPropertyInText(out, node, pin, expected);
    fixes.push({ node, pin, from: actual, to: expected });
  }
  if (fixes.length > 0) {
    const residual = findArrayPinDrift(JSON.parse(out)); // must still be valid JSON, now canonical
    if (residual.length > 0) {
      throw new Error(
        `heal: drift remained after applying fixes: ${residual.map((d) => `${d.node}.${d.pin}`).join(', ')}`,
      );
    }
  }
  return { text: out, fixes, changed: fixes.length > 0 };
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const file = agentPackPath(args.workflowRoot, 'export');
    const text = fs.readFileSync(file, 'utf8');

    if (args.check) {
      const drift = findArrayPinDrift(JSON.parse(text));
      if (args.json) {
        console.log(JSON.stringify({ drift }, null, 2));
      } else if (drift.length > 0) {
        console.error(`Array-pin property drift: ${drift.length}`);
        for (const d of drift) {
          console.error(`- ${d.node}.${d.pin}: ${d.actual} (expected ${d.expected})`);
        }
      } else {
        console.log('Array-pin properties are canonical.');
      }
      process.exit(drift.length > 0 ? 1 : 0);
    }

    const result = heal(text);
    if (result.changed) {
      // Atomic write: stage to a sibling temp file then rename, so a crash mid-write
      // can never leave the committed export JSON truncated.
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, result.text);
      fs.renameSync(tmp, file);
    }
    if (args.json) {
      console.log(JSON.stringify({ changed: result.changed, fixes: result.fixes }, null, 2));
    } else if (result.changed) {
      console.log(`Healed ${result.fixes.length} array-pin propert${result.fixes.length === 1 ? 'y' : 'ies'}:`);
      for (const fix of result.fixes) {
        console.log(`- ${fix.node}.${fix.pin}: ${fix.from} -> ${fix.to}`);
      }
    } else {
      console.log('Export metadata array-pin properties already canonical; no changes.');
    }
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

module.exports = { heal, parseArgs, locateNodeBlock, setPinPropertyInText };

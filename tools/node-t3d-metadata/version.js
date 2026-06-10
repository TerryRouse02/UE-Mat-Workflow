// Single source of truth for the UE version the Node tooling targets.
// Bumping the engine (e.g. 5.7 -> 5.8) starts here: the JS tools derive their
// agent-pack filenames from UE_VERSION instead of hard-coding "5.7".
//
// Scope note: this only centralizes the *Node* layer. The PowerShell runners
// and the C++ commandlet still spell the version in their own paths/usage
// strings (a cross-language constant isn't worth the indirection); a version
// bump must still update those. Searching the repo for the previous version
// string remains the migration checklist for the non-JS layers.
const path = require('path');

const UE_VERSION = '5.7';

// agent-pack data filenames, keyed by role.
const fileNames = {
  db: `nodes-ue${UE_VERSION}.json`,
  export: `nodes-ue${UE_VERSION}.export.json`,
  engineMf: `enginemf-index-ue${UE_VERSION}.json`,
  index: `nodes-ue${UE_VERSION}.index.json`,
};

// Absolute path to an agent-pack data file for a given workflow root.
function agentPackPath(workflowRoot, key) {
  if (!(key in fileNames)) {
    throw new Error(`Unknown agent-pack file key: ${key}`);
  }
  return path.join(workflowRoot, 'agent-pack', fileNames[key]);
}

module.exports = { UE_VERSION, fileNames, agentPackPath };

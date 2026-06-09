const fs = require('fs');
const path = require('path');

const bundleRoot = __dirname;
const repoRoot = path.resolve(bundleRoot, '..', '..');

const required = [
  'README.md',
  'version.js',
  'local.config.example.json',
  'tests/audit.test.js',
  'tests/build-db-candidates.test.js',
  'tests/cli.test.js',
  'tests/heal-export-meta.test.js',
  'tests/check-public-purity.test.js',
  'tests/offline-gates.test.js',
  'docs/AGENT_WORKFLOW.md',
  'docs/VERIFICATION.md',
  'docs/WORKMF.md',
  'docs/ENGINE_MF.md',
  'docs/NODE_DISCOVERY.md',
  'docs/PROJECT_MATERIALS.md',
  'skill/node-t3d-metadata/SKILL.md',
  'Invoke-NodeT3DMetadataMaintenance.ps1',
  'audit-export-meta.js',
  'heal-export-meta.js',
  'array-pin-properties.js',
  'check-public-purity.js',
  'plugin-src/UEMatExportMetadata.uplugin',
  'plugin-src/Source/UEMatExportMetadata/UEMatExportMetadata.Build.cs',
  'plugin-src/Source/UEMatExportMetadata/Private/UEMatExportMetadataCommandlet.cpp',
  'plugin-src/Scripts/Package-Plugin.ps1',
  'plugin-src/Scripts/Run-UEMatExportMetadata.ps1',
  'plugin-src/Scripts/Run-WorkMfIndex.ps1',
  'plugin-src/Scripts/Run-EngineMfIndex.ps1',
  'plugin-src/Scripts/Capture-CoreClipboardSample.ps1',
  'plugin-src/Scripts/Capture-MakeMaterialAttributesSample.ps1',
  'plugin-src/Scripts/Capture-TextureSampleSources.ps1',
  'plugin-src/Scripts/Sync-ToProject.ps1',
  'compiled/UEMatExportMetadata/UEMatExportMetadata.uplugin',
  'compiled/UEMatExportMetadata/Binaries/Win64/UnrealEditor-UEMatExportMetadata.dll',
];

const forbidden = [
  path.join(repoRoot, 'tools', 'ue-metadata-plugin'),
  path.join(repoRoot, 'artifacts', 'ue', 'UEMatExportMetadata'),
];

const missing = required.filter((file) => !fs.existsSync(path.join(bundleRoot, file)));
const leftovers = forbidden.filter((file) => fs.existsSync(file));

const scriptChecks = [
  ['Invoke-NodeT3DMetadataMaintenance.ps1', 'ProjectPath'],
  ['Invoke-NodeT3DMetadataMaintenance.ps1', 'EngineRoot'],
  ['Invoke-NodeT3DMetadataMaintenance.ps1', 'audit-export-meta.js'],
  ['Invoke-NodeT3DMetadataMaintenance.ps1', 'heal-export-meta.js'],
  ['plugin-src/Scripts/Package-Plugin.ps1', 'EngineRoot'],
  ['plugin-src/Scripts/Run-UEMatExportMetadata.ps1', 'ProjectPath'],
  ['plugin-src/Scripts/Run-WorkMfIndex.ps1', 'WorkMfOut'],
  ['plugin-src/Scripts/Run-EngineMfIndex.ps1', 'enginemf-index-ue5.7.json'],
  ['Invoke-NodeT3DMetadataMaintenance.ps1', 'WorkMF'],
  ['docs/WORKMF.md', 'workmf-index.json'],
  ['docs/ENGINE_MF.md', 'enginemf-index-ue5.7.json'],
  ['plugin-src/Scripts/Capture-CoreClipboardSample.ps1', 'CoreClipboardOut'],
  ['plugin-src/Scripts/Capture-MakeMaterialAttributesSample.ps1', 'ProjectPath'],
  ['plugin-src/Scripts/Capture-TextureSampleSources.ps1', 'TextureAsset'],
  ['skill/node-t3d-metadata/SKILL.md', 'Invoke-NodeT3DMetadataMaintenance.ps1'],
  ['skill/node-t3d-metadata/SKILL.md', 'agent-pack\\nodes-ue5.7.export.json'],
  ['docs/AGENT_WORKFLOW.md', 'agent-pack\\nodes-ue5.7.export.json'],
  ['docs/VERIFICATION.md', 'audit-export-meta.js'],
  ['docs/VERIFICATION.md', 'heal-export-meta.js'],
];

const badContent = [];
for (const [file, token] of scriptChecks) {
  const full = path.join(bundleRoot, file);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');
  if (!text.includes(token)) badContent.push(`${file} missing ${token}`);
}

// Recursively list files with a given extension, skipping build/dep scratch.
function listFiles(dir, ext) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'Intermediate' || entry.name === 'Binaries') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

// Invariant 4: .ps1 runners must stay pure ASCII. Windows PowerShell 5.1 mis-reads
// non-BOM UTF-8 (em dash, ellipsis, smart quotes) and string parsing breaks. Flag
// the first byte > 0x7F in any bundled .ps1.
const nonAscii = [];
for (const ps1 of listFiles(bundleRoot, '.ps1')) {
  const buf = fs.readFileSync(ps1);
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] > 0x7f) {
      nonAscii.push(`${path.relative(bundleRoot, ps1)}: non-ASCII byte 0x${buf[i].toString(16)} at offset ${i}`);
      break;
    }
  }
}

// The commandlet C++ is kept in two byte-identical copies: the source of truth under
// plugin-src/Source and the bundled copy under compiled/.../Source (shipped so the
// package carries its own source). An edit to one but not the other is a bug.
const cppDrift = [];
const srcRoot = path.join(bundleRoot, 'plugin-src', 'Source');
const compiledSrcRoot = path.join(bundleRoot, 'compiled', 'UEMatExportMetadata', 'Source');
if (fs.existsSync(srcRoot) && fs.existsSync(compiledSrcRoot)) {
  for (const f of listFiles(srcRoot, '.cpp')) {
    const rel = path.relative(srcRoot, f);
    const counterpart = path.join(compiledSrcRoot, rel);
    if (!fs.existsSync(counterpart)) cppDrift.push(`compiled copy missing: Source/${rel}`);
    else if (!fs.readFileSync(f).equals(fs.readFileSync(counterpart))) cppDrift.push(`plugin-src vs compiled drift: Source/${rel}`);
  }
}

if (missing.length || leftovers.length || badContent.length || nonAscii.length || cppDrift.length) {
  if (missing.length) console.error(`Missing organized tooling files:\n${missing.map((f) => `- ${f}`).join('\n')}`);
  if (leftovers.length) console.error(`Old tool locations still exist:\n${leftovers.map((f) => `- ${f}`).join('\n')}`);
  if (badContent.length) console.error(`Content checks failed:\n${badContent.map((f) => `- ${f}`).join('\n')}`);
  if (nonAscii.length) console.error(`.ps1 files with non-ASCII bytes (invariant 4):\n${nonAscii.map((f) => `- ${f}`).join('\n')}`);
  if (cppDrift.length) console.error(`Commandlet C++ copy drift (plugin-src vs compiled):\n${cppDrift.map((f) => `- ${f}`).join('\n')}`);
  process.exit(1);
}

console.log('Node T3D metadata tooling bundle is organized and documented.');

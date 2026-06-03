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
  'docs/AGENT_WORKFLOW.md',
  'docs/VERIFICATION.md',
  'docs/WORKMF.md',
  'docs/ENGINE_MF.md',
  'skill/node-t3d-metadata/SKILL.md',
  'Invoke-NodeT3DMetadataMaintenance.ps1',
  'audit-export-meta.js',
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
];

const badContent = [];
for (const [file, token] of scriptChecks) {
  const full = path.join(bundleRoot, file);
  if (!fs.existsSync(full)) continue;
  const text = fs.readFileSync(full, 'utf8');
  if (!text.includes(token)) badContent.push(`${file} missing ${token}`);
}

if (missing.length || leftovers.length || badContent.length) {
  if (missing.length) console.error(`Missing organized tooling files:\n${missing.map((f) => `- ${f}`).join('\n')}`);
  if (leftovers.length) console.error(`Old tool locations still exist:\n${leftovers.map((f) => `- ${f}`).join('\n')}`);
  if (badContent.length) console.error(`Content checks failed:\n${badContent.map((f) => `- ${f}`).join('\n')}`);
  process.exit(1);
}

console.log('Node T3D metadata tooling bundle is organized and documented.');

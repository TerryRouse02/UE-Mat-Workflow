const fs = require('fs');
const path = require('path');

const bundleRoot = __dirname;
const repoRoot = path.resolve(bundleRoot, '..', '..');

const required = [
  'README.md',
  'docs/AGENT_WORKFLOW.md',
  'docs/VERIFICATION.md',
  'skill/node-t3d-metadata/SKILL.md',
  'plugin-src/UEMatExportMetadata.uplugin',
  'plugin-src/Source/UEMatExportMetadata/UEMatExportMetadata.Build.cs',
  'plugin-src/Source/UEMatExportMetadata/Private/UEMatExportMetadataCommandlet.cpp',
  'plugin-src/Scripts/Package-Plugin.ps1',
  'plugin-src/Scripts/Run-UEMatExportMetadata.ps1',
  'plugin-src/Scripts/Sync-To-G1Project.ps1',
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
  ['plugin-src/Scripts/Package-Plugin.ps1', 'compiled\\UEMatExportMetadata'],
  ['plugin-src/Scripts/Run-UEMatExportMetadata.ps1', 'compiled\\UEMatExportMetadata'],
  ['skill/node-t3d-metadata/SKILL.md', 'Run-UEMatExportMetadata.ps1'],
  ['skill/node-t3d-metadata/SKILL.md', 'agent-pack\\nodes-ue5.7.export.json'],
  ['docs/AGENT_WORKFLOW.md', 'agent-pack\\nodes-ue5.7.export.json'],
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

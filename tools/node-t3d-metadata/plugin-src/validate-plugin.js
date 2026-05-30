const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname);
const requiredFiles = [
  'UEMatExportMetadata.uplugin',
  'Source/UEMatExportMetadata/UEMatExportMetadata.Build.cs',
  'Source/UEMatExportMetadata/Public/UEMatExportMetadataCommandlet.h',
  'Source/UEMatExportMetadata/Private/UEMatExportMetadataCommandlet.cpp',
  'Source/UEMatExportMetadata/Private/UEMatExportMetadataModule.cpp',
  'Scripts/Sync-To-G1Project.ps1',
  'Scripts/Run-UEMatExportMetadata.ps1',
  'Scripts/Capture-MakeMaterialAttributesSample.ps1',
  'Scripts/Package-Plugin.ps1',
];

const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length > 0) {
  console.error(`Missing plugin files:\n${missing.map((file) => `- ${file}`).join('\n')}`);
  process.exit(1);
}

const descriptor = JSON.parse(fs.readFileSync(path.join(root, 'UEMatExportMetadata.uplugin'), 'utf8'));
if (!descriptor.Modules?.some((mod) => mod.Name === 'UEMatExportMetadata' && mod.Type === 'Editor')) {
  console.error('Descriptor must define the UEMatExportMetadata Editor module.');
  process.exit(1);
}

const commandlet = fs.readFileSync(path.join(root, 'Source/UEMatExportMetadata/Private/UEMatExportMetadataCommandlet.cpp'), 'utf8');
for (const token of ['NodeDb=', 'Out=', 'MakeMaterialAttributesSampleOut=', 'UMaterialExpression', 'FJsonSerializer', 'functionAsset']) {
  if (!commandlet.includes(token)) {
    console.error(`Commandlet source is missing expected token: ${token}`);
    process.exit(1);
  }
}

console.log('UEMatExportMetadata plugin source layout is valid.');

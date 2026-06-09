# Verification

Run these commands from the workflow repo root.

## One-Command Verification

On Windows (Windows PowerShell 5.1):

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine>
```

On macOS (PowerShell Core 7, `pwsh`):

```bash
pwsh -File ./tools/node-t3d-metadata/Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath </path/to/Project.uproject> `
  -EngineRoot </path/to/UnrealEngine>
```

This packages the plugin when needed, regenerates metadata, heals the array-element pin properties, audits the JSON, and runs the targeted viewer tests.

## Tooling Layout

```powershell
node tools\node-t3d-metadata\validate-tooling.js
node tools\node-t3d-metadata\plugin-src\validate-plugin.js
```

Expected output:

```text
Node T3D metadata tooling bundle is organized and documented.
UEMatExportMetadata plugin source layout is valid.
```

## Metadata Audit

```powershell
node tools\node-t3d-metadata\audit-export-meta.js
```

Passing output has zero `missing`, `orphans`, `unresolved`, `badShape`, `missingMaps`, and `arrayPins`. The exact node counts are intentionally not hard-coded here because they change when the node database changes.

`arrayPins` is the count of array-element pin properties (e.g. `CustomizedUVs(0)`, `Inputs(2)`) that drifted back to their raw pin name. A fresh crawl heals these automatically (the "Heal export metadata array pins" step runs `heal-export-meta.js` before this audit); if you ever see `arrayPins > 0`, run `node tools\node-t3d-metadata\heal-export-meta.js` to repair the file, or `--check` to list the drift without writing.

`verified: false` authoring nodes (e.g. ones just added by node discovery, pin names reflected but types not yet hand-checked) are **provisional**: the audit lets them lag export coverage, so they are not counted as `missing`. `verified: true` nodes must be present in the export metadata.

For machine-readable output:

```powershell
node tools\node-t3d-metadata\audit-export-meta.js --json
```

## UE Commandlet Log

Check `Logs\UE\UEMatExportMetadata_Commandlet.log` for:

```text
Warnings: 0
Success - 0 error(s), 0 warning(s)
```

## Viewer Tests

If dependencies are installed:

On Windows:

```powershell
.\viewer\node_modules\.bin\vitest.cmd run viewer\tests\export-meta.test.ts viewer\tests\ueT3D.test.ts
```

On macOS:

```bash
./viewer/node_modules/.bin/vitest run viewer/tests/export-meta.test.ts viewer/tests/ueT3D.test.ts
```

If `viewer/node_modules` is missing, install dependencies with the repo package manager first. If registry access is blocked, report dependency installation as the environment blocker rather than claiming Vitest passed.

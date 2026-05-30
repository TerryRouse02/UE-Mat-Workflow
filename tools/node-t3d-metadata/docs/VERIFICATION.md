# Verification

Run these commands from the workflow repo root.

## One-Command Verification

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine>
```

This packages the plugin when needed, regenerates metadata, audits the JSON, and runs the targeted viewer tests.

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

Passing output has zero `missing`, `orphans`, `unresolved`, and `badShape`. The exact node counts are intentionally not hard-coded here because they change when the node database changes.

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

```powershell
.\viewer\node_modules\.bin\vitest.cmd run viewer\tests\export-meta.test.ts viewer\tests\ueT3D.test.ts
```

If `viewer\node_modules` is missing, install dependencies with the repo package manager first. If registry access is blocked, report dependency installation as the environment blocker rather than claiming Vitest passed.

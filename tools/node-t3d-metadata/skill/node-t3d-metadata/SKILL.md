---
name: node-t3d-metadata
description: Use when updating UE material node T3D/export metadata, nodeT3D metadata, nodes-ue5.7.export.json, Unreal material export maps, or UE-Mat-Workflow node database export support.
---

# Node T3D Metadata

This is a portable agent workflow. It does not require Codex-specific features. Any agent that can read Markdown and run PowerShell can use it.

## Core Rules

- Update `agent-pack\nodes-ue5.7.export.json`; do not edit `agent-pack\nodes-ue5.7.json` unless the user explicitly asks.
- Do not edit `G1_Project.uproject`.
- Use the compiled external plugin in `tools\node-t3d-metadata\compiled\UEMatExportMetadata` for normal runs.
- Do not guess UE class paths or pin mappings; use the commandlet and audit the output.

## Workflow

From the repo root, rebuild the plugin only if `plugin-src/` changed or the compiled package is missing:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Package-Plugin.ps1 -G1Root D:\SDGF_G1_Project
```

Generate metadata:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Run-UEMatExportMetadata.ps1 -G1Root D:\SDGF_G1_Project
```

Verify:

```powershell
node tools\node-t3d-metadata\validate-tooling.js
node tools\node-t3d-metadata\plugin-src\validate-plugin.js
```

Then run the metadata audit from `tools\node-t3d-metadata\docs\VERIFICATION.md`.

## Success Criteria

- Commandlet log says `Warnings: 0` and `Success - 0 error(s), 0 warning(s)`.
- Audit says `missing=0`, `orphans=0`, `unresolved=0`, and `badShape=0`.
- Current expected counts are `db=142`, `export=142`, `reserved=3`, `verified=138`, `dynamic=4`.

## Troubleshooting

- If the run script reports a project plugin shadowing the compiled plugin, verify and remove only `D:\SDGF_G1_Project\G1_Project\Plugins\UEMatExportMetadata`.
- If building with `-UseProjectPlugin`, close `UnrealEditor` and `LiveCodingConsole` first.
- If Vitest cannot run because `viewer\node_modules` is missing, report dependency installation as the blocker.

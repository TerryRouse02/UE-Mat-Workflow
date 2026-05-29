# Agent Workflow

Use this workflow when updating UE material node T3D/export metadata for this repo.

## Scope

- Input DB: `agent-pack\nodes-ue5.7.json`
- Output metadata: `agent-pack\nodes-ue5.7.export.json`
- UE project root: normally `D:\SDGF_G1_Project`
- UE plugin bundle: `tools\node-t3d-metadata`

Do not edit `agent-pack\nodes-ue5.7.json` unless the user explicitly asks for node DB changes. Do not edit `G1_Project.uproject`.

## Commands

Run from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Run-UEMatExportMetadata.ps1 -G1Root D:\SDGF_G1_Project
```

If the compiled plugin is missing, or if `plugin-src/` was changed, rebuild first:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Package-Plugin.ps1 -G1Root D:\SDGF_G1_Project
```

The run script loads `compiled\UEMatExportMetadata\UEMatExportMetadata.uplugin` as an external plugin and writes `agent-pack\nodes-ue5.7.export.json`.

## Guardrails

- Prefer the compiled plugin path. Do not sync into `D:\SDGF_G1_Project\G1_Project\Plugins` for normal metadata updates.
- If `D:\SDGF_G1_Project\G1_Project\Plugins\UEMatExportMetadata` exists, UE will shadow the compiled plugin. Remove only that generated folder after verifying it contains `UEMatExportMetadata.uplugin`.
- Use `-UseProjectPlugin` only when actively debugging the plugin source inside G1. That mode requires closing `UnrealEditor` and `LiveCodingConsole` before building.
- Do not guess class names. The commandlet owns UE reflection, built-in Material Function wrappers, reserved nodes, and dynamic-node handling.

## Expected Result

Successful commandlet logs include:

```text
Wrote UE export metadata: D:/Agent_Dev/UE-Mat-Workflow/agent-pack/nodes-ue5.7.export.json
Warnings: 0
Success - 0 error(s), 0 warning(s)
```

Then run the checks in `docs/VERIFICATION.md`.

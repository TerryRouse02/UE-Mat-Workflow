# Agent Workflow

Use this workflow when updating UE material node T3D/export metadata for this repo.

## Scope

- Input DB: `agent-pack\nodes-ue5.7.json`
- Output metadata: `agent-pack\nodes-ue5.7.export.json`
- UE host: any compatible `.uproject` plus its `UnrealEngine` root
- UE plugin bundle: `tools\node-t3d-metadata`

Do not edit `agent-pack\nodes-ue5.7.json` unless the user explicitly asks for node DB changes. Do not edit the host `.uproject`; it is only used to run the editor commandlet.

## Command

Run from the repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine>
```

The entrypoint loads `compiled\UEMatExportMetadata\UEMatExportMetadata.uplugin` as an external plugin, rebuilds it when needed, writes `agent-pack\nodes-ue5.7.export.json`, audits the output, and runs the targeted viewer tests.

Use `-CaptureFixtures` only when calibrating clipboard/T3D emitter behavior:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine> `
  -CaptureFixtures
```

## Guardrails

- Prefer the compiled external plugin path. Do not copy the plugin into the host project for normal metadata updates.
- If `<ProjectDir>\Plugins\UEMatExportMetadata\UEMatExportMetadata.uplugin` exists, UE will shadow the compiled plugin. Remove only that generated folder after verifying it contains `UEMatExportMetadata.uplugin`.
- Use project-plugin mode only while debugging the plugin source against a specific project; close `UnrealEditor` and `LiveCodingConsole` before building that mode.
- Do not guess class names. The commandlet owns UE reflection, built-in Material Function wrappers, reserved nodes, and dynamic-node handling.

## Expected Result

Successful commandlet logs include:

```text
Wrote UE export metadata: <repo>/agent-pack/nodes-ue5.7.export.json
Warnings: 0
Success - 0 error(s), 0 warning(s)
```

Then run or review the checks in `docs/VERIFICATION.md`.

## WorkMF mode (index the project's own Material Functions)

A separate mode crawls the user's **own** project Material Functions into the local,
gitignored `agent-pack/workmf-index.json` (it does NOT touch `nodes-ue5.7.export.json`):

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot  <Path\To\UnrealEngine> `
  -WorkMF
```

Full details, schema, content-root options, and the Codex hand-off prompt are in
`docs/WORKMF.md`.

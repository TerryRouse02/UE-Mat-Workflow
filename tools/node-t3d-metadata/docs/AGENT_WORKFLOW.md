# Agent Workflow

Use this workflow when updating UE material node T3D/export metadata for this repo.

## Scope

- Input DB: `agent-pack\nodes-ue5.7.json`
- Output metadata: `agent-pack\nodes-ue5.7.export.json`
- UE host: any compatible `.uproject` plus its `UnrealEngine` root
- UE plugin bundle: `tools\node-t3d-metadata`

Do not edit `agent-pack\nodes-ue5.7.json` unless the user explicitly asks for node DB changes. Do not edit the host `.uproject`; it is only used to run the editor commandlet.

## Command

The same `.ps1` runners serve both OSes (they platform-detect the editor binary via `$IsMacOS`):
Windows uses Windows PowerShell 5.1 (`powershell`); macOS uses PowerShell Core 7 (`pwsh`,
installed via the official PowerShell `.pkg` or `brew install --cask powershell`). Use native
paths per OS for `-ProjectPath`/`-EngineRoot`.

Run from the repo root:

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine>
```

```pwsh
# macOS
pwsh -File ./tools/node-t3d-metadata/Invoke-NodeT3DMetadataMaintenance.ps1 \
  -ProjectPath /path/to/Project.uproject \
  -EngineRoot /path/to/UnrealEngine
```

The entrypoint loads `compiled\UEMatExportMetadata\UEMatExportMetadata.uplugin` as an external plugin, rebuilds it when needed, writes `agent-pack\nodes-ue5.7.export.json`, audits the output, and runs the targeted viewer tests.

Use `-CaptureFixtures` only when calibrating clipboard/T3D emitter behavior (on macOS, swap
`powershell -ExecutionPolicy Bypass` for `pwsh` and use native paths):

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

## Node discovery mode (find what the DB is missing)

Before adding nodes, find out which ones the engine has that the DB doesn't. Discovery
enumerates every `UMaterialExpression` by reflection and diffs against the DB (on macOS, swap
`powershell -ExecutionPolicy Bypass` for `pwsh` and use native paths):

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Run-NodeDiscovery.ps1 `
  -EngineRoot <Path\To\UnrealEngine>
```

`-ProjectPath` is optional here — discovery enumerates engine C++ classes, so when it is omitted
the script uses the bundled minimal host (`host\NodeDiscoveryHost.uproject`), which also sidesteps
the default engine plugins that abort the commandlet on some installs. Pass your own `-ProjectPath`
to run against a specific project.

Then `node tools\node-t3d-metadata\build-db-candidates.js` turns the report into candidate
authoring entries. Newly added nodes stay **`verified: false`** until hand-checked — pin
**names** are reflected (safe), but **types** are placeholders. The audit permits
`verified: false` nodes to lag export coverage; `verified: true` nodes must be in the export
metadata. Full details in `docs/NODE_DISCOVERY.md`.

## WorkMF mode (index the project's own Material Functions)

A separate mode crawls the user's **own** project Material Functions into the local,
gitignored `agent-pack/workmf-index.json` (it does NOT touch `nodes-ue5.7.export.json`; on macOS,
swap `powershell -ExecutionPolicy Bypass` for `pwsh` and use native paths):

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot  <Path\To\UnrealEngine> `
  -WorkMF
```

Full details, schema, content-root options, and the Codex hand-off prompt are in
`docs/WORKMF.md`.

## Engine-MF mode (index the official `/Engine/Functions` Material Functions)

Built-in Material Functions (`/Engine/Functions/**`) are shipped assets, not C++ expressions,
so neither the node DB nor node-discovery covers them. Without an index, a material that calls
one exports with every `FunctionInputs(n)` collapsed onto index 0 (broken wires on paste). The
engine-MF crawl is the same WorkMF crawl pointed at the engine, but its output **is committed**
(stable shipped data shared by all users; on macOS, swap `powershell -ExecutionPolicy Bypass` for
`pwsh` and use native paths):

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Run-EngineMfIndex.ps1 `
  -EngineRoot <Path\To\UnrealEngine>
```

`-ProjectPath` is optional (defaults to the bundled minimal host). Output:
`agent-pack/enginemf-index-ue5.7.json` — review the diff and commit it. Full details and the
hand-off prompt are in `docs/ENGINE_MF.md`.

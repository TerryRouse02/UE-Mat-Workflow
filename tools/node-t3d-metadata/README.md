# Node T3D Metadata Tooling

> 繁體中文版本見 [`README.zh-TW.md`](./README.zh-TW.md)（英文版為正式來源）。

This folder is the self-contained maintenance bundle for UE material node T3D/export metadata. It is project-agnostic: pass any compatible UE `.uproject` and `UnrealEngine` root as the commandlet host.

## Contents

- `Invoke-NodeT3DMetadataMaintenance.ps1`: one-command metadata maintenance entrypoint.
- `audit-export-meta.js`: reusable metadata audit command.
- `build-db-candidates.js`: turn a node-discovery report into reviewable candidate DB entries.
- `plugin-src/`: UE editor plugin source for the `UEMatExportMetadata` commandlet.
- `plugin-src/Scripts/Run-NodeDiscovery.ps1`: enumerate engine expressions and diff vs the DB.
- `plugin-src/Scripts/Run-WorkMfIndex.ps1`: index a project's own Material Functions (WorkMF).
- `plugin-src/Scripts/Run-EngineMfIndex.ps1`: index the official `/Engine/Functions` Material Functions into a committed index.
- `compiled/UEMatExportMetadata/`: compiled Win64 plugin package usable without adding a project plugin.
- `host/NodeDiscoveryHost.uproject`: bundled minimal UE host project for node discovery (no game project needed; disables the fragile default engine plugins).
- `docs/AGENT_WORKFLOW.md`: agent-facing workflow for updating `agent-pack\nodes-ue5.7.export.json`.
- `docs/NODE_DISCOVERY.md`: find which engine expressions the DB is missing (node discovery).
- `docs/WORKMF.md`: WorkMF mode — index the project's own Material Functions into `agent-pack\workmf-index.json` (local, gitignored).
- `docs/ENGINE_MF.md`: index the official `/Engine/Functions` Material Functions (committed).
- `docs/VERIFICATION.md`: required audit and test commands.
- `skill/node-t3d-metadata/SKILL.md`: portable skill instructions for Codex, Claude, or other agents.

## Normal Flow

Run from the workflow repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine>
```

The entrypoint rebuilds the compiled plugin only when it is missing, forced, or older than `plugin-src/`, then regenerates `agent-pack\nodes-ue5.7.export.json`, audits the metadata, and runs targeted viewer tests.

Useful options:

```powershell
# Force plugin packaging even if the compiled plugin looks current.
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine> `
  -ForcePackage

# Also refresh the MakeMaterialAttributes clipboard calibration fixture.
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine> `
  -CaptureFixtures

# Crawl THIS project's own Material Functions into agent-pack\workmf-index.json
# (local + gitignored). Only needed if your graphs reference your own /Game MFs by
# asset path; runs the crawl only, not the node-metadata regen. See docs/WORKMF.md.
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine> `
  -WorkMF

# Capture the core MaterialGraphNode clipboard calibration fixture.
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Capture-CoreClipboardSample.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine> `
  -TextureAsset /Game/Textures/T_Mask.T_Mask

# Capture TextureSample / TextureSampleParameter2D texture reference syntax.
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Capture-TextureSampleSources.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine> `
  -TextureAsset /Game/Textures/T_Mask.T_Mask
```

Logs are written under this repo's `Logs\UE`; the host UE project is not modified by the default external-plugin workflow.

## Other modes

The same commandlet/plugin powers two more modes (each with a one-command runner):

- **Node discovery** — enumerate every `UMaterialExpression` the engine compiles in and diff
  it against the authoring DB, so you get a report of exactly which nodes are missing. Run
  `plugin-src\Scripts\Run-NodeDiscovery.ps1`; details in `docs\NODE_DISCOVERY.md`.
- **WorkMF** — index a project's own Material Functions (by UE asset path) so the viewer,
  exporter, and authoring agent can use them. Run `plugin-src\Scripts\Run-WorkMfIndex.ps1`;
  details in `docs\WORKMF.md`. The output stays local and gitignored.
- **Engine MF** — the same crawl pointed at the official `/Engine/Functions` library, so
  materials that call built-in MFs (CustomRotator, BumpOffset_Advanced, …) round-trip with
  correct pins. Run `plugin-src\Scripts\Run-EngineMfIndex.ps1`; details in `docs\ENGINE_MF.md`.
  Its output **is** committed (stable shipped data shared by all users).

## Agent Skill

The portable skill lives at `skill/node-t3d-metadata/SKILL.md`. Any agent can use it directly by reading that file. To install it into an agent-specific skill registry, copy the whole `skill/node-t3d-metadata` folder to that agent's skills directory.

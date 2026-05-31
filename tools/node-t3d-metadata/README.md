# Node T3D Metadata Tooling

This folder is the self-contained maintenance bundle for UE material node T3D/export metadata. It is project-agnostic: pass any compatible UE `.uproject` and `UnrealEngine` root as the commandlet host.

## Contents

- `Invoke-NodeT3DMetadataMaintenance.ps1`: one-command metadata maintenance entrypoint.
- `audit-export-meta.js`: reusable metadata audit command.
- `plugin-src/`: UE editor plugin source for the `UEMatExportMetadata` commandlet.
- `compiled/UEMatExportMetadata/`: compiled Win64 plugin package usable without adding a project plugin.
- `docs/AGENT_WORKFLOW.md`: agent-facing workflow for updating `agent-pack\nodes-ue5.7.export.json`.
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

# Capture TextureSample / TextureSampleParameter2D texture reference syntax.
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Capture-TextureSampleSources.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine> `
  -TextureAsset /Game/Textures/T_Mask.T_Mask
```

Logs are written under this repo's `Logs\UE`; the host UE project is not modified by the default external-plugin workflow.

## Agent Skill

The portable skill lives at `skill/node-t3d-metadata/SKILL.md`. Any agent can use it directly by reading that file. To install it into an agent-specific skill registry, copy the whole `skill/node-t3d-metadata` folder to that agent's skills directory.

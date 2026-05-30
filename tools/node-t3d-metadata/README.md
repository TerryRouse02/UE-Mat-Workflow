# Node T3D Metadata Tooling

This folder is the self-contained maintenance bundle for UE material node T3D/export metadata.

## Contents

- `plugin-src/`: UE editor plugin source for the `UEMatExportMetadata` commandlet.
- `compiled/UEMatExportMetadata/`: compiled Win64 plugin package usable without adding a project plugin to G1.
- `docs/AGENT_WORKFLOW.md`: agent-facing workflow for updating `agent-pack\nodes-ue5.7.export.json`.
- `docs/VERIFICATION.md`: required audit and test commands.
- `skill/node-t3d-metadata/SKILL.md`: portable skill instructions for Codex, Claude, or other agents.

## Normal Flow

Run from `D:\Agent_Dev\UE-Mat-Workflow`:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Run-UEMatExportMetadata.ps1 -G1Root D:\SDGF_G1_Project
```

Rebuild the compiled plugin only after changing `plugin-src/` C++ or when `compiled/` is missing:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Package-Plugin.ps1 -G1Root D:\SDGF_G1_Project
```

The generated metadata is written to `agent-pack\nodes-ue5.7.export.json`. Logs are written under `Logs\UE`.

To refresh the MakeMaterialAttributes clipboard calibration fixture:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Capture-MakeMaterialAttributesSample.ps1 -G1Root D:\SDGF_G1_Project
```

The fixture is written to `viewer\tests\fixtures\ue-make-material-attributes.t3d`.

## Agent Skill

The portable skill lives at `skill/node-t3d-metadata/SKILL.md`. Any agent can use it directly by reading that file. To install it into an agent-specific skill registry, copy the whole `skill/node-t3d-metadata` folder to that agent's skills directory.

---
name: node-t3d-metadata
description: Use when updating UE material node T3D/export metadata, nodeT3D metadata, nodes-ue5.7.export.json, Unreal material export maps, or UE-Mat-Workflow node database export support.
---

# Node T3D Metadata

This is a portable agent workflow. It does not require Codex-specific features. Any agent that can read Markdown and run PowerShell can use it.

## Core Rules

- Update `agent-pack\nodes-ue5.7.export.json`; do not edit `agent-pack\nodes-ue5.7.json` unless the user explicitly asks.
- Do not edit the host `.uproject`; it is only used to run the UE commandlet.
- Use the compiled external plugin in `tools\node-t3d-metadata\compiled\UEMatExportMetadata` for normal runs.
- Do not guess UE class paths or pin mappings; use the commandlet and audit the output.

## Workflow

From the repo root, run the generic maintenance entrypoint:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine>
```

The entrypoint rebuilds the plugin when needed, generates metadata, audits the output, and runs targeted viewer tests.

Use `-CaptureFixtures` only when calibrating UE clipboard/T3D emitter behavior.

The same plugin has two more modes (separate runners):

- **Node discovery** — `plugin-src\Scripts\Run-NodeDiscovery.ps1` enumerates every engine
  `UMaterialExpression` and diffs it against the DB, reporting what's missing. Nodes added
  from a discovery report stay `verified: false` (pin names reflected, types placeholder)
  until hand-checked; the audit allows those to lag export coverage. See `docs\NODE_DISCOVERY.md`.
- **WorkMF** — `plugin-src\Scripts\Run-WorkMfIndex.ps1` indexes a project's own Material
  Functions into the local, gitignored `agent-pack\workmf-index.json`. See `docs\WORKMF.md`.

Verify:

```powershell
node tools\node-t3d-metadata\validate-tooling.js
node tools\node-t3d-metadata\plugin-src\validate-plugin.js
node tools\node-t3d-metadata\audit-export-meta.js
```

Then run any additional checks from `tools\node-t3d-metadata\docs\VERIFICATION.md`.

## Success Criteria

- Commandlet log says `Warnings: 0` and `Success - 0 error(s), 0 warning(s)`.
- Audit says `missing=0`, `orphans=0`, `unresolved=0`, and `badShape=0`.

## Troubleshooting

- If the run script reports a project plugin shadowing the compiled plugin, verify and remove only `<ProjectDir>\Plugins\UEMatExportMetadata`.
- If building in project-plugin mode, close `UnrealEditor` and `LiveCodingConsole` first.
- If Vitest cannot run because `viewer\node_modules` is missing, report dependency installation as the blocker.

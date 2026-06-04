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

> These orchestration scripts require **Windows + PowerShell** (they invoke
> `UnrealEditor-Cmd.exe` / `RunUAT.bat` and use Windows path separators). They do not run on
> macOS or Linux.

## Normal Flow

Run from the workflow repo root:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine>
```

The entrypoint rebuilds the compiled plugin only when it is missing, forced, or older than `plugin-src/`, then regenerates `agent-pack\nodes-ue5.7.export.json`, audits the metadata, and runs targeted viewer tests.

### Per-machine config (skip retyping paths)

`-ProjectPath` and `-EngineRoot` are long, machine-specific Windows paths. Instead of passing
them every run, record them once in a local config file:

1. Copy `tools\node-t3d-metadata\local.config.example.json` to
   `tools\node-t3d-metadata\local.config.json`.
2. Fill in `ProjectPath` and `EngineRoot` (and optionally `WorkMfContentRoots`).

`local.config.json` is gitignored (per-machine; never committed). With it in place you can run
the entrypoint with no path args:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1
```

An explicit `-ProjectPath` / `-EngineRoot` always wins over the config file. The same fallback
applies to `Run-NodeDiscovery.ps1` and `Run-EngineMfIndex.ps1` (for those, only `EngineRoot` is
required; `ProjectPath` defaults to the bundled minimal host).

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

## Trigger a crawl from the web viewer (no terminal)

All three crawls above can also be run from the **viewer's Config tab** (the third sidebar tab,
next to Files and Nodes) — no terminal, no hand-edited JSON. It is **local-first**: the viewer
server, `UnrealEditor-Cmd.exe`, and the browser all run on the **same Windows machine** (the server
binds `127.0.0.1`, and only a same-origin page on that machine can configure or start a crawl).

### 1. Start the viewer

On the Windows machine with UE installed, from the repo root:

```bash
pnpm build && pnpm start     # serves http://localhost:5790 (auto-tries 5790-5799)
# iterating on the UI instead?  pnpm dev
```

Open `http://localhost:5790` in a browser **on that machine** and click the **Config** tab.

### 2. Set the project paths (in the Config tab)

Under **專案路徑**, fill in **`.uproject` 路徑** (`ProjectPath`) and **UE 引擎根目錄**
(`EngineRoot`), then click **儲存設定**. That writes `tools/node-t3d-metadata/local.config.json`
for you (gitignored, per-machine) — the same file the PowerShell scripts read, so you never edit
JSON by hand. (Pre-filling it manually or with the [Normal Flow](#normal-flow) still works.)

The compiled plugin already ships under `compiled/` (committed), so that check passes out of the
box — only rebuild it if you edited `plugin-src/`. Also make sure your UE project carries no
`Plugins\UEMatExportMetadata\` copy, which would shadow the packaged one.

### 3. Read the environment checklist

The **環境檢查** section turns every probe check into a green ✓ / red ✗ row, so you see exactly
what's still missing instead of guessing. All must be green before the crawl buttons enable:

| Check | Means |
|---|---|
| platform | running on Windows |
| config | `local.config.json` has `ProjectPath` + `EngineRoot` |
| engine | `UnrealEditor-Cmd.exe` found under `EngineRoot` |
| project | `ProjectPath` points to an existing `.uproject` **file** (not the folder) |
| plugin | the compiled plugin DLL is present (shipped in `compiled/`) |
| noShadow | no project-local `Plugins\UEMatExportMetadata` copy shadows the packaged plugin |

### 4. Crawl

Once the checklist is green, the **爬取 UE 元資料** section's buttons run the same scripts this
README documents (reading `ProjectPath` / `EngineRoot` from `local.config.json`); progress streams
in-panel and the viewer refreshes live when each finishes. Only one runs at a time.

| Button | Kind | Writes | Script |
|---|---|---|---|
| 重爬節點匯出 | export | `agent-pack\nodes-ue5.7.export.json` | `Invoke-NodeT3DMetadataMaintenance.ps1 -SkipViewerTests` |
| 重爬引擎 MF | enginemf | `agent-pack\enginemf-index-ue5.7.json` | `plugin-src\Scripts\Run-EngineMfIndex.ps1` |
| 重爬專案 MF | workmf | `agent-pack\workmf-index.json` (local, gitignored) | `plugin-src\Scripts\Run-WorkMfIndex.ps1 -ContentRoots <roots>` |

The **專案 MF (workmf)** button has its own **Content Root** field (default `/Game`,
comma-separate several) for which project folders to crawl.

The **專案 MF (workmf)** item has a **Content Root** field (default `/Game`; comma-separate
several) for which project folders to crawl, and shows the resolved project path. The first
editor launch takes a few minutes — progress streams into the popover and a toast reports
success or failure. Only one crawl runs at a time (a second is refused until the first ends).

## Agent Skill

The portable skill lives at `skill/node-t3d-metadata/SKILL.md`. Any agent can use it directly by reading that file. To install it into an agent-specific skill registry, copy the whole `skill/node-t3d-metadata` folder to that agent's skills directory.

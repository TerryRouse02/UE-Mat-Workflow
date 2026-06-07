# macOS Crawl Port — Design

**Status:** Draft for review
**Date:** 2026-06-06

## Goal

Make the Config-tab crawls (`workmf` / `projectmat` / `enginemf` / `export`) runnable on **macOS** so the user can crawl their G1_Project materials/MFs locally on this Mac — without destabilizing the existing, validated Windows path.

## Verified context

- **Mac:** Apple Silicon (`arm64`), Xcode 26.5 installed.
- **UE:** source build at `/Users/rouseterry/G1Project/SDGF_G1_Project/UE_5.7/`.
  `Engine/Binaries/Mac/UnrealEditor-Cmd` (headless), `Engine/Build/BatchFiles/RunUAT.sh`, and `Build.sh` all present. G1_Project already has Mac editor `.dylib`s → engine+project run on this Mac.
- **Project:** `/Users/rouseterry/G1Project/SDGF_G1_Project/G1_Project/G1_Project.uproject`.
- **Commandlet C++ is platform-clean:** no `windows.h` / `_WIN32` / `PLATFORM_WINDOWS`; deps all cross-platform (Core, CoreUObject, Engine, AssetRegistry, Json, JsonUtilities, Landscape, UnrealEd); `.uplugin` has no platform whitelist.
- **Missing on Mac:** no `pwsh`, no `brew`, no global `dotnet`.
- **`.gitignore` already covers:** `agent-pack/workmf-index.json`, `workmf-index.export.json`, `projectmat-staging/`, `local.config.json`.

## Decisions (user-confirmed)

- **D1 — runner: pwsh-unified.** Install PowerShell Core on the Mac; make the crawl `.ps1` runners cross-platform; `crawl-runner.ts` `defaultCommandFor` branches to `pwsh` on `darwin`. One script set = single source of truth (invariant #5).
- **D2 — Mac plugin: local, gitignored.** Build the Mac `.dylib` into `compiled/UEMatExportMetadata/Binaries/Mac/`; gitignore that subdir. Committed Win64 `.dll` + `.uplugin` untouched. Windows/Codex stays the canonical UE end.

## Non-obvious technique: dual-runtime `.ps1` platform detect

The crawl `.ps1` must run on **both** Windows PowerShell 5.1 (Windows) and pwsh 7 (Mac). `$IsMacOS`/`$IsWindows` are auto-vars in pwsh 7 but **undefined** in PS 5.1. Since PS 5.1 only ever runs on Windows, detect with:

```powershell
$isMac = ($IsMacOS -eq $true)   # PS5.1: $IsMacOS undefined -> $false (Windows); pwsh7-Mac: $true
if ($isMac) {
    $EditorCmd = Join-Path $EngineRoot "Engine/Binaries/Mac/UnrealEditor-Cmd"
} else {
    $EditorCmd = Join-Path $EngineRoot "Engine\Binaries\Win64\UnrealEditor-Cmd.exe"
}
```

Files stay **pure ASCII** (invariant #4). `Join-Path` normalizes separators per platform.

## Work items

### W1 — Install PowerShell Core (user, one-time, prerequisite)

Download Microsoft's official arm64 `.pkg` from the PowerShell GitHub releases, then:
`sudo installer -pkg powershell-7.x.x-osx-arm64.pkg -target /` → verify `pwsh -v`.
(Alternative once brew exists: `brew install --cask powershell`.) Not code — a setup step the user runs via `!`.

### W2 — Build the Mac plugin

Make `Package-Plugin.ps1` cross-platform:
- `$RunUAT`: `RunUAT.sh` on Mac vs `RunUAT.bat` on Windows.
- `-TargetPlatforms`: `Mac` vs `Win64`.
- Keep the `EngineVersion`-strip + `Intermediate/` cleanup.

Run it against the source engine. `RunUAT BuildPlugin -Package=<dir>` writes a *full clean* plugin copy, so it must **not** target the committed `compiled/` dir directly (that would clobber the Win64 layout). Build to a **temp `-Package` dir**, then copy only `Binaries/Mac/UnrealEditor-UEMatExportMetadata.dylib` (+ its `UnrealEditor.modules`) into the existing `compiled/UEMatExportMetadata/Binaries/Mac/`, so the committed `-plugin=…/UEMatExportMetadata.uplugin` loads it on Mac alongside the untouched Win64 binary.

Add to `.gitignore`: `tools/node-t3d-metadata/compiled/**/Binaries/Mac/`.

### W3 — Cross-platform the crawl run-scripts

Apply the W1 platform-detect to `$EditorCmd`, `$PackagedDll` (→ `.dylib` on Mac), and `$RunUAT` in the **crawl entrypoints only**:
- `Run-WorkMfIndex.ps1` (workmf) — line 75
- `Run-ProjectMaterials.ps1` (projectmat) — lines 83, 92
- `Run-EngineMfIndex.ps1` (enginemf) — lines 97, 106
- `Invoke-NodeT3DMetadataMaintenance.ps1` (export) — lines 120, 121, 125

**Out of scope** (Windows-hardcoded but not wired to the crawl button): `Run-NodeDiscovery.ps1`, `Run-UEMatExportMetadata.ps1`, `Capture-*.ps1` (dev fixture tools). Note in README; do not port now (YAGNI).

### W4 — `crawl-runner.ts` platform branch

In `defaultCommandFor`, when `process.platform === 'darwin'`:
`{ command: 'pwsh', args: ['-NoProfile', '-File', <script>, ...extra] }`
(drop `-ExecutionPolicy Bypass` — Windows-only). Otherwise keep the current `powershell` invocation. The per-kind `switch` is unchanged. Crawl commands remain in this one place (invariant #5).

### W5 — `crawl-env.ts` probe + local.config

`probeEnv` currently hard-gates non-Windows and hardcodes Win64. Branch on `platform`:
- line 65 `platformOk`: `=== 'win32' || === 'darwin'`.
- line 45 `editorCmd`: Mac → `Engine/Binaries/Mac/UnrealEditor-Cmd`; Win → `…/Win64/UnrealEditor-Cmd.exe`.
- line 56 `dll`: Mac → `compiled/…/Binaries/Mac/UnrealEditor-UEMatExportMetadata.dylib`; Win → Win64 `.dll`.
- detail strings (68, 70, 72): platform-aware (no ".exe" / "build it once on Windows" copy on Mac).

`ProbeOpts.platform` is already injectable → the Mac branch is unit-testable.

User writes `tools/node-t3d-metadata/local.config.json` (gitignored) with Mac paths:
```json
{
  "ProjectPath": "/Users/rouseterry/G1Project/SDGF_G1_Project/G1_Project/G1_Project.uproject",
  "EngineRoot": "/Users/rouseterry/G1Project/SDGF_G1_Project/UE_5.7",
  "WorkMfContentRoots": "/Game"
}
```

### W6 — End-to-end validation on G1_Project

Run `workmf` then `projectmat` against G1_Project via the Config tab. Assert: log streams continuously; results land in Files (工作) / Nodes; `workmf-index.json` stays gitignored; **no public artifact modified** (`git status` clean except gitignored outputs; `node tools/node-t3d-metadata/audit-export-meta.js` exits 0).

## Invariants honored

- **#1/#2/#3 purity:** only `workmf-index.json` + `projectmat-staging/` (both gitignored) carry G1_Project data; nothing project-specific enters committed files (code, comments, or the Mac `.dylib`, which is gitignored).
- **#4:** `.ps1` stay pure ASCII.
- **#5:** crawl commands only in `defaultCommandFor`; one `.ps1` set serves both platforms.

## Testing

- **Unit:** `crawl-runner.test.ts` — a `darwin` case (inject `commandFor`/platform) asserting `pwsh` + no `-ExecutionPolicy`. `crawl-env` — a `darwin` probe case (inject `platform`) asserting `platformOk` and the Mac editor/dylib paths.
- **Manual:** W6 on the real Mac + UE.

## Out of scope

Committing Mac binaries; migrating Windows off `.ps1`; porting the dev fixture-capture scripts; CI on Mac.

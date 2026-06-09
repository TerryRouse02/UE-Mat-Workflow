# Engine MF — index the official `/Engine/Functions` Material Functions

The node DB covers built-in **expressions**. Built-in **Material Functions** (the official
`/Engine/Functions/**` library — `CustomRotator`, `BumpOffset_Advanced`, …) are shipped
`.uasset` files, not C++ expression classes, so neither the node DB nor node-discovery sees
them. A real material that calls one imports/exports with that MF's pins unresolved: every
`FunctionInputs(n)` collapses onto index 0 and the wires break when you paste back into UE.

The **engine-MF index** closes that gap. It is the exact same crawl as
[WorkMF](WORKMF.md), just pointed at the engine's content roots instead of `/Game` — but its
output is **committed** to the repo, because the official library is stable shipped data shared
by every user (unlike the per-project, gitignored work index).

## What it produces

`agent-pack/enginemf-index-ue5.7.json` — **committed** (not gitignored). Same shape as the work
index (`kind: "workmf-index"`, consumed by `viewer/server/workmf-index.ts` and resolved for
`/Engine/...` paths by `viewer/server/mf-resolver.ts`):

```jsonc
{
  "schemaVersion": "1.0",
  "kind": "workmf-index",
  "ueVersion": "5.7",
  "provenance": { "contentRoots": "/Engine/Functions", "engineVersion": "...", ... },
  "functions": {
    "/Engine/Functions/Engine_MaterialFunctions02/Texturing/CustomRotator.CustomRotator": {
      "assetPath": "/Engine/Functions/Engine_MaterialFunctions02/Texturing/CustomRotator.CustomRotator",
      "displayName": "CustomRotator",
      "inputs":  [ { "name": "UVs", "type": "Float2", "index": 0 }, ... ],
      "outputs": [ { "name": "Result", "type": "Float3", "index": 0 } ],
      "missing": false
    }
  }
}
```

Pin **order matches UE** (`SortPriority`), which the exporter's `FunctionInputs(n)` index
depends on. Input `type` is exact; output `type` is a best-effort `Float3` (cosmetic).

The repo ships a **placeholder** (`functions: {}`) until someone runs the crawl on a UE 5.7
machine and commits the result. Until then, official-MF calls warn (not crash).

## Run it (on the UE 5.7 machine)

> **No terminal?** The viewer's **Config tab** runs this exact crawl (the `enginemf` kind) and
> refreshes live — see the tool
> [`README.md`](../README.md#trigger-a-crawl-from-the-web-viewer-no-terminal). The CLI below is the
> equivalent, and the only option for headless / agent runs.

`-ProjectPath` is **optional** — the crawl reads `/Engine` assets, which are mounted regardless
of project, so it defaults to the bundled minimal host (`host/NodeDiscoveryHost.uproject`):

```powershell
# Windows (Windows PowerShell 5.1):
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Run-EngineMfIndex.ps1 `
  -EngineRoot <Path\To\UnrealEngine>
```

```bash
# macOS (PowerShell Core 7 — install the official .pkg or `brew install --cask powershell`):
pwsh -File ./tools/node-t3d-metadata/plugin-src/Scripts/Run-EngineMfIndex.ps1 \
  -EngineRoot /path/to/UnrealEngine
```

The same `.ps1` runner serves both OSes — it platform-detects the editor binary
(`Engine\Binaries\Win64\UnrealEditor-Cmd.exe` on Windows, `Engine/Binaries/Mac/UnrealEditor-Cmd`
on macOS). The committed `compiled/` plugin is a prebuilt Win64 binary; on macOS build the
plugin locally first with `Package-Plugin.ps1` (needs Xcode + a UE editor with
`Engine/Build/BatchFiles/RunUAT.sh`), which emits a gitignored `Binaries/Mac/*.dylib`.

Defaults: crawls `/Engine/Functions`, writes `agent-pack\enginemf-index-ue5.7.json`. Widen with
`-ContentRoots "/Engine/Functions,/SomePlugin"` if you depend on plugin-provided MFs; override
the output with `-Out`. The script auto-packages a stale plugin and treats a trailing
non-zero exit as success when the index was actually written.

## Expected result

Commandlet log includes:

```text
Wrote work-MF index: <repo>/agent-pack/enginemf-index-ue5.7.json (<N> function(s), 0 load failure(s))
```

Then confirm the consumer accepts it (runs locally, no UE):

```bash
node -e "const{loadWorkMfIndex}=require('./viewer/dist/server/workmf-index.js');loadWorkMfIndex('agent-pack/enginemf-index-ue5.7.json').then(r=>console.log(r.warnings.length?r.warnings:'ok',Object.keys(r.index?.functions||{}).length+' functions'))"
```

## Guardrails

- This index **is** committed (review the diff before committing — a few hundred official MFs).
- Re-run after an engine upgrade (pin sets can change between UE versions).
- The crawl is read-only reflection over the AssetRegistry; it never modifies engine content.
- If a referenced official MF is missing from the index, the authoring agent must STOP and ask
  for a re-crawl rather than invent pin names (same rule as WorkMF).

## Hand-off prompt (paste to the UE-side agent)

> In the `ue-mat-workflow` repo on this UE 5.7 machine, build the committed **official engine
> Material Function index** so materials that call `/Engine/Functions/**` MFs round-trip
> losslessly:
>
> ```powershell
> # Windows (Windows PowerShell 5.1):
> powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Run-EngineMfIndex.ps1 -EngineRoot <Path\To\UnrealEngine>
> # macOS (PowerShell Core 7):
> pwsh -File ./tools/node-t3d-metadata/plugin-src/Scripts/Run-EngineMfIndex.ps1 -EngineRoot /path/to/UnrealEngine
> ```
>
> `-ProjectPath` is optional (defaults to the bundled minimal host). Confirm the log shows
> `Wrote work-MF index: ... (N function(s), 0 load failure(s))` with N in the hundreds, then
> **commit** `agent-pack/enginemf-index-ue5.7.json` (this one IS committed, unlike the work
> index). If the build fails, the version-sensitive spots are flagged "API NOTE" in
> `plugin-src/Source/UEMatExportMetadata/Private/UEMatExportMetadataCommandlet.cpp`.

# Commandlet root-cause fixes (UE C++ — hand-off for Codex on the UE host)

Two known issues live in the UE editor commandlet C++. Both currently have a
host-side workaround (or a documented limitation), but the proper fix is in the
commandlet and requires compiling the plugin against the user's UE 5.7 build —
which only happens on the UE host (Windows `powershell` 5.1, or this repo's macOS
`pwsh`). This doc is a self-contained hand-off: it has the exact files, the exact
edits, and the exact verification, so the fix can be applied in one editor session.

**The single C++ file for both fixes:**
`tools/node-t3d-metadata/plugin-src/Source/UEMatExportMetadata/Private/UEMatExportMetadataCommandlet.cpp`

> Line numbers below are from the commit that added this doc; they drift if the
> file is edited above the anchor. Always locate by the quoted anchor code, not the
> line number.

After editing, rebuild + re-run the crawl with (paths come from `local.config.json`):

```
# Windows
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 -ForcePackage
# macOS
pwsh -File ./tools/node-t3d-metadata/Invoke-NodeT3DMetadataMaintenance.ps1 -ForcePackage
```

`-ForcePackage` forces a plugin rebuild (the source changed). Keep every `.ps1`
pure ASCII if you touch one — Windows PowerShell 5.1 mis-reads non-ASCII bytes.

---

## Fix 1 — Complete the array-element input-property override table

### Symptom

A fresh `node-metadata` (export) crawl emits the **raw DB pin name** instead of UE's
`Name(N)` T3D array-element syntax for 11 input pins:

| Node | Pins | Emits (wrong) | Must emit |
|---|---|---|---|
| `MakeMaterialAttributes` | `CustomizedUVs_0`..`CustomizedUVs_7` | `CustomizedUVs_0`.. | `CustomizedUVs(0)`..`CustomizedUVs(7)` |
| `QualitySwitch` | `Medium`, `Epic` | `Medium`, `Epic` | `Inputs(2)`, `Inputs(3)` |
| `FeatureLevelSwitch` | `SM6` | `SM6` | `Inputs(4)` |

A material that wires these pins then pastes into UE with the wrong/empty input
linkage. This is currently papered over by the host-side `heal-export-meta.js` step
(runs after generation in `Invoke-NodeT3DMetadataMaintenance.ps1`). **Completing
this fix makes that heal a pure no-op safety net** — the crawl will emit correct
values natively.

### Root cause

`ResolveInputProperty` (anchor: `static FString ResolveInputProperty(const FString& NodeType, const FString& PinName, UClass* Class, UMaterialExpression* Expression)`) resolves an input pin's T3D property in three steps:

1. an explicit per-node override table (`BuildInputOverrides()`),
2. `ClassHasProperty(Class, PinName)` — a direct property-name match,
3. `BuildDisplayInputMap(Expression)` — which calls `PropertyNameForInput` and *does*
   handle `ArrayDim > 1` by appending `(N)`.

Step 3 is supposed to produce `Inputs(2)`/`CustomizedUVs(0)` automatically, but it is
keyed by `Expression->GetInputName(InputIndex)`, which for these specific switch/array
inputs does **not** equal the DB pin name (or `GetInputPinProperty` returns empty),
so the lookup misses and `ResolveInputProperty` falls through to `return PinName`
(the raw name). That is exactly why an explicit override table already exists for the
pins that *do* work — and it is simply **incomplete**.

### The edit

In `BuildInputOverrides()` (anchor: `static TMap<FString, TMap<FString, FString>> BuildInputOverrides()`, ~line 90), the current FeatureLevelSwitch / QualitySwitch entries are:

```cpp
    Overrides.Add(TEXT("FeatureLevelSwitch"), {{TEXT("Default"), TEXT("Default")}, {TEXT("ES2"), TEXT("Inputs(0)")}, {TEXT("ES3.1"), TEXT("Inputs(1)")}, {TEXT("SM4"), TEXT("Inputs(2)")}, {TEXT("SM5"), TEXT("Inputs(3)")}});
    Overrides.Add(TEXT("QualitySwitch"), {{TEXT("Default"), TEXT("Default")}, {TEXT("Low"), TEXT("Inputs(0)")}, {TEXT("High"), TEXT("Inputs(1)")}});
```

Replace those two lines with the completed table (adds `SM6`, `Medium`, `Epic`, and a
new `MakeMaterialAttributes` entry for all eight CustomizedUVs slots):

```cpp
    Overrides.Add(TEXT("FeatureLevelSwitch"), {{TEXT("Default"), TEXT("Default")}, {TEXT("ES2"), TEXT("Inputs(0)")}, {TEXT("ES3.1"), TEXT("Inputs(1)")}, {TEXT("SM4"), TEXT("Inputs(2)")}, {TEXT("SM5"), TEXT("Inputs(3)")}, {TEXT("SM6"), TEXT("Inputs(4)")}});
    Overrides.Add(TEXT("QualitySwitch"), {{TEXT("Default"), TEXT("Default")}, {TEXT("Low"), TEXT("Inputs(0)")}, {TEXT("High"), TEXT("Inputs(1)")}, {TEXT("Medium"), TEXT("Inputs(2)")}, {TEXT("Epic"), TEXT("Inputs(3)")}});
    Overrides.Add(TEXT("MakeMaterialAttributes"), {
        {TEXT("CustomizedUVs_0"), TEXT("CustomizedUVs(0)")},
        {TEXT("CustomizedUVs_1"), TEXT("CustomizedUVs(1)")},
        {TEXT("CustomizedUVs_2"), TEXT("CustomizedUVs(2)")},
        {TEXT("CustomizedUVs_3"), TEXT("CustomizedUVs(3)")},
        {TEXT("CustomizedUVs_4"), TEXT("CustomizedUVs(4)")},
        {TEXT("CustomizedUVs_5"), TEXT("CustomizedUVs(5)")},
        {TEXT("CustomizedUVs_6"), TEXT("CustomizedUVs(6)")},
        {TEXT("CustomizedUVs_7"), TEXT("CustomizedUVs(7)")},
    });
```

The index inside each `(N)` is the UE array slot, matching the canonical map already
in `tools/node-t3d-metadata/array-pin-properties.js` (`EMaterialQualityLevel`:
Low=0, High=1, Medium=2, Epic=3; the FeatureLevelSwitch `Inputs[]` slots ES2=0..SM6=4;
`CustomizedUVs[8]` index). **Do not** add `BlendAngleCorrectedNormals` — its
`FunctionInputs(0/1)` come from a different code path (`BuildFunctionInputsObject`,
`FString::Printf(TEXT("FunctionInputs(%d)"), Index)`) and are already correct.

### Verify Fix 1

Run **generation only** (no heal), then ask the heal whether anything still drifts:

```
# Windows: generate only
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Run-UEMatExportMetadata.ps1 -ProjectPath <proj> -EngineRoot <engine>
# then (any OS):
node tools\node-t3d-metadata\heal-export-meta.js --check
```

Expected: `Array-pin properties are canonical.` (exit 0) — proving the commandlet now
emits correct `(N)` natively, with no host-side healing needed. `node
tools/node-t3d-metadata/audit-export-meta.js` should also show `arrayPins=0`. After
this lands, `heal-export-meta.js` stays as a safety net (its tests still pass; it just
never has to change anything).

---

## Fix 2 — Scan editor-only `/Engine` content so EngineMF can index it

### Symptom

The Engine-MF crawl (`Run-EngineMfIndex.ps1`) cannot index Material Functions that
live in **editor-only** `/Engine` content, e.g. `CheckerPattern` at
`/Engine/ArtTools/RenderToTexture/MaterialFunctions/`. Pointing the crawl at
`/Engine/ArtTools` returns **0** assets even though the `.uasset` is on disk, because
those engine paths are deny-listed from the Asset Registry in a commandlet context.
Consequence: a material that calls such an MF (e.g. `M_CubeMaterial` -> CheckerPattern,
its Tiling pin) can't resolve that MF's pin signature.

### Root cause

`WriteWorkMfIndex` (anchor: `static bool WriteWorkMfIndex(const FString& OutPath, const FString& ContentRootsCsv, const FString& UeVersion, FString& OutError)`, ~line 2627) — which the Engine-MF crawl reuses via `-WorkMfOut=<enginemf path> -ContentRoots=/Engine/Functions` — scans like this:

```cpp
    IAssetRegistry& AssetRegistry = AssetRegistryModule.Get();
    AssetRegistry.SearchAllAssets(true); // block until the project is fully scanned

    const TArray<FString> ContentRoots = ParseContentRoots(ContentRootsCsv);
```

`SearchAllAssets(true)` only materializes assets the AR already tracks; editor-only
`/Engine` directories are excluded by the AR's deny-list scan filters and are never
force-scanned.

### The edit

Immediately **after** `const TArray<FString> ContentRoots = ParseContentRoots(ContentRootsCsv);`
and **before** the `FARFilter Filter;` block, add a forced scan of the requested roots
that ignores the deny-list filters:

```cpp
    const TArray<FString> ContentRoots = ParseContentRoots(ContentRootsCsv);

    // Force-scan the requested roots so editor-only /Engine content (e.g.
    // /Engine/ArtTools/.../MaterialFunctions) is registered. SearchAllAssets alone
    // skips these because the Asset Registry deny-lists editor-only engine paths.
    AssetRegistry.ScanPathsSynchronous(ContentRoots, /*bForceRescan=*/true, /*bIgnoreDenyListScanFilters=*/true);
```

Notes for the implementer:
- Confirm the `ScanPathsSynchronous` signature against this UE 5.7 build. In recent UE
  it is `ScanPathsSynchronous(const TArray<FString>& InPaths, bool bForceRescan = false, bool bIgnoreDenyListScanFilters = false)`. The
  `bIgnoreDenyListScanFilters=true` argument is the one that surfaces editor-only
  `/Engine` content; if your build lacks that 3rd parameter, the deny-list cannot be
  bypassed via this call and you may need an alternate scan API (e.g. a path-specific
  rescan) — verify on-machine.
- This is shared code, so the same force-scan also benefits WorkMF (`/Game`) crawls
  (harmless: `/Game` isn't deny-listed). `WriteProjectMaterials` (anchor:
  `static bool WriteProjectMaterials(...)`, ~line 2914) has the identical
  `SearchAllAssets` + `GetAssets` shape; apply the same two lines there only if you
  ever need editor-only content for the project-materials crawl (normally not).

### Verify Fix 2

Run the Engine-MF crawl with a root that contains an editor-only MF, then confirm it
appears in the committed index:

```
# Windows
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Run-EngineMfIndex.ps1 -ContentRoots "/Engine/Functions,/Engine/ArtTools"
```

Expected: the function count rises above the previous 481, and
`agent-pack/enginemf-index-ue5.7.json` now contains a `CheckerPattern` entry (search
the file). `CheckerPattern` is stock Epic engine content, so committing it does not
violate public-artifact purity (invariant 1). Re-run the viewer's resolve on
`M_CubeMaterial` to confirm the Tiling pin now resolves.

---

## Public-artifact purity (both fixes)

Everything these fixes touch is stock Epic UE 5.7 data (engine expression properties,
engine Material Functions). Do **not** add any project-specific node, attribute GUID,
or `/Game` asset name to a committed file. The work-MF index (`workmf-index.json`)
remains the only home for project data and stays gitignored.

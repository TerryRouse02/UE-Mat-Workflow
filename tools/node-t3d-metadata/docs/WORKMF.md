# WorkMF — index your project's own Material Functions (Phase 2)

The node DB (`agent-pack/nodes-ue5.7.json`) covers UE **built-in** expressions only. Your
own project's Material Functions live as `.uasset` files this repo cannot read. The **WorkMF
crawl** runs in the UE editor, enumerates those functions, and writes their call signatures
(pin names + order) so three consumers can use them by UE asset path:

1. the viewer — renders `MaterialFunctionCall` pins,
2. the T3D exporter — positional `FunctionInputs(n)` (already consumes derived pins),
3. the authoring agent — reads the index to learn exact pin names (see SPEC.md → *Work-project Material Functions*).

## What it produces

`agent-pack/workmf-index.json` — **local and gitignored** (see `.gitignore`). It is never
committed and never bundled into the web build. Shape (consumed by
`viewer/server/workmf-index.ts`):

```jsonc
{
  "schemaVersion": "1.0",
  "kind": "workmf-index",
  "ueVersion": "5.7",
  "provenance": { "ueVersion": "5.7", "engineVersion": "...", "generatedBy": "UEMatExportMetadata",
                  "generatedAt": "...", "contentRoots": "/Game" },
  "functions": {
    "/Game/Functions/MF_Foo.MF_Foo": {
      "assetPath": "/Game/Functions/MF_Foo.MF_Foo",
      "displayName": "MF_Foo",
      "category": "/Game/Functions",
      "inputs":  [ { "name": "Color", "type": "Float3", "index": 0 }, ... ],
      "outputs": [ { "name": "Result", "type": "Float3", "index": 0 } ],
      "missing": false
    }
  }
}
```

Pin **order matches UE** (sorted by `FunctionInput/Output` `SortPriority`), which is what the
exporter's `FunctionInputs(n)` index depends on. Input `type` is exact; output `type` is a
best-effort `Float3` (UE's `FunctionOutput` carries no declared type) — cosmetic only.

## Run it (on the UE 5.7 machine)

> **No terminal?** The viewer's **`爬取`** button runs this exact crawl (the `workmf` kind) and
> refreshes the Nodes tab live — see the tool
> [`README.md`](../README.md#trigger-a-crawl-from-the-web-viewer-no-terminal). The CLI below is the
> equivalent, and the only option for headless / agent runs.

From the repo root, one command packages the plugin (if stale) then crawls:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot  <Path\To\UnrealEngine> `
  -WorkMF
```

- `-WorkMF` runs **only** the crawl — it does NOT regenerate node metadata.
- Default content root is `/Game`. To crawl extra roots (e.g. a plugin's content), add
  `-WorkMfContentRoots "/Game,/MyPlugin"`.
- The host `.uproject` is just the editor host; it does not need to be your "real" project
  unless that project is where the MFs you want indexed live. **Point `-ProjectPath` at the
  project whose Material Functions you want.**

Direct (skips the package-staleness check; requires the plugin already packaged):

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Run-WorkMfIndex.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot  <Path\To\UnrealEngine> `
  -ContentRoots "/Game"
```

## Expected result

Commandlet log includes:

```text
Wrote work-MF index: <repo>/agent-pack/workmf-index.json (<N> function(s), 0 load failure(s))
Warnings: 0
```

Then confirm the consumer accepts it (runs locally, no UE):

```bash
node -e "const{loadWorkMfIndex}=require('./viewer/dist/server/workmf-index.js');loadWorkMfIndex('agent-pack/workmf-index.json').then(r=>console.log(r.warnings.length?r.warnings:'ok',Object.keys(r.index?.functions||{}).length+' functions'))"
```

(Empty `functions` is valid — it just means no MFs under the crawled root.)

## Guardrails

- The output stays on the user's machine. Do not commit `agent-pack/workmf-index.json`.
- Re-run after adding/renaming/changing a project Material Function's inputs/outputs.
- `bRecursiveClasses=false` indexes concrete `UMaterialFunction` only (not material layers/blends).
- If a referenced MF is missing from the index, the authoring agent must STOP and ask for a
  re-crawl rather than invent pin names (SPEC.md rule).

## Hand-off prompt (paste to the UE-side agent)

> In the `ue-mat-workflow` repo on this UE 5.7 machine, run the WorkMF crawl to index this
> project's own Material Functions:
>
> ```powershell
> powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 -ProjectPath <Path\To\Project.uproject> -EngineRoot <Path\To\UnrealEngine> -WorkMF
> ```
>
> If the build fails on `UMaterialFunctionInterface::GetInputsAndOutputs` or an
> `EFunctionInputType` member name, those are the two version-sensitive spots — fix the
> signature/enum against the installed 5.7 headers (the call sites are flagged with an
> "API NOTE" in `plugin-src/Source/UEMatExportMetadata/Private/UEMatExportMetadataCommandlet.cpp`).
> Confirm the log shows `Wrote work-MF index: ... (N function(s), 0 load failure(s))`, then
> leave `agent-pack/workmf-index.json` in place (it is gitignored — do not commit it).

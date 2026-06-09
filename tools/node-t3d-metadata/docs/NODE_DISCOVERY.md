# Node discovery — find which engine expressions the DB is missing

The authoring DB (`agent-pack/nodes-ue5.7.json`) began as a **hand-written list** of 144
nodes. The metadata commandlet's default mode only fills in detail for the names already on
that list — it never discovers new ones. So the DB can silently lag behind the engine, and a
real material that uses an unlisted node imports with that node **skipped** (its wires drop).

> Discovery has since been run against UE 5.7.4: the engine ships **310** material
> expressions, and the DB was expanded to **~300** (the remainder are reserved/abstract/alias
> types). Re-run it after an engine upgrade, or when a pasted material reports a skipped node.

**Node discovery** closes that gap. Unlike WorkMF (which crawls `/Game` *assets* via the
Asset Registry), material expressions are compiled C++ `UCLASS`es, so discovery enumerates
them by reflection (`GetDerivedClasses(UMaterialExpression::StaticClass(), …)`), diffs
against the DB, and writes a report of what's missing.

## Run it (on the UE 5.7 machine)

```powershell
# Windows (Windows PowerShell 5.1)
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Run-NodeDiscovery.ps1 `
  -EngineRoot <Path\To\UnrealEngine>
```

```shell
# macOS (PowerShell Core 7 — install via the PowerShell .pkg or `brew install --cask powershell`)
pwsh -File ./tools/node-t3d-metadata/plugin-src/Scripts/Run-NodeDiscovery.ps1 \
  -EngineRoot /path/to/UnrealEngine
```

`-ProjectPath` is **optional** for discovery: it only enumerates engine C++
`UMaterialExpression` classes, so no game project is needed. When omitted, the script uses the
bundled minimal host at `tools\node-t3d-metadata\host\NodeDiscoveryHost.uproject`, which also
disables the few default engine plugins (Metasound, Interchange) that abort the unattended
commandlet on some installs. None of those plugins provide material expressions, so coverage is
unaffected. Pass `-ProjectPath <Path\To\Project.uproject>` to run against your own project instead.

Defaults: diffs against `agent-pack\nodes-ue5.7.json`, writes the report to
`tools\node-t3d-metadata\node-discovery.json`. Override with `-NodeDb` / `-Out`.

If even your own project's default engine plugins fail to load, `-NoEnginePlugins` boots a bare
editor with only this plugin — but that drops *plugin-provided* material expressions, so prefer
the bundled host (or fix the broken plugins) when you want full coverage.

The commandlet log ends with, e.g.:

```text
Wrote node discovery report: ...\node-discovery.json (N engine expressions, K in DB, M missing, D deprecated, O orphans)
```

## Report shape

```jsonc
{
  "schemaVersion": "1.0",
  "kind": "node-discovery",
  "engineVersion": "5.7.4-...",
  "counts": { "engineExpressions": 310, "inDb": 299, "missing": 0, "deprecated": 0, "orphansInDb": 0 },
  "missing": [
    {
      "type": "RuntimeVirtualTextureOutput",
      "ueClass": "/Script/Engine.MaterialExpressionRuntimeVirtualTextureOutput",
      "caption": "Runtime Virtual Texture Output",
      "inputs": ["BaseColor", "Specular", "Roughness", "Normal", "WorldHeight", "Opacity", "Mask"],
      "outputs": []
    }
  ],
  "deprecated": ["..."],     // engine classes flagged deprecated — usually skip
  "orphansInDb": ["..."]     // DB keys with no matching engine class (renamed/typo/override)
}
```

`missing[].inputs` / `outputs` are **best-effort** reflection (the same `GetInput`/
`GetInputName`/`GetOutputs` calls the metadata path uses) — enough to seed a DB entry.

## Augmentation workflow (fill the gaps)

1. Run discovery, review `missing[]`. Drop anything you don't want (editor-only bases,
   niche nodes), keep what real materials need.
2. For each kept entry, add a node to `agent-pack/nodes-ue5.7.json` using its `type`,
   `inputs`, `outputs`. Set **`verified: false`** until cross-checked.
3. Regenerate export metadata so the new nodes get exact class paths / pin mappings:
   ```powershell
   # Windows
   powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
     -ProjectPath <...> -EngineRoot <...>
   # macOS
   pwsh -File ./tools/node-t3d-metadata/Invoke-NodeT3DMetadataMaintenance.ps1 `
     -ProjectPath <...> -EngineRoot <...>
   ```
4. `node tools\node-t3d-metadata\audit-export-meta.js` then the viewer tests — both must pass.

## Notes

- The report is just data; it does not modify the DB. Adding nodes is a deliberate,
  reviewed step (so a bad reflection never silently lands in the AI's vocabulary).
- `node-discovery.json` (and the `db-candidates.json` that `build-db-candidates.js` derives
  from it) are gitignored, regenerable outputs — not committed, not bundled into the web build
  (the `dbRegistry` glob only matches `nodes-ue*.json`). Re-run the crawl to regenerate them.

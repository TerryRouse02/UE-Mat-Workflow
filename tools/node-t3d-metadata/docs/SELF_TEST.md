# Node self-test — engine round-trip verification of the authoring DB

Node discovery (see `NODE_DISCOVERY.md`) answers *"which engine expressions is the DB
missing?"*. The **self-test** answers the harder question: *"is what the DB claims about
each node actually true in the engine?"* It is the machine half of the verification
pipeline — after it runs, the only remaining human responsibility for a clean node is
the quality of its `description`.

For every node in `agent-pack/nodes-ue5.7.json`, the commandlet spawns the real
`UMaterialExpression` in a transient material and checks four things:

1. **Pin diff** — the DB's input/output names against the live `GetInputName()` /
   `GetOutputs()` (skipped for `dynamicPins` nodes, whose pin sets depend on instance
   config). Input-type mismatches are reported as soft `typeNotes`, not hard diffs,
   because the DB intentionally writes more specific semantics than the engine's
   value-type mask.
2. **T3D round-trip** — exports the lone node to clipboard T3D, re-imports the text into
   a fresh material, and confirms an expression of the same class arrives.
3. **Export-metadata property check** — every `inputs.*.property` / `params.*.property`
   in `nodes-ue5.7.export.json` must exist on the class; array pins like
   `CustomizedUVs(3)` must fit the property's `ArrayDim`.
4. **Engine defaults** — exports the engine's default value for every DB param as text
   (`defaults` in the report), so missing DB defaults can be filled from engine truth.

## Run it (on the UE 5.7 machine)

```powershell
# Windows (Windows PowerShell 5.1)
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Run-NodeSelfTest.ps1 `
  -EngineRoot <Path\To\UnrealEngine>
```

```shell
# macOS (PowerShell Core 7)
pwsh -File ./tools/node-t3d-metadata/plugin-src/Scripts/Run-NodeSelfTest.ps1 \
  -EngineRoot /path/to/UnrealEngine
```

Like discovery, `-ProjectPath` is optional (defaults to the bundled minimal host) and the
script auto-repackages the plugin when `plugin-src/` is newer than the compiled binary.
Defaults: checks `agent-pack\nodes-ue5.7.json` + `agent-pack\nodes-ue5.7.export.json`,
writes the report to `tools\node-t3d-metadata\node-selftest.json`. Override with
`-NodeDb` / `-ExportMeta` / `-Out`. Avoid `-NoEnginePlugins` here: it drops
plugin-provided expressions (Landscape, …), which then report `class-missing`.

## Report shape

```jsonc
{
  "schemaVersion": "1.0",
  "kind": "node-selftest",
  "engineVersion": "5.7.4-...",
  "counts": { "checked": 296, "clean": 290, "withDiffs": 4, "classMissing": 0, "skipped": 2 },
  "nodes": {
    "Power": {
      "status": "clean",                  // clean | diff | class-missing | skipped
      "ueClass": "/Script/Engine.MaterialExpressionPower",
      "engineInputs": [{ "name": "Base", "type": "Float1|2|3|4" }, ...],
      "engineOutputs": [""],
      "diffs": [],                        // hard diffs -> status "diff"
      "typeNotes": ["input 'Exp': DB type 'Float1' vs engine '...'"],  // soft
      "t3dRoundTrip": "ok",
      "defaults": { "ConstExponent": "1.000000" }
    }
  }
}
```

## Consume the report

```bash
node tools/node-t3d-metadata/apply-selftest.js                  # human summary
node tools/node-t3d-metadata/apply-selftest.js --check          # CI gate: exit 1 on hard diffs
node tools/node-t3d-metadata/apply-selftest.js --mark-verified  # flip clean+described nodes to verified:true
node tools/node-t3d-metadata/apply-selftest.js --fill-defaults  # fill missing float/int/bool param defaults
# add --dry-run to either write flag to preview without touching disk
```

`--mark-verified` only flips nodes whose round-trip found **zero hard diffs** and that
already carry a description; it rewrites the authoring DB and regenerates
`nodes-ue5.7.index.json` so the parity audit stays green. The export metadata is never
rewritten here (it is UE-writer-formatted; see the heal-export-meta gotcha in CLAUDE.md).
Hard diffs are fixed the normal way: edit `nodes-ue5.7.json`, regenerate, re-run.

After any write, finish with the standard gate:

```bash
node tools/node-t3d-metadata/audit-export-meta.js   # must exit 0
pnpm -r test
```

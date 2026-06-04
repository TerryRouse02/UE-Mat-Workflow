# Project Materials crawl — UE commandlet hand-off (Codex / Windows)

> **Audience:** the UE-side worker (Codex) on the Windows + UE 5.7 machine. The viewer (server/web) side is implemented separately (see `docs/superpowers/plans/2026-06-04-project-materials-crawl.md`) and is **already wired** to call your script and post-process its output. This doc defines exactly what your side must produce.

## What this feature does

The viewer gets a new **"重爬專案母材質" (project materials)** crawl. Unlike the existing crawls (which write JSON index/metadata), this one must make the project's `/Game` **parent materials** openable in the viewer. The split of work:

- **🪟 Your job (this doc):** for each `/Game` `UMaterial`, export a **UE T3D clipboard dump** of its expression graph to a fixed staging dir. That's it — no JSON conversion.
- **🟢 Already done (viewer server):** on a successful crawl, the server reads each staged `.t3d`, runs the existing T3D→matgraph converter (`parseUET3D`, the same one the clipboard "導入" uses), and writes `graphs/_project/<Name>/<Name>.matgraph.json` (gitignored, auto-listed under a "Project Materials (crawled)" section). You do NOT touch the viewer.

So: **if your T3D matches what the UE Material Editor's Ctrl+C produces, the rest is automatic.**

## Deliverables

1. A new commandlet mode that enumerates `UMaterial` and exports each as T3D. Follow the existing pattern in `plugin-src/Source/.../commandlet.cpp` — `WriteWorkMfIndex` (triggered by `-WorkMfOut=...`, `FARFilter` with `ClassPaths.Add(UMaterialFunction::StaticClass()...)`). Yours is the analog for `UMaterial`:
   - `FARFilter` with `ClassPaths.Add(UMaterial::StaticClass()->GetClassPathName())`, `PackagePaths` = the content root(s) passed in (default `/Game`), `bRecursivePaths=true`. **Only `UMaterial`** — NOT `UMaterialInstance`/`UMaterialInstanceConstant` (instances are param overrides with no node graph; out of scope).
   - Trigger flag: `-ProjectMatStaging=<dir>` (mirror how `-WorkMfOut` / `-ContentRoots` are parsed in `Main()`).
   - For each material: build its `UMaterialGraph` (e.g. `UMaterial::MaterialGraph` or `UMaterialGraph::RebuildGraph`) and export the nodes to T3D text using the SAME path the editor's copy uses — `FEdGraphUtilities::ExportNodesToText` (or `UEdGraph` export), selecting all nodes **including the root/result node** so the final material-attribute connections survive. Write the resulting text to the staging file.
2. `plugin-src/Scripts/Run-ProjectMaterials.ps1` — a runner mirroring `Run-WorkMfIndex.ps1`: resolves `EngineRoot`/`ProjectPath`/plugin, computes the staging dir, invokes `UnrealEditor-Cmd.exe` with the commandlet + `-ProjectMatStaging=<dir>` + content roots, streams stdout. **Pure ASCII only** (Windows PS 5.1 mangles non-ASCII — no em-dash/ellipsis).
3. Keep it Windows-only and gated by the same env checklist as the other crawls.

## Staging contract (the interface the viewer depends on)

| Aspect | Contract |
|---|---|
| Staging dir | `<repoRoot>/tools/node-t3d-metadata/projectmat-staging/` (fixed; gitignored; the viewer reads then deletes it). Create it if absent; clear stale files at start of a run. |
| One file per material | exactly one `.t3d` file per `/Game` `UMaterial` |
| Filename | `<MaterialShortName>.t3d` (UE asset short name, e.g. `M_Rock_Base.t3d`). No path separators; sanitize to a safe filename. |
| Content | Full UE T3D clipboard format — the exact text `Ctrl+C` in the Material Editor produces (`Begin Object Class=/Script/UnrealEd.MaterialGraphNode ... End Object` blocks). **Must include the root/result node block** so output connections (BaseColor, Normal, …) are present. |
| Encoding | UTF-8 **without BOM**, `\n` line endings |
| MaterialFunctions used by a material | If a material's graph has `MaterialFunctionCall` nodes, ALSO export each referenced project MF as its own `<MFShortName>.t3d` into the same staging dir. The viewer's converter auto-detects Material vs MaterialFunction (by `FunctionInput`/`FunctionOutput` presence), so it handles both. (Engine MFs need not be exported — they resolve via the `enginemf` index.) |
| Completion signal | exit code **0** on full success, non-zero on any failure. The viewer post-processes only on exit 0. No manifest file needed. |
| Idempotency | Overwriting your own staging files on re-run is fine. The viewer writes under `graphs/_project/` and will not stomp hand-authored graphs elsewhere. |

## How it plugs in (for your awareness)

- The viewer's `defaultCommandFor(repo, 'projectmat', ...)` (in `viewer/server/crawl-runner.ts`) spawns `Run-ProjectMaterials.ps1` with the staging dir + content roots.
- On exit 0 the server calls `importProjectMaterials({ stagingDir, graphsRoot, exportMeta })` → `parseUET3D` per file → writes `graphs/_project/<name>/<name>.matgraph.json` → deletes the staging file → refreshes the file list.
- `exportMeta` = `agent-pack/nodes-ue5.7.export.json` (the same metadata the node-export crawl produces). If a material uses a UE class missing from that metadata, the converter emits a warning (doesn't crash) — surfacing missing-node coverage, same as clipboard import.

## Verifying your side (without the viewer)

1. Run `Run-ProjectMaterials.ps1` against a small test project.
2. Confirm the staging dir has one `.t3d` per material, UTF-8/no-BOM, each containing a root node block.
3. Sanity: paste one staged `.t3d`'s contents into the viewer's "導入" box — it should reconstruct the material correctly. If import works, the automated crawl path will too (it calls the identical converter).

## Notes / invariants

- **Public-artifact purity:** staged `.t3d` and `graphs/_project/` are **local, gitignored** — they may contain the project's private `/Game` asset names. Never commit them. (Mirrors the `workmf-index.json` rule.)
- This is the same "one shared T3D→matgraph pipeline" used by clipboard import — if import handles a material, the crawl will too.

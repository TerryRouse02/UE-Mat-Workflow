# Project-Materials Crawl Implementation Plan (Plan 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) or subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a `projectmat` crawl that turns a UE project's `/Game` parent materials into openable, gitignored `.matgraph.json` files shown under a distinct "Project Materials (crawled)" section, and regroup the crawl buttons into primary (project) vs advanced (official-native).

**Architecture:** The Codex commandlet (🪟, separate hand-off) exports one UE T3D dump per `UMaterial` into a fixed staging dir. On a successful `projectmat` crawl the server runs the **existing T3D→matgraph converter** (`parseUET3D`) on each dump and writes `graphs/_project/<name>/<name>.matgraph.json` (gitignored, auto-watched). `FileEntry.origin` distinguishes crawled vs agent files; the Files panel sections them.

**Tech Stack:** TypeScript; native Node http+ws server; React/ReactFlow web; vitest. Tests: `viewer/node_modules/.bin/vitest run` (pnpm not on PATH).

**Branch:** `feat/viewer-workflow-enhancements` (continues after Plan 1).

## Investigation findings (load-bearing facts)

- **Converter:** `parseUET3D(text: string, meta: ExportMeta, opts?: { name?: string }): { graph: MatGraph; warnings: string[] }` in `viewer/web/src/export/ueT3D.ts`. Auto-detects Material vs MaterialFunction by presence of `FunctionInput`/`FunctionOutput` (ueT3D.ts ~1472).
- **Purity = (b):** `parseUET3D` is pure; only contamination is `import { NODE_W } from '../layout'` (layout.ts imports `dagre`). `NODE_W` is used only by the export half (`graphToUET3D`), NOT by `parseUET3D`. Fix: inline `NODE_W` / split the import half into a node-free module.
- **Server cannot rely on web's tsconfig.** The extracted module must live where the server's `viewer/tsconfig.json` compiles it (verify `include`); web already imports from `../../server/*`, so a server-side or shared location both can import is fine.
- **Import today:** client converts → `POST /api/import` → `handleImport` (http-server.ts:123-151) writes via `mkdir(recursive)+writeFile` with `slugifyGraphName`/`isInside`/`freeProjectName` (http-server.ts:77) guards. Reuse these.
- **`exportMeta`** is loaded from `agent-pack/nodes-ue5.7.export.json` (server can read it).

## File Structure

| File | Responsibility |
|---|---|
| `viewer/web/src/export/ueImport.ts` (new) | Node-free: `parseUET3D` + pure helpers, importable by server AND web |
| `viewer/web/src/export/ueT3D.ts` (modify) | Re-export `parseUET3D` from `ueImport` (keep web call-sites working); keep `graphToUET3D` here |
| `viewer/server/graph-write.ts` (new) | `writeGraph(graphsRoot, name, graph)` factored from `handleImport`; reused by import + projectmat |
| `viewer/server/projectmat-importer.ts` (new) | `importProjectMaterials({stagingDir, graphsRoot, exportMeta})` → reads staged T3D, converts, writes `graphs/_project/<name>/` |
| `viewer/server/crawl-runner.ts` (modify) | `CrawlKind += 'projectmat'`; `defaultCommandFor` → `Run-ProjectMaterials.ps1` |
| `viewer/web/src/crawlRequest.ts` (modify) | `CrawlKind += 'projectmat'` (mirror) |
| `viewer/server/http-server.ts` (modify) | allowlist `projectmat`; on `projectmat` done(exit 0) call `importProjectMaterials` + refresh file list; `listFiles` infers `origin` |
| `viewer/server/ws-protocol.ts` + `viewer/web/src/protocol.ts` (modify) | `FileEntry.origin?: 'agent' | 'crawled'` (mirror) |
| `viewer/web/src/groupFiles.ts` (modify) | origin-aware grouping |
| `viewer/web/src/FileList.tsx` (modify) | "專案母材質（爬取）" section + badge |
| `viewer/web/src/ConfigPanel.tsx` (modify) | primary vs advanced crawl groups + `projectmat` button |
| `.gitignore` (verify) | `graphs/**` already ignores `graphs/_project/`; confirm no `!` exception re-includes it |

---

### Task 1: Extract the pure converter

**Files:** Create `viewer/web/src/export/ueImport.ts`; modify `viewer/web/src/export/ueT3D.ts`; verify server tsconfig include.

- [ ] **Step 1:** Move `parseUET3D` and the helpers it uses (and ONLY those) into `ueImport.ts`. Inline `const NODE_W = 220` if needed (drop the `../layout` import from the moved code). `ueImport.ts` must import nothing from React/ReactFlow/`node:`/`../layout`. Keep `ExportMeta`/`UEImportResult` types where both files can use them (in `ueImport.ts` or `export-meta-types`). In `ueT3D.ts`, `export { parseUET3D } from './ueImport'` so existing web imports keep working.
- [ ] **Step 2: Verify server can import it.** Confirm `viewer/tsconfig.json` `include` compiles `ueImport.ts` (it imports `viewer/web/src/...`; if not included, add the path or place `ueImport.ts` accordingly). Add a trivial server-side test or a tsc check.
- [ ] **Step 3:** Run existing `viewer/tests/ueT3D.test.ts` (the parse tests) — they exercise `parseUET3D` through the re-export and must stay green. Run `vitest run ueT3D` + server tsc + web build.
- [ ] **Step 4: Commit** — `feat(viewer): extract parseUET3D into a node-free shared module` (+ trailer).

### Task 2: `writeGraph` helper + `projectmat-importer`

**Files:** Create `viewer/server/graph-write.ts`, `viewer/server/projectmat-importer.ts`; refactor `handleImport` to use `writeGraph`; create `viewer/tests/projectmat-importer.test.ts` + a fixture `viewer/tests/fixtures/projectmat/<Name>.t3d`.

- [ ] **Step 1: Write failing test** — `importProjectMaterials({ stagingDir: <fixture dir with one .t3d>, graphsRoot: <tmpdir>, exportMeta })` returns `{ imported: ['<Name>'], warnings }` and writes `<tmpdir>/_project/<Name>/<Name>.matgraph.json` whose parsed JSON has `type:'Material'` and ≥1 node. Use a real small T3D fixture (copy a minimal Material T3D — can reuse a sample from `ueT3D.test.ts`).
- [ ] **Step 2: Run, expect FAIL** (module missing).
- [ ] **Step 3: Implement** `graph-write.ts` (`writeGraph(graphsRoot, name, graph)` = slugify + `_project/` is handled by caller via folder, `mkdir recursive`, `writeFile JSON+'\n'`, `isInside` guard) and `projectmat-importer.ts` (readdir staging `*.t3d` → `parseUET3D(read, exportMeta, {name: base})` → write under `_project/<base>/` → collect warnings → delete staging file). Refactor `handleImport` to call `writeGraph`.
- [ ] **Step 4: Run, expect PASS** + existing import tests green.
- [ ] **Step 5: Commit** — `feat(viewer): server-side project-materials importer (staged T3D -> matgraph)`.

### Task 3: `projectmat` crawl kind wiring + completion trigger

**Files:** Modify `crawl-runner.ts` (union + `defaultCommandFor` case → `plugin-src/Scripts/Run-ProjectMaterials.ps1` with `-StagingDir`/content-root args, mirroring `Run-WorkMfIndex.ps1`), `crawlRequest.ts` (union), `http-server.ts` (allowlist + on `projectmat` crawl done(exit 0): `await importProjectMaterials(...)`, broadcast `fileList`), `crawl-types.ts` if the kind is referenced there.

- [ ] **Step 1: Write failing tests** — extend `viewer/tests/crawl-runner.test.ts`/`crawl-api.test.ts`: `defaultCommandFor(repo,'projectmat',...)` returns a spec naming `Run-ProjectMaterials.ps1`; `POST /api/crawl {kind:'projectmat'}` passes the allowlist (not 400).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the 5-place wiring + the http-server completion hook (only `projectmat` triggers the importer; others unchanged).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** — `feat(viewer): wire projectmat crawl kind + post-crawl import trigger`.

### Task 4: `FileEntry.origin` + grouping + Files section

**Files:** Modify `ws-protocol.ts` + `protocol.ts` (`origin?: 'agent'|'crawled'`), `http-server.ts` `listFiles` (origin = path starts with `_project/` ? 'crawled' : 'agent'), `groupFiles.ts` (origin-aware), `FileList.tsx` (separate "專案母材質（爬取）" section + badge), tests in `group-files.test.ts` + `http-server.test.ts`.

- [ ] **Step 1: Write failing tests** — a file under `_project/` yields `origin:'crawled'`; `groupFiles` separates crawled vs agent.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** origin inference + grouping + the FileList section/badge.
- [ ] **Step 4: Run, expect PASS** + build.
- [ ] **Step 5: Commit** — `feat(viewer): distinguish crawled project materials in the file list`.

### Task 5: ConfigPanel button regrouping

**Files:** Modify `viewer/web/src/ConfigPanel.tsx` — two groups: PRIMARY「主要（專案）」 = `workmf`("重爬專案 Material Function") + `projectmat`("重爬專案母材質"); ADVANCED「進階／維護」 = `export`("重爬節點導出") + `enginemf`("重爬引擎 Material Function") in a collapsible/secondary block. Wire `projectmat` through the existing `doCrawl`.

- [ ] **Step 1:** Read ConfigPanel; restructure the crawl buttons into the two labelled groups; add the `projectmat` button. (UI — no new unit test; verify via build + manual.)
- [ ] **Step 2: Verify** — server tsc + web build; `vitest run` all green.
- [ ] **Step 3: Commit** — `feat(viewer): regroup crawl buttons (primary project vs advanced maintenance)`.

---

## Build/verify checkpoint

- `viewer/node_modules/.bin/vitest run` (all green, 252 + new)
- `(cd viewer && node_modules/.bin/tsc -p tsconfig.json)` and `(cd viewer/web && node_modules/.bin/tsc -b && node_modules/.bin/vite build)`
- `node tools/node-t3d-metadata/audit-export-meta.js` exits 0 (no public-artifact change)
- Manual: drop a sample `.t3d` into the staging dir, run the importer path, confirm a `graphs/_project/...` file appears under the crawled section.

## 🪟 Codex hand-off (NOT in this plan)

The `projectmat` button is wired but inert until Codex adds the UE side per `tools/node-t3d-metadata/docs/PROJECT_MATERIALS.md`: a commandlet mode that `FARFilter`s `UMaterial` over the content root and writes one T3D per material into the staging dir, plus `Run-ProjectMaterials.ps1`. Crawl is Windows-only, so this is untestable locally regardless.

## Self-Review

- **Spec coverage:** #1 pipeline → T1+T2+T3; #1 Files distinction → T4; #2/#3 button reorg → T5. ✓
- **Placeholders:** none — each task names exact files + the test assertion; converter facts embedded above.
- **Type consistency:** `parseUET3D` signature, `importProjectMaterials` opts, `writeGraph` signature, `FileEntry.origin`, `CrawlKind`'s `'projectmat'` literal used consistently across tasks and both mirror files.
- **Risk:** T1 server-import boundary — Step 2 verifies the tsconfig include before building on it.

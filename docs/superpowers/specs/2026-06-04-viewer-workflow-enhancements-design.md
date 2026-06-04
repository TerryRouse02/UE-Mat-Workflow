# Viewer Workflow Enhancements — Design

**Date:** 2026-06-04
**Status:** Approved (design); pending spec review → implementation plan
**Scope owner split:** 🟢 = I implement (server/web, local). 🪟 = Codex/Windows hand-off (needs live UE).

## 1. Goals

Make the web viewer's project-facing workflow production-grade for teams who consume (not author) materials in the browser:

1. **Crawl project parent materials** into openable files, distinguished from Agent-authored materials. *(was #1)*
2. **De-emphasize the official/native crawls** (node export, engine MF) as advanced/maintenance, keep them available. *(was #2)*
3. **Make the project crawls (project MF + project materials) the primary, reliable path.** All four crawl buttons work flawlessly. *(was #3)*
4. **Stop large graphs (stress_all_nodes, 685 nodes) freezing the UI** with a confirm-before-open gate. *(was #4)*
5. **Fix the comment-box double-frame behavior** with a correct nested model that still exports to UE. *(was #5)*

Non-goals here: the visual product redesign (#6, separate Designer track), in-browser node editing, Web-Worker layout (future), `UMaterialInstance` crawling (future).

## 2. Background (current state)

- **Crawl subsystem:** 3 kinds — `export` (node metadata), `enginemf`, `workmf` — all produce JSON index/metadata, **not** viewable files. Adding a kind touches 5 places: both `CrawlKind` unions (`crawl-runner.ts:14`, `crawlRequest.ts:1`), `defaultCommandFor` (`crawl-runner.ts:46-67`), the http allowlist (`http-server.ts:261`), and the `crawlDone` reducer (`store.tsx:92-95`). `workmf` is the gitignored, server-only precedent.
- **The commandlet has no project-material export mode today** (`FARFilter` is `UMaterialFunction`-only). 🪟
- **File listing:** server `listFiles` (`http-server.ts:361-378`) walks `graphs/**`, reads each file's `type`. `FileEntry = {path, type}` — **no origin/source metadata**. `groupFiles` groups by first path segment; `FileList` splits Materials/Functions sub-tabs. `graphs/**` is gitignored except `!graphs/stress_*`.
- **Comment boxes:** rendered as passive (`draggable:false`) ReactFlow nodes whose rectangle is recomputed from the **live positions of `contains` members** every render (`Graph.tsx` `commentNodes` useMemo). A node listed in two comments' `contains` makes both boxes track it → both move on drag. Export (`ueT3D.ts`) computes its own bounds from `contains` for T3D emission.
- **Large-graph freeze:** 100% client-side — synchronous `dagre.layout()` (~200-800ms) + ReactFlow measuring N DOM nodes. Server resolve is ~20-30ms async. Edge build is O(E×N).

## 3. Feature design

### 3.1 Comment boxes — nested ownership model (#5)

**Model.** `contains: string[]` keeps its meaning: *every box that spatially encloses a node lists that node* (so a node inside a nested pair appears in both inner and outer `contains` — unchanged, round-trips faithfully). The viewer derives structure at render/export time:

- **Ownership:** each node is owned by the **smallest** comment (fewest members; ties broken by comment id) that contains it — the innermost box that "serves" it.
- **Nesting:** comment `B` is nested in comment `A` iff `B.contains ⊆ A.contains` and `|B| < |A|`. `A`'s *immediate* children are the smallest such supersets.
- **Bounds (bottom-up):** `bounds(C) = hull( {nodeBox(n) : owner(n)=C} ∪ {bounds(D) : parent(D)=C} )`. Computed in increasing size order.
- **Drag locality:** dragging a node recomputes its owner box and that box's ancestors only. Unrelated sibling boxes never move. ← directly satisfies "不會影響到其他的部分".
- **Sibling overlap** (two comments share a node, neither a subset of the other): the genuine ambiguity. The node is owned by the **smaller** comment; the larger does not frame it. A **schema/diagnostics warning** ("node X is in N overlapping comment groups") surfaces it (warning, never blanks the canvas — consistent with existing structural warnings).

**UE export constraint (hard requirement).** Export must keep producing UE comment rectangles. We extract **one shared `computeCommentBounds(comments, nodePositions)`** used by both `Graph.tsx` (render) and `ueT3D.ts` (export), so the exported rectangle is identical to the rendered one. Because a parent box's hull includes its child box (which includes the node), the exported outer comment geometrically encloses the inner comment and its nodes — faithful nested UE comments. Sibling-overlap resolution changes only the genuinely ambiguous case (flagged), which is acceptable.

**Touch points:** `Graph.tsx` (`commentNodes`), new shared `commentBounds.ts`, `ueT3D.ts` export bounds (571-575, 638-674), `graphDiagnostics.ts` + server `schema.ts` (overlap warning), tests.

### 3.2 Large-graph confirm gate (#4)

- Add `nodeCount?: number` to `FileEntry` (both mirrors). Server populates it in `listFiles` (one parse per file at startup/watch — O(files), not per-open).
- File list shows the node count per row. Opening a file whose `nodeCount > THRESHOLD` (default **300**, single constant) shows a confirm: *"此圖較大（N 節點），開啟可能短暫卡頓，要繼續嗎？"*.
- The `App.tsx` startup auto-open of `files[0]` is gated by the same threshold (otherwise it bypasses the confirm).
- Cheap adjacent fix: replace the O(E×N) edge build in `Graph.tsx` with a `Map<id,type>` lookup.
- Web-Worker layout is **out of scope** (roadmap) — the gate matches the requested "訪問前詢問" and ships safely.

**Touch points:** `ws-protocol.ts` + `protocol.ts` (`nodeCount`), `http-server.ts` `listFiles`, `FileList.tsx`/`App.tsx` (gate), `Graph.tsx` (edge map).

### 3.3 Project-materials crawl + Files distinction + button regrouping (#1-3)

**New crawl kind `projectmat`.** Pipeline (chosen: commandlet emits T3D, server converts):

1. 🪟 **Commandlet (new mode):** `FARFilter` on `UMaterial` over the configured `/Game` root; export each material as **T3D** (same format the clipboard import already consumes) into a staging dir. A new `Run-ProjectMaterials.ps1` runner wires it like the existing crawls.
2. 🟢 **Server post-process:** on `projectmat` crawl success, read the staged T3D, run the **existing T3D→matgraph converter** on each material, and write `graphs/_project/<material>/<material>.matgraph.json` (+ referenced MFs copied alongside, per the one-folder-per-material convention). Then clean staging.
3. 🟢 chokidar auto-picks up the new files → they appear in Files.

**Shared converter (key technical item).** Reuse the import converter (`parseUET3D` in `ueT3D.ts`). If it is web-only, extract it (and pure deps) into a **node-free shared module** usable by the server — mirroring the `crawl-types.ts`/`workmf-types.ts` node-free pattern. This is the main implementation risk and the plan must verify no browser deps.

**Files distinction.**
- Crawled materials live in **`graphs/_project/`** — auto-gitignored (`graphs/**`), auto-watched, never committed (same invariant as `workmf-index.json`).
- `FileEntry` gains `origin?: 'agent' | 'crawled'`; server infers `'crawled'` from the `_project/` path prefix in `listFiles`.
- `groupFiles` becomes origin-aware: `crawled` entries are grouped by their material subfolder and rendered in a dedicated **"專案母材質（爬取）"** section with a badge, visually separate from Agent projects.

**Button regrouping (#2/#3).** `ConfigPanel` splits the flat crawl section into two:
- **主要（專案）：** `重爬專案 Material Function` (`workmf`) · `重爬專案母材質` (`projectmat`).
- **進階／維護（官方原生，一般用不到）：** `重爬節點導出` (`export`) · `重爬引擎 Material Function` (`enginemf`) — inside a collapsed/secondary disclosure.

**The 5-place wiring for `projectmat`:** both `CrawlKind` unions, `defaultCommandFor`, http allowlist, `crawlDone` reducer (+ the new server post-process hook). The `projectmat` reducer behaves like `workmf` (gitignored, server-side) but additionally writes files → the watcher's `fileList` broadcast refreshes the Files tab; no `metadataVersion` bump.

**Decisions locked:** `UMaterial` only (no instances); folder `graphs/_project/`; reuse the configured project/MF root unless a separate "materials root" proves necessary during implementation.

## 4. Cross-cutting changes

| Change | Files |
|---|---|
| `FileEntry { origin?, nodeCount? }` | `viewer/server/ws-protocol.ts`, `viewer/web/src/protocol.ts` (mirror — invariant #5) |
| `CrawlKind += 'projectmat'` | `crawl-runner.ts`, `crawlRequest.ts` (both unions) |
| Shared `computeCommentBounds` | new `viewer/web/src/commentBounds.ts` (or shared), consumed by `Graph.tsx` + `ueT3D.ts` |
| Shared T3D→matgraph converter (node-free) | extract from `ueT3D.ts` if web-only |

## 5. Testing

- **Comments:** unit tests for `computeCommentBounds` — nested (inner+outer), sibling overlap (smaller owns; warning emitted), drag locality (moving an owned node changes only owner+ancestors), and an **export round-trip** test (render bounds == export bounds; nested boxes survive matgraph→T3D→matgraph). Fix the `stress_common` data smell or assert the new behavior on it.
- **Large graph:** `FileEntry.nodeCount` populated; gate fires above threshold; auto-open gated.
- **Crawl:** `projectmat` passes the allowlist; `defaultCommandFor` emits the right command; the server post-process converts a sample staged T3D into a valid `graphs/_project/` matgraph (tested with a checked-in T3D fixture, no UE needed); `origin` inferred; `groupFiles` sections it correctly.
- Existing 237 tests stay green; `audit-export-meta.js` exit 0 (no public-artifact changes).

## 6. Sequencing & ownership

1. 🟢 **#5 comments** — front-end + export + shared bounds + tests. Self-contained.
2. 🟢 **#4 large-graph gate** — `FileEntry.nodeCount`, gate, edge-map fix.
3. **#1-3 project materials:**
   - 🟢 Server converter + `graphs/_project/` + `FileEntry.origin` + `groupFiles`/`FileList` section + `ConfigPanel` regrouping + `projectmat` wiring — testable now with a checked-in T3D fixture, no UE needed.
   - 🪟 **Codex hand-off:** new commandlet `UMaterial` T3D-export mode + `Run-ProjectMaterials.ps1`. I write the hand-off spec; Codex implements + verifies on the Windows/UE machine.
4. Designer prompt (#6) + fuller recommendations (#7) tracked separately.

## 7. Risks / open items

- **Converter sharing:** `parseUET3D` may carry browser assumptions; extraction to a node-free module is the main risk. Plan must verify first.
- **Round-trip fidelity** for sibling-overlap comments changes the ambiguous case only (flagged) — accepted.
- **Staging contract** between the commandlet T3D dump and the server post-process must be defined in the Codex hand-off (path layout, one file per material, encoding).

## 8. Future directions (from #7)

- One shared T3D→matgraph pipeline for clipboard-import, project-material crawl, and a future "crawl-then-diff against the agent's version".
- "在 UE 中開啟此資產" deep-link to close the crawl→view→UE loop; optional lightweight param/wire editing.
- Incremental crawl with UE-version + timestamp metadata; a "上次爬取於 X" freshness indicator for the gitignored local data.
- Clear product split between "view materials" and "maintain/crawl" surfaces — the substance the #6 Designer pass should organize.

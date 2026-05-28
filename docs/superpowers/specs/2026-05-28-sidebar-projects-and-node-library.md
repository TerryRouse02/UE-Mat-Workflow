# Sidebar — Projects & Node Library

Date: 2026-05-28
Scope: viewer (left sidebar) + agent-pack docs

## Problem

Two pain points reported during real-world AI material generation:

1. **Flat file list mixes unrelated materials.** AI writes each material as a separate JSON in `graphs/`. As the number of materials grows, browsing is messy and the relationship between a Material and its MaterialFunctions is invisible.
2. **No way to discover / verify nodes.** The DB has 142 UE 5.7 expressions. Users cannot browse or search what exists, so they cannot verify what AI generated or discover what they could ask for.

## Design

### Task 1: Project-folder file management

**Convention**: `graphs/<project>/` is one project. Each project folder contains exactly **one Material file** plus N MaterialFunction files used by it. MFs are project-local — no cross-project sharing.

```
graphs/
  obsidian/
    obsidian.matgraph.json         [Material]
    fresnel_lib.matgraph.json      [MF]
  flashing_emissive/
    flashing_emissive.matgraph.json
    sine_pulse.matgraph.json
  05_fresnel_glow.matgraph.json    [legacy, root-level → Unorganized]
  06_fresnel_custom.matgraph.json  [legacy, root-level → Unorganized]
```

**Project validity rule (deterministic)**: a folder under `graphs/` is a "project" iff it contains **exactly one** Material file. Anything else (root-level files, folders with 0 or ≥2 Materials, the legacy `graphs/functions/` directory if MF-only) → grouped under **Unorganized**.

**MF path resolution**: unchanged. MaterialFunctionCall `params.MaterialFunction` stays relative to the importing file's directory. Within a project folder, sibling MFs resolve as `"./<mf>.matgraph.json"`. The server-side resolver in `viewer/server/mf-resolver.ts` already uses `dirname(absPath)`, so no code change is needed.

**Sidebar Files tab UI**:

```
[Files] [Nodes]
─────────────────
▼ obsidian/
    ● obsidian          [Material]
    · fresnel_lib       [MF]
▼ flashing_emissive/
    ● flashing_emissive
    · sine_pulse
▶ Unorganized (3)
```

Rules:
- Folders are collapsible (default: expanded). Folders themselves are listed alphabetically; Unorganized always sorts last.
- Within a folder: Material first, MFs after, both alphabetical within their group.
- Material rendered with filled-circle icon `●`; MF with middle-dot `·`.
- Click any file → opens it in the graph view (same behavior as today).
- `Unorganized (N)` section is always rendered when N>0, default collapsed.

### Task 2: Node Library

**UI**: Sidebar gains a tab strip at the top: `[Files] [Nodes]`. Files tab keeps the tree above. Nodes tab is new:

```
[Files] [Nodes]
─────────────────
Search: [______________]
▼ Math (28)
    Add
    Multiply
    LinearInterpolate
    ...
▼ Vector (15)
    ...
▶ Material (12)
▶ Custom (1)
```

- **Search**: case-insensitive substring match across `name + description`. When non-empty, all categories auto-expand and only matching nodes show. Category headers stay visible (so users see which group a match comes from). Counts in headers reflect filtered counts.
- **Categories**: derived from `NodeDef.category`. Listed in alphabetical order; collapsible; default state when search is empty: all collapsed (use disclosure to expand the one you want).
- **Inline detail** on click: the node row expands inline (no separate detail pane) to show:
  - Description (one line, italic)
  - Inputs: `name : type` per line
  - Outputs: `name : type` per line
  - Params: `name : type = default` per line (only if `params` defined)
  - Badges: `✓ verified` (green), `↻ dynamic` (gold) if `dynamicPins`, `⚠ deprecated` (red) if flagged
- **No interactivity beyond viewing** (no drag-to-graph). This is a reference UI, not an editor.

**Data source**: `viewer/web/src/db.ts` already bundles the DB into the client via the `@db` Vite alias. No server change needed for the Node Library itself.

### Implementation surface

| File | Action |
|---|---|
| `viewer/web/src/Sidebar.tsx` | New — tab strip + slot for Files/Nodes panel |
| `viewer/web/src/FileList.tsx` | Refactor — render tree from grouping output instead of flat |
| `viewer/web/src/groupFiles.ts` | New — pure function `groupFiles(entries: {path, type}[]) → ProjectTree` |
| `viewer/server/http-server.ts` + `ws-protocol.ts` | Extend `hello` + `fileList` payloads from `files: string[]` to `files: {path: string, type: 'Material'|'MaterialFunction'|'Unknown'}[]`. Server reads only the JSON's top-level `type` field. |
| `viewer/web/src/NodeLibrary.tsx` | New — search + categories + inline detail |
| `viewer/web/src/App.tsx` | Replace direct `<FileList />` mount with `<Sidebar />` |
| `viewer/tests/group-files.test.ts` | New — unit tests for grouping rules |
| `agent-pack/SPEC.md` | Update §"Where to write" + §"MaterialFunctionCall path" |
| `agent-pack/CLAUDE.md` / `AGENTS.md` / `GEMINI.md` | Mirror the SPEC update |

**Not touched**: `Graph.tsx`, `viewer/server/mf-resolver.ts` (no resolver change), `viewer/server/watcher.ts`, `viewer/web/src/nodes/**`.

### Grouping algorithm (pure)

Input: list of relative paths under `graphs/` (already streamed via existing `fileList` WS message). The client also needs to know which files are `type: "Material"` vs `"MaterialFunction"` to apply the rule. Two ways to know this:

1. **From loaded graphs only** — but we don't preload every graph.
2. **From file name + on-demand metadata** — when a file is selected, server returns its type in the existing `graph` payload. Until selected, we don't know its type.

To make grouping work without preloading every file, we send a lightweight summary: extend the existing `hello` message and `fileList` message to include a parallel array `types: ("Material" | "MaterialFunction" | "Unknown")[]`. Server reads only the `type` field of each JSON (cheap — top-level field, no full parse needed via `JSON.parse` once, cached).

Algorithm:
```
groupFiles(files, types):
  byFolder: Map<folderName, {materials: [], mfs: [], unknown: []}>
  for (path, type) in zip(files, types):
    segments = path.split('/')
    if segments.length == 1:        # root-level file
      → Unorganized
    else:
      folder = segments[0]
      byFolder[folder].push by type
  for (folder, contents) in byFolder:
    if contents.materials.length == 1 and contents.unknown.length == 0:
      → Project(folder, material=contents.materials[0], mfs=contents.mfs)
    else:
      → Unorganized (all contents)
  return { projects: [...], unorganized: [...] }
```

### Testing

- **Unit**: `groupFiles` with cases — single project, project missing material, project with 2 materials, root-level only, mixed.
- **Visual**: manually load `graphs/obsidian/` (created during implementation as a smoke test) and confirm sidebar shows it correctly.

### Migration / back-compat

- Existing graphs (`05_fresnel_glow.matgraph.json`, `06_fresnel_custom.matgraph.json`) remain functional — they appear under Unorganized.
- `graphs/functions/` is no longer privileged. If any project happens to be named "functions" (unlikely), it goes through the same rule.
- No filesystem migration script. Users move files as they refactor; AI starts using new convention via updated SPEC.md.

### Out of scope (explicitly)

- Drag-from-library to add nodes to graph.
- Project README / metadata files.
- Cross-project MF reuse / symlinks / shared library.
- Bulk file operations (rename / delete / move) from the sidebar.
- Node usage indicators ("this node is used in X graphs").

## Open decisions resolved during brainstorming

| Decision | Choice |
|---|---|
| Project boundary representation | Physical folders `graphs/<project>/` |
| MF sharing across projects | Not supported — project-local MFs only |
| Sidebar layout for projects | Collapsible tree, Material-then-MF order |
| Node library location | Left sidebar tab `[Files] [Nodes]` |
| Library search scope | name + description, case-insensitive substring |
| Library detail style | Inline expand in the row |
| Legacy flat files | Show under Unorganized, no forced migration |

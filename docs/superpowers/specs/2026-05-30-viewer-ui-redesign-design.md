# Viewer UI Redesign — Align to Reference Design

Date: 2026-05-30
Scope: `viewer/web` (React UI) + small `viewer/server` wiring for sync state. No data-format or agent-pack changes.

## Problem / Goal

The viewer works but its UI is unpolished: a vertical `Breadcrumb → WarningPanel → [Sidebar | ReactFlow]` stack, hardcoded `#1a1a1a`/`#333` inline colors, Export buttons + MF-root input crammed into a ReactFlow `Panel`, no node inspector, and a bare inline toast.

A reference prototype (`~/Downloads/UE-MAT Workflow Viewer.html`) defines a polished, 3-pane Material Viewer. **Goal:** restyle and restructure the real `viewer/web` to match that reference's layout, dark theme, and interaction polish — while keeping the real architecture intact.

The reference is a standalone React+Babel prototype (different tech, hand-built canvas). It is a **visual/UX target only**; we adopt its look and structure, not its code or its data shapes.

## Locked decisions

1. **Reference = target design; we modify the real `viewer/web`.** (Not editing the reference file; not producing a separate UI.)
2. **Full adoption** — layout + theme + interaction.
3. **Keep ReactFlow + dagre + ws hot-reload.** Reskin via custom node/edge components + CSS. Do NOT replace the canvas engine with the reference's hand-built canvas.
4. **Token-first, component-by-component execution.** Build the CSS design-token layer + shell first, then reskin region by region — each step independently runnable and reviewable.

## Non-goals (this redesign)

- No node/graph editing — v1 stays **view-only**. Inspector is read-only. (Node drag-to-reposition stays, non-persisted, as today.)
- **No user-facing theme switcher.** One fixed dark theme. (The reference's bottom-right "Tweaks" panel is the prototype tool's edit-mode, not product UI.) Rationale: appearance is not the product; ship a single good default.
- No new runtime dependencies. Reskin uses existing React/ReactFlow + CSS + unicode glyphs / inline SVG (the reference uses no icon library).
- No change to `.matgraph.json` format, the node DB, the dagre layout, or the export T3D logic.

## Design

### A. App shell / regions

Replace the current `App.tsx` vertical stack with the reference's region structure:

```
.app  (root; holds CSS token variables)
├─ header.hdr
│   ├─ brand            ▦ UE·MAT / workflow
│   ├─ breadcrumb       project / file.matgraph.json     (reuse existing Breadcrumb logic)
│   └─ right            ● watching · synced Ns ago   +   [Export to UE]
├─ .body  (3 columns)
│   ├─ aside.sidebar           Files / Nodes tabs         (reuse existing Sidebar + NodeLibrary + FileList)
│   ├─ main.canvas-wrap
│   │   ├─ .canvas-topbar      material name + Shading/Blend chips + unknown-node warning + node/link counts
│   │   └─ <ReactFlow>         (reskinned; MiniMap + Controls kept)
│   └─ aside.inspector-wrap    NEW Inspector (selected-node detail / material props + export readiness)
└─ <ToastStack>                NEW (export result + ws hot-reload notices)
```

The current `WarningPanel`'s role is absorbed into the **canvas topbar** (summary: graph-load **errors** ⛔ + **warnings** ⚠ counts for the current graph) and the **Inspector** (per-node callout). This must surface **all** of `state.errors[current]` and `payload.warnings` — not only "unknown node" warnings (e.g. parse/schema errors and MF-resolution warnings must still appear). Keep `WarningPanel.tsx` logic; relocate its presentation.

### B. Design-token layer (new `theme.css`)

Introduce a single CSS variable layer on `.app`, replacing scattered inline color literals in `App.tsx`/`Graph.tsx`/CSS:

- Surfaces: `--bg0`, `--bg1`, `--bg2`, `--bd` (border), `--hed` (header bg) — Graphite tone values.
- `--accent` (`#a06bff`), `--radius` (`7px`), `--row` (`32px`), `--fs` (`13px`).
- **Pin-type colors** and **category colors**: adapt the reference's `PIN_COLORS`/`CAT_COLORS` to the **real** type vocabulary (`Float1/Float2/Float3/Float4`, `MaterialAttributes`, `texture`, `bool`, …). A single `pinColor(type)` / `catColor(cat)` helper is the source of truth, used by nodes, edges, and the Inspector pin lists.

### C. Canvas reskin (ReactFlow kept)

- **Custom nodes** (`nodes/*.tsx` + `nodes/styles.css`): reshape to the reference node anatomy — header row (category dot + title + subtitle), pin rows (colored dot + label; inputs left / outputs right), unknown `!` badge, MaterialFunction `ƒ` badge. **Nodes become param-free** — parameters move to the Inspector (decision; see §F). The current on-node code-param Copy button is preserved *in the Inspector*, not on the node.
- **MaterialFunctionCall double-click → enter MF** (`onEnterMF`) is preserved, with the `ƒ` badge as the visual cue.
- **Edge hover → highlight both endpoint handles** (current `setHandleHighlight` behavior) is preserved.
- **Edges**: colored by source-pin type via `pinColor()`. On node selection, **dim non-connected nodes and edges** (reference behavior).
- **Background**: dotted grid (ReactFlow `Background variant="dots"`, themed).
- **MiniMap**: **KEPT** at bottom-right, themed to the dark palette. (Hard requirement — see below.)
- **Zoom controls**: provide the reference's `+ / − / Fit / zoom%` affordance. Implement by restyling ReactFlow's native `Controls` (or a small custom `Panel` calling `useReactFlow().zoomIn/zoomOut/fitView`). Native `Controls` + `MiniMap` are both retained.

**Reliable node positioning (hard requirement):** entering the viewer or switching graphs must always land the viewport on the node graph — never blank space. Call `fitView` **on initial load AND whenever the active graph changes** (effect keyed on the current graph/payload), not just once on mount. The MiniMap stays visible as a secondary locator.

### D. Sidebar reskin (reuse existing IA)

The Files-tab **project tree** (`graphs/<project>/` = one Material + N MFs, plus an *Unorganized* group) and the **Node Library** already exist per the 2026-05-28 spec (`2026-05-28-sidebar-projects-and-node-library.md`). This is mainly a **visual reskin**; preserve all current behavior and add reference affordances only where data allows:

- **Files tab — preserve:** collapsible project folders (default open), *Unorganized* group (default collapsed), file rows with type icon (Material / MF / Unknown), click-to-open, active highlight (active = `breadcrumb[0]`, so a Material stays highlighted while drilled into its MF), full-path tooltip, and the empty state hint ("No graphs yet. AI writes to graphs/<project>/<name>.matgraph.json").
- **Files tab — add (reference):** a search box, and Materials/Functions sub-tabs.
- **Files tab — add where data allows:** per-file status dots + node counts. `FileEntry` currently carries only `{path, type}`; counts/status are not available without loading each graph. Show them for graphs already loaded, and **degrade gracefully** (omit) otherwise — see Items to verify.
- **Nodes tab — preserve:** search (name + description), the **search-auto-expands-all** behavior, and the full node-DB detail on expand: description, **badges** (`verified` / `dynamic` / `deprecated`), Inputs/Outputs pin lists (`name : type`, required `*`), **Params** (`name : type = default`, required `*`, `when`), and the **Pin rule** (italic `pinInfo`) for dynamic-pin nodes. The "No matches" empty state is preserved.
- **Nodes tab — add (reference):** category filter chips and card restyling.
- Project grouping is already derived from folder paths server-side; no new grouping logic needed.

### E. Header + watch pill + Export

- **Move Export out of the ReactFlow `Panel` into the header.** Reuse existing logic unchanged: `graphToUET3D`, clipboard write, warnings, `EXPORT_META`. The single `導出到 UE` action exports the **currently open graph** (a Material, or an MF the user has drilled into) as UE T3D to the clipboard.
- **Keep the disabled `導入` (Import) button** as a "coming soon" placeholder beside Export (preserves the current affordance).
- **MF-root field → small popover on the Export button, auto-hinted when relevant.** Correct semantics (`ueT3D.ts` `mfPathToAssetRef`): MF root (`/Game/` default, localStorage key `ue-mf-root`) is the **UE content directory where MaterialFunction assets live**. It is used whenever the exported graph contains `MaterialFunctionCall` nodes — most commonly when exporting a **parent material that uses MFs** — to write each call node's asset ref as `<root>/<MFName>.<MFName>` so UE auto-links on paste. (It also drives the MF-export toast guidance.) Placement: a labelled popover beside Export; when the current graph contains `MaterialFunctionCall` nodes, surface a visual hint near Export prompting the user to set the directory so it isn't missed.
- **Watch pill** needs new wiring (currently no sync state exists): add `connection` (`'live' | 'reconnecting'`) and `lastUpdate` (timestamp) to the store, set from ws-client `onopen`/`onclose` and on each `graph`/`fileList` message. Display:
  - live → `● watching · synced Ns ago`
  - disconnected → `● reconnecting…`
  - **export mode** (`__UE_MAT_EXPORT__` present, no ws) → static `snapshot` label (no live claim).

### F. Inspector (new, read-only)

Right-side panel:
- **Node selected** → category eyebrow, title/subtitle, Inputs and Outputs pin lists (typed + colored via `pinColor()`), **parameters** (moved here from the node), and an "unknown node" callout when the type isn't in the DB. Code-like param values (multiline / long, e.g. Custom HLSL) render in a code block with a **Copy button** (preserving the current on-node `CodeBlock` behavior, including `stopPropagation` so copying doesn't disturb selection). Plain values render as `JSON.stringify`'d code.
- **Nothing selected** → material settings (Material Domain / Shading Model / Blend Mode / Two-Sided, shown only if present in the payload; degrade gracefully otherwise) + an export-readiness summary (mapped vs. unknown node count, MF links).

Selection state already exists implicitly via ReactFlow node clicks; wire selected-node id into the App so the Inspector can render it.

### G. Toast system (new)

Replace the inline toast in `Graph.tsx` with a reusable `ToastStack`:
- Variants: `loading` / `success` / `warning` / `error` / `info`; each with title, optional message, optional detail list, optional action buttons.
- Reused by: export result (success, or warning with skipped-node detail + a "View node" action that selects the offending node), and ws hot-reload (`info`: "graph updated on disk — reloaded").

### H. Theme specifics

Fixed defaults baked into `theme.css`: Graphite surfaces, violet accent (`#a06bff`), `7px` radius, `13px` base / `32px` row (regular density). No density/accent/tone controls shipped.

## Functionality parity checklist (no feature may regress)

Every item below exists today and must remain working after the reskin. The implementation plan and final verification check each one.

| Current feature | New home | Notes |
| --- | --- | --- |
| Breadcrumb trail (`▸`, click-to-pop, `niceName`) | Header breadcrumb | MF drill-down navigation |
| Graph-load errors (⛔) + warnings (⚠) for current graph | Canvas topbar summary + Inspector callout | Must cover **all** `state.errors` + `payload.warnings` |
| Files: project folders (default open) + Unorganized (collapsed) | Sidebar Files | Reskin |
| Files: type icons, click-to-open, active highlight (`breadcrumb[0]`), path tooltip | Sidebar Files | Reskin |
| Files: empty-state hint | Sidebar Files | Preserve text |
| Nodes: search (name+desc), search-auto-expand, "No matches" | Sidebar Nodes | Preserve behavior |
| Nodes: detail = desc + badges + In/Out + **Params** + **Pin rule** | Sidebar Nodes | Reference card lacks Params/Pin rule — keep them |
| Edge hover → highlight endpoint handles | Canvas | `setHandleHighlight` |
| Node params incl. **code Copy button** | Inspector (param block) | Moved off node; Copy preserved |
| MaterialFunctionCall **double-click → enter MF** + `ƒ` cue | Canvas node | Preserve |
| Node drag-reposition (non-persisted), dagre layout, CommentBox | Canvas | Reskin only |
| MiniMap + zoom controls; fitView | Canvas | MiniMap kept; fitView on load **and** graph switch |
| `導出到 UE` → clipboard T3D + warnings | Header Export + ToastStack | Logic unchanged |
| `導入` (disabled, coming soon) | Header | Preserve placeholder |
| MF root field (`/Game/`, localStorage) | Export popover (auto-hint when MFCall present) | Corrected semantics, §E |
| Export mode (`__UE_MAT_EXPORT__`, no ws) | Watch pill → `snapshot` | Preserve |

## Items to verify during planning (not blockers)

1. **Pin-type richness.** Many pins are inferred as `Float` (`Graph.tsx` `inferPinsFromConnections`). Type-coloring will be coarse until DB types fill in — acceptable; `pinColor()` maps unknown/`Float` to the scalar color.
2. **Material settings presence.** Confirm the real `GraphPayload` carries Domain/Shading/Blend/Two-Sided for the Inspector's no-selection view; if absent, show only what exists.
3. **Controls vs. custom toolbar.** Decide in the plan whether to restyle native `Controls` or build a small custom zoom toolbar — both keep MiniMap.
4. **File status dots + node counts.** `FileEntry` carries only `{path, type}`. Decide whether to compute counts/status from already-loaded graphs (and omit for unloaded) or extend the server's file list; degrade gracefully when unavailable.

## Success criteria (verifiable)

1. `pnpm dev` builds; the new shell renders all regions (header, sidebar, canvas+topbar, inspector, toasts).
2. Existing `vitest` suite passes unchanged (UI reskin must not touch server tests).
3. **Positioning:** loading the viewer and switching graphs always centers the viewport on the nodes (fitView on load + on graph change); MiniMap visible bottom-right.
4. `ue-mat-viewer export <name>` produces a single `.html` that renders the new UI and loads injected data; watch pill shows `snapshot` in export mode.
5. ws hot-reload still updates the graph (with an info toast); export/clipboard, MF-root popover, MF double-click + breadcrumb back-navigation all still work.
6. `package.json` has no new runtime dependencies.
7. **Parity:** every row of the Functionality parity checklist is verified working (no feature regressed).

## Execution order (token-first, component-by-component)

1. `theme.css` token layer + `pinColor`/`catColor` helpers; swap hardcoded colors. → verify: app renders unchanged-but-tokenized.
2. App shell regions (header / 3-pane body / toast slot). → verify: layout matches reference skeleton; graph still loads.
3. Header: brand + breadcrumb + Export (moved) + MF-root popover + watch pill (with store sync state). → verify: export + reconnect labels work.
4. Canvas reskin: custom node anatomy, type-colored edges, selection dimming, dotted grid, MiniMap + zoom controls, fitView-on-change. → verify: positioning criterion.
5. Sidebar reskin (Files tree + Nodes library visual pass). → verify: search/tabs/badges render.
6. Inspector (new) + ToastStack (new); route export + hot-reload through toasts. → verify: node-select detail + export toast flow.
7. Full pass: success criteria 1–6.

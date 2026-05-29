# UE Clipboard Export (T3D)

Date: 2026-05-29
Scope: viewer (web export module + toolbar) + agent-pack (export metadata sidecar, SPEC note) + Codex hand-off doc

## Problem

Materials can only be previewed in the web viewer. There is no way to get a graph
back into Unreal Engine to verify it for real. We want a one-click **"Export to UE"**
that copies the currently-open graph to the clipboard as Unreal's native
**T3D material-expression text**, so the user can `Ctrl+V` directly into UE's Material
Editor and see the whole node island — nodes, params, comments, connections, positions.

Import (T3D → our JSON) is explicitly **deferred**: a disabled button + empty stub only.

## Mechanism (decided)

Native T3D clipboard text, pasted into UE's Material Editor. No UE-side plugin.
This requires per-node UE metadata our authoring DB does not have. That metadata will
be populated by **Codex running on a UE 5.7 machine** as the final step; the exporter is
built first against a hand-authored subset and warns cleanly for nodes without metadata.

## Design

### 1. Export metadata sidecar — `agent-pack/nodes-ue5.7.export.json`

A new file, separate from `nodes-ue5.7.json` (keeps the authoring DB lean and isolates
Codex's large diff). Keyed by the **same node-type names** as the authoring DB.

```jsonc
{
  "schemaVersion": "1.0",
  "ueVersion": "5.7",
  "generatedAt": "<iso>",
  "source": "<who/how>",
  "nodes": {
    "Multiply": {
      "ueClass": "/Script/Engine.MaterialExpressionMultiply",
      "inputs":  { "A": { "property": "A" }, "B": { "property": "B" } },
      "outputs": { "Result": { "index": 0 } },
      "params":  {
        "ConstA": { "property": "ConstA", "kind": "float" },
        "ConstB": { "property": "ConstB", "kind": "float" }
      },
      "sample": "Begin Object Class=/Script/Engine.MaterialExpressionMultiply Name=\"…\"\nEnd Object\nBegin Object Name=\"…\"\n   ConstB=2.000000\n   MaterialExpressionEditorX=…\nEnd Object",
      "verified": false
    }
  },
  "reserved": {
    "MaterialFunctionCall": {
      "ueClass": "/Script/Engine.MaterialExpressionMaterialFunctionCall",
      "functionRefProperty": "MaterialFunction",
      "inputs": {}, "outputs": {}, "params": {}, "sample": "", "verified": false
    },
    "FunctionInput":  { "ueClass": "/Script/Engine.MaterialExpressionFunctionInput",  "params": { "InputName": { "property": "InputName", "kind": "name" }, "InputType": { "property": "InputType", "kind": "enum" } }, "outputs": { "Input": { "index": 0 } }, "inputs": {}, "sample": "", "verified": false },
    "FunctionOutput": { "ueClass": "/Script/Engine.MaterialExpressionFunctionOutput", "params": { "OutputName": { "property": "OutputName", "kind": "name" } }, "inputs": { "Input": { "property": "A" } }, "outputs": {}, "sample": "", "verified": false }
  }
}
```

Field meaning:
- `ueClass` — full UE class path used in `Begin Object Class=…`.
- `inputs[ourPinName].property` — the UE `FExpressionInput` UProperty name. **Our display pin
  name often differs from UE's property** (e.g. `UVs`→`Coordinates`, `Tex`→`TextureObject`).
- `outputs[ourPinName].index` — UE `OutputIndex` for that pin (multi-output nodes like
  `TextureSampleParameter2D` need RGB=0, R=1, …).
- `params[ourParamName]` — `{ property, kind, valueMap? }`. `kind` ∈
  `float | int | bool | name | enum | vector2 | vector3 | vector4 | texture | string`.
  For `enum`, an optional `valueMap` maps our value → the UE literal
  (e.g. `"Normal"` → `"SAMPLERTYPE_Normal"`).
- `sample` — the **raw T3D** UE produced when copying that single node. Reference / ground
  truth only — the emitter is driven by the structured map and does **not** parse `sample`.
  Used to finalize emitter framing and to verify the structured map.
- `verified` — `true` only after Codex confirms against real UE.
- `dynamicExport` (optional) — `true` on dynamic-pin nodes Codex could not map statically;
  such entries may omit full `inputs`/`outputs` maps and the emitter skips them with a warning.

`MaterialOutput` has **no** entry — it is never exported (the UE root result node belongs to
the `UMaterial`; final pins are wired manually after paste).

### 2. Metadata type contract — `viewer/web/src/export/export-meta.ts`

TypeScript interfaces for the sidecar (`ExportMeta`, `NodeExportMeta`, `ParamMeta`, etc.) plus
a loader that imports the JSON (bundled at build time, same approach the Node Library uses for
the authoring DB). Single source of truth for both the emitter and the Codex prompt's contract.

### 3. Emitter — `viewer/web/src/export/ueT3D.ts` (pure, unit-tested)

```ts
export interface UEExportOptions { mfContentRoot?: string; } // default "/Game/"
export interface UEExportResult { text: string; warnings: string[]; }
export function graphToUET3D(
  graph: MatGraph,                                  // the open Material or MaterialFunction
  layout: Record<string, { x: number; y: number }>,// node id → position (from dagre)
  meta: ExportMeta,
  opts?: UEExportOptions,
): UEExportResult;
```

Algorithm:
1. Assign each node a unique UE name `MaterialExpression<Type>_<n>`; keep `nodeId → ueName`.
2. **Skip** `MaterialOutput` (warn once: "MaterialOutput skipped — connect final pins manually").
   **Skip** any node whose type has no metadata entry or is a known dynamic-pin node
   (`LandscapeLayerBlend`, `SetMaterialAttributes`, `GetMaterialAttributes`) → warn
   "node type X not exportable yet (id …)". Connections touching a skipped node are dropped.
3. **Pass 1** — for every emitted node, write `Begin Object Class=<ueClass> Name="<ueName>"` / `End Object`.
4. **Pass 2** — for every emitted node, write `Begin Object Name="<ueName>"` … `End Object` containing:
   - Each param present in the node → `property=<value>` formatted by `kind`
     (float→`2.000000`, bool→`True/False`, name/string→`"v"`, enum→`valueMap[v] ?? v`,
     vectorN→struct from sample, texture→`None`).
   - `MaterialExpressionEditorX/Y` from `layout`.
   - For each **incoming** connection `from "src:srcPin" to "thisNode:dstPin"`:
     look up `dstPin`→UE input property and `srcPin`→`OutputIndex`, emit
     `DstProp=(Expression=<srcUeName>,OutputIndex=<idx>)`.
5. **Comments** → `MaterialExpressionComment`: `Text`, `CommentColor` (from our `color`),
   position = top-left of the layout bbox of `contains` nodes − padding, `SizeX/SizeY` =
   bbox size + padding. Comments with no resolvable contained nodes still emit at origin + warn.
6. **MaterialFunctionCall** → emit `MaterialFunction=MaterialFunction'"<path>"'` so the paste
   **auto-links** to the user's asset (no manual per-call assignment):
   - `params.MaterialFunction` is an engine path (`/…`) → pass through; built-in MFs paste resolved.
   - local `./<mfName>.matgraph.json` → emit `<mfContentRoot>/<mfName>.<mfName>`
     (e.g. `/Game/blend_normals.blend_normals`). Emit an **informational** warning listing each
     referenced MF and its expected path, so the user creates/saves the MF asset there first.
     UE resolves the reference by object path, so a match at that path auto-links on paste.
7. **FunctionInput / FunctionOutput** (only in MF graphs) → emit with `InputName`/`OutputName`
   and `InputType` enum; the `Input` pin of FunctionOutput maps to UE input property `A`.

The exact T3D framing (e.g. `ExportPath`, GUID property name) is finalized against Codex's
`sample` strings in the final phase; v1 targets a structure known to paste in UE 5.x and the
golden tests assert that structure (refined when samples land).

### 4. Toolbar UX

The graph view gains:
- **「導出到 UE」 / Export to UE** — builds T3D from the open graph + current layout, calls
  `navigator.clipboard.writeText(text)`, shows a toast and lists any `warnings`.
  - When the open graph is an **MF**, the toast states the asset name/path to save it under so
    the parent's reference matches: *"Create a Material Function `<name>` at `<mfContentRoot>` and
    paste here."*
  - When the open graph is a **Material**, the toast is `Copied N nodes — paste into UE Material
    Editor`, plus the per-MF info warnings (expected asset paths for auto-link).
- **MF content root** — a small text input (default `/Game/`, persisted in localStorage). Both MF
  and parent exports use it, so the emitted `MaterialFunction` path always matches where the user
  saved the MF → paste auto-links.
- **「導入」 / Import** — **disabled**, tooltip "coming soon". `parseUET3D(text): MatGraph` exists
  as an empty stub (throws "not implemented") so the wiring/signature is in place.

### 5. Position synthesis

Reuse the **existing dagre layout** the viewer already computes for rendering — "what you see is
what you paste". No `x`/`y` is ever written to the `.matgraph.json`.

### 6. Scope rules

- Exports the **currently-open graph only**. MFs are **not inlined** — a `MaterialFunctionCall`
  stays a single reference node (matching the "paste the MF separately" workflow).
- **Local MF auto-link convention**: the user creates each MF in UE under `<mfContentRoot>` with
  the same base name as the JSON, and pastes the exported MF island into it. The parent material's
  `MaterialFunctionCall` emits the same path, so on paste UE auto-recognizes the function — no
  manual assignment. Order is up to the user; the reference resolves whenever the asset exists.
- Built-in UE MF support = engine-path pass-through. The viewer cannot preview a built-in MF's
  pins (no JSON to read) — known, acceptable.

### 7. Validation & tests (vitest)

- **Sidecar integrity**: every key in `export.nodes` exists in `nodes-ue5.7.json` (no orphans);
  the hand-authored subset is present; entries match the `ExportMeta` type.
- **Coverage report**: count of authoring nodes with export metadata (informational; does **not**
  fail while Codex backfill is pending).
- **Emitter golden tests**: small graphs (e.g. Constant3Vector → Multiply with a connection + a
  comment; a tiny MF with FunctionInput/Output) → assert two-pass structure, connection
  `OutputIndex`, positions, comment box, and the warning set (MaterialOutput skip, local MFCall).

### 8. Codex hand-off — `docs/superpowers/specs/2026-05-29-ue-clipboard-export-codex-prompt.md`

The implementer also writes the **exact prompt** the user gives Codex on the UE machine:
- Read `agent-pack/nodes-ue5.7.json` for our pin/param names.
- For each node type: create the expression in a UE 5.7 Material (reserved types in a Material
  Function), copy it, paste the raw T3D into `sample`, fill `ueClass`, `inputs` (our pin → UE
  property), `outputs` (our pin → OutputIndex), `params` (our param → property + `kind` +
  `valueMap` for enums), set `verified: true`.
- Keep `export.nodes` keys aligned with `nodes-ue5.7.json`; flag dynamic-pin nodes as
  `"dynamicExport": true` with notes rather than guessing.
- Output the updated `agent-pack/nodes-ue5.7.export.json`.

### 9. Spec/convention impact — `agent-pack/SPEC.md`

Add a short note: `MaterialFunctionCall.params.MaterialFunction` may be either a local
`./<name>.matgraph.json` path (our MF) **or** a UE engine path (`/Engine/Functions/…`) for a
built-in MF; the latter is preview-limited but exports/pastes correctly. Document the export
auto-link convention: create each local MF in UE under the configured MF content root (default
`/Game/`) with the JSON's base name, so a pasted parent material auto-links its function calls.
Reiterate that x/y are never written (export synthesizes positions).

## Out of scope

- Import logic (T3D → JSON) — stub only.
- Verifying / populating all 142 nodes — Codex's job, run last by the user.
- Dynamic-pin node export (LandscapeLayerBlend, Set/GetMaterialAttributes).
- Previewing built-in UE MF pins in the viewer.
- A CLI export path (the emitter is pure, so it can be reused later without rework).

## Files touched

- New: `agent-pack/nodes-ue5.7.export.json`, `viewer/web/src/export/export-meta.ts`,
  `viewer/web/src/export/ueT3D.ts`, the Codex prompt doc, and tests under `viewer/tests/`.
- Modified: the toolbar component (add buttons), `agent-pack/SPEC.md` (MF/x-y note).
- Unchanged: `.matgraph.json` schema, server, resolver.

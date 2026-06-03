# Example Material Graphs

This folder is a catalog of working `.matgraph.json` examples — the JSON node-graph
format this repo uses to author UE material graphs, render them in the local viewer,
and round-trip them to/from UE 5.7 via the T3D clipboard bridge.

A `.matgraph.json` file describes one **Material** or **MaterialFunction**:

```jsonc
{
  "schemaVersion": "1.0",
  "ueVersion": "5.7",
  "type": "Material",            // or "MaterialFunction"
  "name": "<filename without extension>",
  "description": "one-liner",
  "nodes":       [ { "id": "<unique>", "type": "<NodeType>", "params": { /* optional */ } } ],
  "connections": [ { "from": "<nodeId>:<pinName>", "to": "<nodeId>:<pinName>" } ],
  "comments":    [ { "id": "<unique>", "text": "...", "color": "#hex", "contains": ["<nodeId>", ...] } ]
}
```

Key rules (full details in [`../SPEC.md`](../SPEC.md)):

- Node `type` must exist in the version-matched node DB (`../nodes-ue5.7.json`) or be a
  reserved type (`MaterialOutput`, `FunctionInput`, `FunctionOutput`, `MaterialFunctionCall`).
  Pin names must match the DB exactly.
- Connections are `"node:pin"` strings (colon, never dash); never write `x`/`y` positions
  (layout is automatic).
- Each `Material` has exactly one `MaterialOutput` (id `OUT`); you wire results into its
  attribute pins (`BaseColor`, `Roughness`, …). On UE export those are funneled through a
  single synthesized `MakeMaterialAttributes` node — the enforced **Use Material Attributes**
  output convention (see SPEC.md).
- A project folder = one Material plus the MaterialFunctions it calls, as siblings.
  MaterialFunctions are **copied** into each project rather than shared, so a `MaterialFunctionCall`
  resolves its sibling via `"./<mf_name>.matgraph.json"`.

All examples below load cleanly through the server graph loader and (for Materials) export
to UE T3D with no dropped/unmapped warnings — only the expected "Use Material Attributes"
auto-collect note and, where a local MF is called, the auto-link reminder.

## Catalog (beginner → advanced)

### 1. `01_basic_pbr/` — `01_basic_pbr.matgraph.json`
- **Type:** Material · **Nodes:** 5
- The minimum PBR material: a texture sample tinted by a `Constant3Vector` via `Multiply`
  into BaseColor, plus a `ScalarParameter` for Roughness. Teaches parameters, a simple math
  node, wiring into the `MaterialOutput` pins, and grouping nodes with a `comment`.

### 2. `02_with_function/` — `02_with_function.matgraph.json` (+ `blend_normals.matgraph.json`)
- **Type:** Material (4 nodes) + MaterialFunction (4 nodes)
- The smallest MaterialFunction example: two normal-map samples are fed into a
  `MaterialFunctionCall` that references the sibling `blend_normals` MF, whose result drives
  the material Normal. Teaches `FunctionInput`/`FunctionOutput`, the `MaterialFunctionCall`
  sibling-path convention, and how MF input/output names become call pins.

### 3. `03_flashing_emissive/` — `03_flashing_emissive.matgraph.json`
- **Type:** Material · **Nodes:** 14
- A metallic material with a time-driven pulsing emissive. Teaches animated logic with
  `Time` → `Multiply` → `Sine`, remapping a -1..1 wave into 0..1 (`Multiply` + `Add` using
  `ConstB`), `VectorParameter`/`ScalarParameter` for color and intensity, and multi-attribute
  output (BaseColor, Metallic, Roughness, EmissiveColor) organized into three comment groups.

### 4. `04_snow/` — `04_snow.matgraph.json` (+ `blend_normals.matgraph.json`)
- **Type:** Material (17 nodes) + MaterialFunction (4 nodes)
- A fuller PBR snow material: dirt blending via a `Lerp` driven by a mask, dry-vs-wet
  `Roughness` blending, dual-normal sparkle mapping reusing the `blend_normals` MF, plus
  Specular/Metallic/SubsurfaceColor. Teaches mask-driven `Lerp` blends, reusing a
  MaterialFunction, and organizing a larger graph with comment groups.

### 5. `raymarch_cloud_six_way/` — `raymarch_cloud_six_way_fix.matgraph.json`
- **Type:** Material · **Nodes:** 37
- The most advanced example: a six-way cloud lighting decode. A world-space light vector is
  offset, normalized, and `Transform`-ed into tangent space, then `ComponentMask` + `Max`
  produce signed per-axis weights that select UDLR/FBTD texture channels, summed and tinted
  into EmissiveColor. Teaches coordinate-space transforms, channel masking, signed-weight
  decomposition (`max(axis,0)` / `max(-axis,0)`), and documenting intent with rich comments.

## Note on the duplicated `blend_normals.matgraph.json`

`blend_normals.matgraph.json` appears in both `02_with_function/` and `04_snow/` and the two
files are byte-identical. This is **intentional**, not drift: per SPEC.md, each project folder
is self-contained and MaterialFunctions are copied into every project that uses them rather
than shared. Each material's `MaterialFunctionCall` resolves its own sibling copy via
`"./blend_normals.matgraph.json"`, so the copies must stay independent — do not dedup them.

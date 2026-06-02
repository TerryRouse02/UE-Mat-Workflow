# UE Material Workflow — AI Spec

You are producing UE Material node graphs as JSON. A local viewer renders your output.

> **HARD RULE — confirm the UE version before you author anything.**
> Before authoring or editing ANY material graph, you MUST ask the user which UE
> version they are targeting, and confirm that version is supported (a
> `nodes-ue<version>.json` DB pair exists in `agent-pack/`). **Do not write any
> `.matgraph.json` until the UE version is confirmed and supported.** Set the
> graph's `ueVersion` to that confirmed version, then author against the DB pair
> that matches it. If the user names an unsupported version, stop and say so — the
> viewer flags it with a banner and blocks reliable export.

## Multi-version node DB

The node DB ships as **version pairs** in `agent-pack/`:

- `nodes-ue<major.minor>.json` — the authoring DB (the node vocabulary you read).
- `nodes-ue<major.minor>.export.json` — per-node UE metadata for "Export to UE".

Example today: `nodes-ue5.7.json` + `nodes-ue5.7.export.json` (later, `nodes-ue5.8.*`, etc.).

The viewer auto-discovers every present version at build time and selects the DB
pair matching each graph's `ueVersion`. An unsupported `ueVersion` shows a clear
banner in the viewer and blocks reliable export. **Adding a version is purely a
data drop:** generate both files via the UE commandlet (`tools/node-t3d-metadata`)
and place them in `agent-pack/` — no code change needed.

Throughout this spec, `nodes-ue5.7.json` is used as the concrete example; read the
pair matching the confirmed `ueVersion` instead.

## Where to write

**One project = one folder under `graphs/`.** Each project folder contains exactly one Material and any MaterialFunctions that material references.

- `Material` file → `graphs/<project>/<material_name>.matgraph.json`
- `MaterialFunction` file → `graphs/<project>/<mf_name>.matgraph.json` (same folder as the Material that uses it)

By convention, the folder name matches the material name. If the user already named a project, use that.

Do **not** share MaterialFunctions across projects — copy them into each project that needs them. The viewer only recognizes a folder as a "project" if it contains exactly one Material; otherwise its contents appear under "Unorganized".

## File format

```jsonc
{
  "schemaVersion": "1.0",
  "ueVersion": "5.7",
  "type": "Material",                    // or "MaterialFunction"
  "name": "<filename without extension>",
  "description": "optional one-liner",

  "nodes": [
    { "id": "<unique>", "type": "<NodeType>", "params": { /* optional */ } }
  ],

  "connections": [
    { "from": "<nodeId>:<pinName>", "to": "<nodeId>:<pinName>" }
  ],

  "comments": [                           // optional
    { "id": "<unique>", "text": "...", "color": "#hex", "contains": ["<nodeId>", ...] }
  ]
}
```

## Hard rules

1. **Confirm the UE version before authoring** (see the hard rule at the top). Ask
   which UE version the user targets, confirm a `nodes-ue<version>.json` DB pair
   exists in `agent-pack/`, and set `ueVersion` to that confirmed version. Author
   against the DB pair that matches. Never write a `.matgraph.json` for an
   unconfirmed or unsupported version.

2. **Node type must exist in the version-matched `nodes-ue<version>.json` OR be one of these reserved types:**
   `MaterialOutput`, `FunctionInput`, `FunctionOutput`, `MaterialFunctionCall`.
   Unknown types → viewer red-flags. Do not invent types.

3. **Pin names must match the DB exactly.** Look up `inputs[].name` and `outputs[].name` for the node type before writing a connection.

4. **Do not write `x`/`y` positions.** Layout is automatic (dagre).

5. **Use `"node:pin"` strings, never objects.**

6. **Every `Material` should have exactly one `MaterialOutput` node** (id by convention `OUT`).

7. **Every `MaterialFunction` must have at least one `FunctionInput` and one `FunctionOutput`.**

8. **`MaterialFunctionCall.params.MaterialFunction`** is a path relative to the **current file's directory** (not the `graphs/` root).
   - With the project-folder convention, the Material and its MFs are siblings in the same folder, so the path is just `"./<mf_name>.matgraph.json"`.
   - Example: from `graphs/obsidian/obsidian.matgraph.json` → `"./fresnel_lib.matgraph.json"` resolves to `graphs/obsidian/fresnel_lib.matgraph.json`.
   - MFs that call sibling MFs use the same `"./<name>.matgraph.json"` form.
   - For **UE clipboard export**, this path may also be a UE engine asset path
     (e.g. `/Engine/Functions/...`) to reference a built-in Material Function; such references
     paste resolved but cannot be previewed in the viewer. For local MFs, export uses an
     auto-link convention: create the MF in UE under the configured MF content root (default
     `/Game/`) with the JSON's base name, and a pasted parent material auto-links its calls.
     The emitted T3D token is `MaterialFunction=MaterialFunction'"<assetPath>"'` — the inner
     double-quotes are required and the outer single-quotes are UE's object-reference syntax;
     UE resolves the call by that object path on paste.
     Positions (`x`/`y`) remain forbidden in the JSON — export synthesizes them from layout.

## Material output → clipboard export

You author the material exactly as before: wire your final results into the
`MaterialOutput` node's attribute pins (`BaseColor`, `Roughness`, …). Authoring
does not change.

On **UE clipboard export** the root `MaterialOutput` node cannot be copied, so
the emitter automatically synthesizes one `MakeMaterialAttributes` node and
reroutes every wire you drew into `MaterialOutput` into that node's matching
input. After pasting into UE you make a **single** connection — the synthesized
node's `MaterialAttributes` output to the material's root node — and enable
**Use Material Attributes** on the material. This replaces what used to be one
manual reconnection per attribute.

Only one wire per attribute pin is kept: if two sources are wired into the same
`MaterialOutput` pin, export keeps the first and warns (UE allows one connection
per input).

## Work-project Material Functions (your own project MFs)

A `MaterialFunctionCall` can reference a Material Function three ways:

1. **A sibling `.matgraph.json`** (e.g. `"./blend_normals.matgraph.json"`) — authored in this repo; the viewer resolves and previews it. (See hard rule 8.)
2. **An engine built-in** (e.g. `/Engine/Functions/.../BlendAngleCorrectedNormals.BlendAngleCorrectedNormals`) — pastes resolved in UE; not previewable here.
3. **One of your own project's Material Functions, by UE asset path** (e.g. `/Game/Functions/MF_Foo.MF_Foo`) — a `.uasset` in your UE project that this repo cannot read directly.

For case 3, the function's pin signature lives in **`agent-pack/workmf-index.json`** — a local, gitignored index your UE machine generates with the WorkMF crawl (`tools/node-t3d-metadata`, mode `WorkMF`). When you author or optimize a material that calls one of your own project MFs:

- **Look it up** in `agent-pack/workmf-index.json` under `functions["<assetPath>"]`. Use its `inputs[].name` / `outputs[].name` for connections, exactly as you would the pin names of a built-in node.
- Set `params.MaterialFunction` to the **UE asset path** (`/Game/...`), not a `.matgraph.json` path.
- **If the MF is not in the index, stop and ask the user to run the WorkMF crawl** — do not invent pin names. (`/Engine/...` built-ins are the one exception: not indexed, not previewable, but still export.)

Only the user's own project MFs are indexed; official/engine MFs are not. The index is never committed and never bundled into the web build.

## Soft rules (best practice)

- Group related nodes with `comments` for clarity.
- Prefer breaking complex logic into `MaterialFunction` (UE best practice).
- Set `ConstA`/`ConstB` only when the corresponding pin is unconnected.
- Don't include `params` you don't have a value for; viewer will use DB defaults.

## How to use the node DB

`nodes-ue5.7.json` structure:

```jsonc
{
  "nodes": {
    "Multiply": {
      "inputs":  [{ "name": "A", "type": "..." }, { "name": "B", "type": "..." }],
      "outputs": [{ "name": "Result", "type": "..." }],
      "params":  [{ "name": "ConstA", "when": "A unconnected" }, ...]
    }
  }
}
```

**You MUST read:** `inputs[*].name`, `outputs[*].name` (otherwise you can't write connections correctly).
**You MAY read:** `params[*]` (only if you want to set constant values).
**You may ignore:** `category`, `description`, `verified`.

## Reserved node types (built-in, not in DB)

| Type | Pins | Notes |
|---|---|---|
| `MaterialOutput` | inputs: `BaseColor`, `Metallic`, `Specular`, `Roughness`, `EmissiveColor`, `Opacity`, `OpacityMask`, `Normal`, `WorldPositionOffset`, `Refraction`, `AmbientOcclusion`, `PixelDepthOffset`, `SubsurfaceColor`, `ClearCoat`, `ClearCoatRoughness` | Exactly one per Material |
| `FunctionInput` | output: `Input` | Inside MaterialFunction only. `params.InputName` becomes the pin name on the MaterialFunctionCall. |
| `FunctionOutput` | input: `Input` | Inside MaterialFunction only. `params.OutputName` becomes the pin name on the MaterialFunctionCall. |
| `MaterialFunctionCall` | derived from referenced MF's `FunctionInput`/`FunctionOutput` | Set `params.MaterialFunction` path. |

## Dynamic-pin nodes

Some node types have `"dynamicPins": true` in the DB. Their actual input/output pin names are **not** listed statically — they depend on params or user wiring. The DB entry also contains a `"pinInfo"` string that gives the derivation rule.

Current dynamic-pin nodes in `nodes-ue5.7.json`:

| Node | Rule summary |
|---|---|
| `LandscapeLayerBlend` | For each entry in `params.Layers`, two inputs: `"Layer <name>"` and `"Height <name>"`. Output is `"Result"`. |
| `SetMaterialAttributes` | Fixed input `"MaterialAttributes"` plus one input per entry in `params.AttributeNames` (e.g., `"BaseColor"`, `"Roughness"`). Output is `"MaterialAttributes"`. |
| `GetMaterialAttributes` | Fixed input `"MaterialAttributes"`. One output per entry in `params.AttributeNames`. |

**When you encounter a node with `dynamicPins: true`:**

1. Read `pinInfo` — it gives the exact rule for deriving pin names (case, spaces, and punctuation matter).
2. Set the relevant `params` field so the rule has data to work from.
3. Write connections using the derived pin names. The viewer infers the pin set from your connections and renders them; it does **not** validate names against UE's real runtime rules — that is your responsibility.
4. If you are unsure about the rule, **ask before writing** — guessing pin names for dynamic nodes produces a graph that renders but is wrong against real UE.

Example: `LandscapeLayerBlend` with two layers "Dirt" and "Grass":

```jsonc
// node declaration
{ "id": "blend", "type": "LandscapeLayerBlend",
  "params": { "Layers": [{ "Name": "Dirt" }, { "Name": "Grass" }] } }

// connections — pin names derived from layer names
{ "from": "dirt_tex:RGB",   "to": "blend:Layer Dirt" }
{ "from": "grass_tex:RGB",  "to": "blend:Layer Grass" }
{ "from": "blend:Result",   "to": "OUT:BaseColor" }
```

Example: `GetMaterialAttributes` extracting BaseColor and Roughness:

```jsonc
{ "id": "getAttrs", "type": "GetMaterialAttributes",
  "params": { "AttributeNames": ["BaseColor", "Roughness"] } }

{ "from": "matBlend:Result",      "to": "getAttrs:MaterialAttributes" }
{ "from": "getAttrs:BaseColor",   "to": "OUT:BaseColor" }
{ "from": "getAttrs:Roughness",   "to": "OUT:Roughness" }
```

**Set/Get attribute export coverage.** On T3D export, each Set/Get attribute is keyed by an
`FMaterialAttributeDefinitionMap` FGuid (the value UE writes into `AttributeSetTypes`/
`AttributeGetTypes`), never guessed. The full name→GUID map is generated by the UE commandlet
into `nodes-ue5.7.export.json` (`materialAttributes`, 38 attributes); the exporter matches your `AttributeNames` against it
space-insensitively. Regenerate it by re-running `tools/node-t3d-metadata/Invoke-NodeT3DMetadataMaintenance.ps1`
on the UE host. When that section is absent, the exporter falls back to the fixture-captured set in
`viewer/web/src/material-attribute-guids.ts` (**`BaseColor`, `Roughness`, `Metallic`**). An
`AttributeNames` entry with no GUID in the effective map still renders in the viewer but is
**dropped from the export with a warning** (not invented) — currently that means **`ClearCoat`** and
**`ClearCoatRoughness`**, which UE registers under the internal names `CustomData0`/`CustomData1`
(for clear coat use `MakeMaterialAttributes`, whose `ClearCoat`/`ClearCoatRoughness` pins export
normally). Every other attribute resolves by name.

## Examples

See `agent-pack/examples/01_basic_pbr/01_basic_pbr.matgraph.json` and `02_with_function/02_with_function.matgraph.json` for full working files. Each example is a compliant project folder (`<name>/<name>.matgraph.json` plus any MFs copied alongside it) — the same one-folder-per-project convention the spec requires.

## Failure modes you must avoid

- Inventing node names (e.g., "MultiplyVector3" — the real node is just `Multiply`)
- Writing connections with `node-pin` (dash) instead of `node:pin` (colon)
- Writing position fields like `x`, `y`, `position`
- Reusing the same `id` for two nodes
- Referencing a `MaterialFunction` file before writing it (you can write both in any order, viewer waits with 300ms debounce — but both must exist eventually)

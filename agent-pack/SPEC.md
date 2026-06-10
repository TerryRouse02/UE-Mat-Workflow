# UE Material Workflow — AI Spec

You are producing UE Material node graphs as JSON. A local viewer renders your output.

> **HARD RULE — confirm the UE version before you author anything.**
> Before authoring or editing ANY material graph, you MUST ask the user which UE
> version they are targeting, and confirm that version is supported (a
> `nodes-ue<version>.index.json` exists in `agent-pack/`). **Do not write any
> `.matgraph.json` until the UE version is confirmed and supported.** Set the
> graph's `ueVersion` to that confirmed version, then author against the DB that
> matches it. If the user names an unsupported version, stop and say so — the
> viewer flags it with a banner and blocks reliable export.

## Multi-version node DB

The node DB ships as **version pairs** in `agent-pack/`:

- `nodes-ue<major.minor>.json` — the authoring DB (full node vocabulary with pin details).
- `nodes-ue<major.minor>.export.json` — per-node UE metadata for "Export to UE" (**viewer-only**; an authoring agent never reads this file).
- `nodes-ue<major.minor>.index.json` — generated minimal index (~12K tokens); safe to read whole.

Example today: `nodes-ue5.7.json` + `nodes-ue5.7.export.json` + `nodes-ue5.7.index.json`.

The viewer auto-discovers every present version at build time and selects the DB pair matching each graph's `ueVersion`. An unsupported `ueVersion` shows a clear banner in the viewer and blocks reliable export. **Adding a version is purely a data drop:** generate the files via the UE commandlet (`tools/node-t3d-metadata`) and place them in `agent-pack/` — no code change needed.

## How to read the node DB (token discipline)

**NEVER read `nodes-ue*.json`, `nodes-ue*.export.json`, or `enginemf-index-ue*.json` wholesale.** These files are 45K–120K tokens each. `nodes-ue*.export.json` is consumed by the viewer's export/import code only. MF indexes are point-query only.

Use this three-step protocol instead:

1. **Choose nodes** — read `agent-pack/nodes-ue<version>.index.json` (~12K tokens). It lists every node with category, one-line description, and flags (`verified`, `dynamicPins`, `deprecated`).
2. **Fetch full entries** — for each node you will actually use:
   `node agent-pack/query.js node <version> <Name> [<Name> ...]`
   Prints the full DB entry (inputs, outputs, params, pinInfo) for those nodes only.
3. **Look up Material Functions** — for `/Engine/...` or `/Game/...` MF asset paths:
   `node agent-pack/query.js mf "<assetPath>"`
   Returns the MF's pin signature from the matching index.

You can also search: `node agent-pack/query.js search <version> <keyword>` prints one-line matches.

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
   which UE version the user targets, confirm a `nodes-ue<version>.index.json` exists
   in `agent-pack/`, and set `ueVersion` to that confirmed version. Author against the
   DB that matches. Never write a `.matgraph.json` for an unconfirmed or unsupported version.

2. **Node type must exist in the version-matched `nodes-ue<version>.json` OR be one of these reserved types:**
   `MaterialOutput`, `FunctionInput`, `FunctionOutput`, `MaterialFunctionCall`.
   Unknown types → viewer red-flags. Do not invent types.

3. **Pin names must match the DB exactly.** Look up `inputs[].name` and `outputs[].name` for the node type (via `query.js node`) before writing a connection.

4. **Do not write `x`/`y` positions.** Layout is automatic (dagre).

5. **Use `"node:pin"` strings, never objects.**

6. **Every `Material` should have exactly one `MaterialOutput` node** (id by convention `OUT`).

7. **Every `MaterialFunction` must have at least one `FunctionInput` and one `FunctionOutput`.**

8. **`MaterialFunctionCall.params.MaterialFunction`** is a path relative to the **current file's directory** (not the `graphs/` root). With the project-folder convention, the Material and its MFs are siblings, so the path is just `"./<mf_name>.matgraph.json"`. For **UE clipboard export**, this may also be a UE engine asset path (e.g. `/Engine/Functions/...`) to reference a built-in Material Function. See SPEC-DETAILS.md → "Rule 8 — T3D export details" for the full T3D token format, auto-link convention, and MF content-root details.

## Material output → clipboard export (summary)

Author normally: wire your final results into the `MaterialOutput` node's attribute pins (`BaseColor`, `Roughness`, etc.). On **UE clipboard export** the emitter automatically synthesizes one `MakeMaterialAttributes` node and reroutes every wire into its matching input. After pasting into UE you make a **single** connection and enable **Use Material Attributes** on the material. A graph that already feeds the root via a single `MaterialAttributes` value is exported as-is. Only one wire per attribute pin is kept (first wins).

> Read SPEC-DETAILS.md → "Material output → clipboard export" for the full round-trip spec, including reverse import (UE T3D → matgraph) and Set/Get attribute export coverage.

## Work-project Material Functions

A `MaterialFunctionCall` can reference a Material Function three ways:

1. **A sibling `.matgraph.json`** (e.g. `"./blend_normals.matgraph.json"`) — authored in this repo; the viewer resolves and previews it.
2. **An engine built-in** (e.g. `/Engine/Functions/.../BlendAngleCorrectedNormals.BlendAngleCorrectedNormals`) — a shipped `.uasset`. Look up with `node agent-pack/query.js mf "<assetPath>"`.
3. **One of your own project's MFs, by UE asset path** (e.g. `/Game/Functions/MF_Foo.MF_Foo`) — a `.uasset` in your UE project. Look up with `node agent-pack/query.js mf "<assetPath>"`.

For cases 2 and 3, use the query result's `inputs[].name` / `outputs[].name` for connections exactly as you would built-in pin names. Set `params.MaterialFunction` to the **UE asset path**.

**If the MF is not in the index, stop and ask the user to run the matching crawl** (Engine MF for `/Engine/...`, WorkMF for `/Game/...`) — do not invent pin names.

## Soft rules (best practice)

- Group related nodes with `comments` for clarity.
- Prefer breaking complex logic into `MaterialFunction` (UE best practice).
- Set `ConstA`/`ConstB` only when the corresponding pin is unconnected.
- Don't include `params` you don't have a value for; viewer will use DB defaults.

## Reserved node types (built-in, not in DB)

| Type | Pins | Notes |
|---|---|---|
| `MaterialOutput` | inputs: `BaseColor` `Metallic` `Specular` `Roughness` `EmissiveColor` `Opacity` `OpacityMask` `Normal` `WorldPositionOffset` `Refraction` `AmbientOcclusion` `PixelDepthOffset` `SubsurfaceColor` `ClearCoat` `ClearCoatRoughness` | Exactly one per Material |
| `FunctionInput` | output: `Input` | Inside MaterialFunction only. `params.InputName` becomes the pin name on the MaterialFunctionCall. |
| `FunctionOutput` | input: `Input` | Inside MaterialFunction only. `params.OutputName` becomes the pin name on the MaterialFunctionCall. |
| `MaterialFunctionCall` | derived from referenced MF's `FunctionInput`/`FunctionOutput` | Set `params.MaterialFunction` path. |

## Dynamic-pin nodes

Some node types have `"dynamicPins": true` in the DB. Their actual input/output pin names are **not** listed statically — they depend on params or user wiring. The DB entry contains a `"pinInfo"` string that gives the derivation rule.

Current dynamic-pin nodes in `nodes-ue5.7.json`:

| Node | Rule summary |
|---|---|
| `LandscapeLayerBlend` | One `"Layer <name>"` input per entry in `params.Layers`, plus a `"Height <name>"` input for layers whose `BlendType` is `LB_HeightBlend`. Output is `"Result"`. |
| `SetMaterialAttributes` | Fixed input `"MaterialAttributes"` plus one input per entry in `params.AttributeNames`. Output is `"MaterialAttributes"`. |
| `GetMaterialAttributes` | Fixed input `"MaterialAttributes"`. One output per entry in `params.AttributeNames`. |

**When you encounter a node with `dynamicPins: true`:**

1. Read `pinInfo` (via `query.js node`) — it gives the exact rule for deriving pin names (case, spaces, and punctuation matter).
2. Set the relevant `params` field so the rule has data to work from.
3. Write connections using the derived pin names. The viewer infers the pin set from your connections and renders them; it does **not** validate names against UE's real runtime rules — that is your responsibility.
4. If you are unsure about the rule, **ask before writing** — guessing pin names for dynamic nodes produces a graph that renders but is wrong against real UE.

Example: `LandscapeLayerBlend` with two layers "Dirt" and "Grass":

```jsonc
{ "id": "blend", "type": "LandscapeLayerBlend",
  "params": { "Layers": [
    { "Name": "Dirt",  "BlendType": "LB_HeightBlend", "PreviewWeight": 0.35 },
    { "Name": "Grass", "BlendType": "LB_HeightBlend", "PreviewWeight": 0.65 }
  ] } }

{ "from": "dirt_tex:RGB",   "to": "blend:Layer Dirt" }
{ "from": "grass_tex:RGB",  "to": "blend:Layer Grass" }
{ "from": "blend:Result",   "to": "OUT:BaseColor" }
```

> Read SPEC-DETAILS.md → "Dynamic-pin nodes — full detail" for per-layer FLayerBlendInput field documentation and the GetMaterialAttributes example.

## Examples

Default: read only `agent-pack/examples/01_basic_pbr/01_basic_pbr.matgraph.json` (978 bytes) — covers the common PBR case. Each example is a compliant project folder (`<name>/<name>.matgraph.json` plus any MFs alongside it).

- Add `agent-pack/examples/02_with_function/02_with_function.matgraph.json` (1.8 KB) when the material calls a MaterialFunction.
- Add `agent-pack/examples/03_flashing_emissive/`, `04_snow/`, `raymarch_cloud_six_way/` only when authoring that kind of material (animated emissive, landscape snow blend, volumetric raymarching respectively).

## Failure modes you must avoid

- Inventing node names (e.g., "MultiplyVector3" — the real node is just `Multiply`)
- Writing connections with `node-pin` (dash) instead of `node:pin` (colon)
- Writing position fields like `x`, `y`, `position`
- Reusing the same `id` for two nodes
- Referencing a `MaterialFunction` file before writing it (you can write both in any order, viewer waits with 300ms debounce — but both must exist eventually)
- Reading `nodes-ue*.json` / `*.export.json` / `enginemf-index-ue*.json` wholesale — use the index + `query.js` protocol above

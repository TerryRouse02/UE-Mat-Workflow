# UE Material Workflow — AI Spec

You are producing UE 5.7 Material node graphs as JSON. A local viewer renders your output.

## Where to write

- `Material` files → `graphs/<name>.matgraph.json`
- `MaterialFunction` files → `graphs/functions/<name>.matgraph.json`

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

1. **Node type must exist in `nodes-ue5.7.json` OR be one of these reserved types:**
   `MaterialOutput`, `FunctionInput`, `FunctionOutput`, `MaterialFunctionCall`.
   Unknown types → viewer red-flags. Do not invent types.

2. **Pin names must match the DB exactly.** Look up `inputs[].name` and `outputs[].name` for the node type before writing a connection.

3. **Do not write `x`/`y` positions.** Layout is automatic (dagre).

4. **Use `"node:pin"` strings, never objects.**

5. **Every `Material` should have exactly one `MaterialOutput` node** (id by convention `OUT`).

6. **Every `MaterialFunction` must have at least one `FunctionInput` and one `FunctionOutput`.**

7. **`MaterialFunctionCall.params.MaterialFunction`** is a path relative to the **current file's directory** (not always `graphs/` root).
   - From a `Material` at `graphs/foo.matgraph.json` → `"./functions/blend_normals.matgraph.json"` resolves to `graphs/functions/blend_normals.matgraph.json`.
   - From a `MaterialFunction` at `graphs/functions/a.matgraph.json` → `"./b.matgraph.json"` resolves to `graphs/functions/b.matgraph.json` (sibling file).
   - Most projects keep all MFs in `graphs/functions/`, so MFs that call sibling MFs use `"./<name>.matgraph.json"`.

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

## Examples

See `agent-pack/examples/01_basic_pbr.matgraph.json` and `02_with_function.matgraph.json` for full working files.

## Failure modes you must avoid

- Inventing node names (e.g., "MultiplyVector3" — the real node is just `Multiply`)
- Writing connections with `node-pin` (dash) instead of `node:pin` (colon)
- Writing position fields like `x`, `y`, `position`
- Reusing the same `id` for two nodes
- Referencing a `MaterialFunction` file before writing it (you can write both in any order, viewer waits with 300ms debounce — but both must exist eventually)

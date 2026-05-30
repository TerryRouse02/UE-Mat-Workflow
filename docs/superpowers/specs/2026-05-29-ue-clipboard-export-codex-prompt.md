# Codex Task: Populate UE Export Metadata

Run this on a machine with Unreal Engine 5.7. Goal: fill
`agent-pack/nodes-ue5.7.export.json` with verified UE metadata for every node type
in `agent-pack/nodes-ue5.7.json`, so the viewer's "Export to UE" produces T3D that
pastes correctly into the Material Editor.

> **Automated alternative (preferred):** the repo now ships `tools/node-t3d-metadata/`, a UE
> editor commandlet that performs this extraction/verification automatically via UE reflection.
> See `tools/node-t3d-metadata/README.md` and `tools/node-t3d-metadata/docs/AGENT_WORKFLOW.md`.
> Use the manual procedure below only if you cannot run the commandlet.

## Contract (TypeScript types: viewer/web/src/export/export-meta-types.ts)

Each entry under `nodes` (and `reserved`) has:
- `ueClass` — full class path, e.g. `/Script/Engine.MaterialExpressionMultiply`.
- `inputs` — map of OUR pin name (from nodes-ue5.7.json `inputs[].name`) → `{ property }`,
  the UE FExpressionInput UProperty name. Property may be an array element like `Inputs(0)`.
- `outputs` — map of OUR pin name (`outputs[].name`) → `{ index, mask? }`. `index` is the
  UE OutputIndex; `mask` (e.g. `"R"`) only for sub-channel pins that select components.
- `params` — map of OUR param name (`params[].name`) → `{ property, kind, valueMap?, components? }`.
  `kind` ∈ float|int|bool|name|string|enum|vector2|vector3|vector4|texture.
  enum → `valueMap` from our value to UE literal. vectorN whose UE value is one struct built
  from several of our params → `components` mapping UE struct key (R/G/B/A) → our param name.
- `sample` — paste the RAW T3D text UE produced when you copied just that one node.
- `verified` — set `true` once confirmed.
- For `MaterialFunctionCall`: keep `functionRefProperty`. For dynamic-pin nodes you cannot map
  statically, set `dynamicExport: true` and add a note instead of guessing.

## Procedure per node type

1. In a UE 5.7 Material (use a Material Function for FunctionInput/FunctionOutput), add the
   expression. For reserved `MaterialFunctionCall`, add a call to any function.
2. Select it, Ctrl+C, and paste the clipboard text into the entry's `sample` (escape quotes/newlines as JSON).
3. From the sample and the node's pin names in `nodes-ue5.7.json`, fill `ueClass`, `inputs`,
   `outputs`, `params`. Confirm OutputIndex by wiring each output and checking the pasted
   `OutputIndex=`. Confirm input properties by wiring each input and checking which property
   the FExpressionInput lands on.
4. Set `verified: true`.

## Rules
- Keep `nodes` keys identical to `nodes-ue5.7.json` keys (the repo test
  `viewer/tests/export-meta.test.ts` fails on orphan keys).
- Do not touch `nodes-ue5.7.json`, only `nodes-ue5.7.export.json`.
- Leave `MaterialOutput` out entirely (never exported).
- **Verify property names against the copied T3D, never guess from display names.** UE 5.7's
  reflected `UProperty` name often differs from the Material Editor label or pre-5.7 docs:
  - The `Transform` node's enum UProperties are `TransformSourceType` / `TransformType`
    (not `Source` / `Destination`); `TransformPosition` likewise. Enum literals carry the full
    prefix (`TRANSFORMSOURCE_World`, `TRANSFORM_Tangent`, `TRANSFORMPOSSOURCE_*`).
  - Many connectable input properties have **no** `Const` prefix — they are plain `A`, `B`,
    `Coordinate`, `Alpha`, etc. (the `Const*` names are the unconnected-default *params*, a
    separate thing). Mapping an input to `ConstA` makes the connection paste onto the wrong slot.
  - Other corrected pin properties found during calibration: `SphereMask` `Radius`/`Hardness`,
    `Fresnel` `ExponentIn`/`BaseReflectFractionIn`, `BumpOffset` `HeightRatioInput`,
    `Clamp` `Min`/`Max`, `DepthFade` `FadeDistance`.
- For every `enum` param always include a `valueMap` from our value to the exact UE literal copied
  from the T3D (e.g. `"Masks"` → `"SAMPLERTYPE_Masks"`).
- Run `cd viewer && ./node_modules/.bin/vitest run tests/export-meta.test.ts` before returning.

Output: the updated `agent-pack/nodes-ue5.7.export.json`.

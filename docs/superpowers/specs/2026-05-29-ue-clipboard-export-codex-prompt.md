# Codex Task: Populate UE Export Metadata

Run this on a machine with Unreal Engine 5.7. Goal: fill
`agent-pack/nodes-ue5.7.export.json` with verified UE metadata for every node type
in `agent-pack/nodes-ue5.7.json`, so the viewer's "Export to UE" produces T3D that
pastes correctly into the Material Editor.

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
- Run `cd viewer && ./node_modules/.bin/vitest run tests/export-meta.test.ts` before returning.

Output: the updated `agent-pack/nodes-ue5.7.export.json`.

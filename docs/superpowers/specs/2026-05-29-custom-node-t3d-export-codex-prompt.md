# Codex Task: Capture one real UE 5.7 `Custom` node T3D sample

Run this on a machine with **Unreal Engine 5.7**. Goal: copy one real Material **Custom**
node (with the exact features below) to the clipboard and save the raw T3D as a fixture, so the
viewer's "Export to UE" emitter can be built and tested against genuine UE output (not a guess).

Output file: **`viewer/tests/fixtures/ue-custom-node.t3d`** — paste the clipboard text verbatim,
no edits, no escaping. Commit only that file.

## Build this exact graph in a UE 5.7 Material

1. Add a **Custom** expression. Set:
   - **Description** = `WF_CustomProbe`
   - **Output Type** = `CMOT Float 3`
   - **Inputs** (add two rows): `UV`, then `Mask`
   - **Additional Outputs** (add one row): name `Extra`, type `CMOT Float 1`
   - **Code** = paste this exact 3-line body (keep the `//` comment, the embedded `"`, and the
     line breaks — we need to see how UE escapes them):
     ```
     // probe
     float v = UV.x * Mask;
     return float3(v, v, "x" == 0 ? 0.0 : v);
     ```
2. Add a **TextureCoordinate** node → wire its `UVs` output into the Custom node's **`UV`** input.
3. Add a **Constant** node (value 1.0) → wire it into the Custom node's **`Mask`** input.
4. Add two **Multiply** nodes downstream:
   - Wire the Custom node's **primary output** (`Output`) into the first Multiply's `A`.
   - Wire the Custom node's **`Extra`** additional output into the second Multiply's `A`.
   (This makes both output `OutputIndex` values visible in the copied T3D.)

## Capture

1. **Select all five nodes** (Custom + TextureCoordinate + Constant + the two Multiplies).
2. `Ctrl+C`.
3. Paste the clipboard text **verbatim** into `viewer/tests/fixtures/ue-custom-node.t3d`.

## What we specifically need to see in the sample (do not summarize — the raw text has it all)

- The `Begin Object Class=/Script/UnrealEd.MaterialGraphNode … /Script/Engine.MaterialExpressionCustom …` framing for the Custom node.
- The **`Inputs(0)=(…)` / `Inputs(1)=(…)`** array elements — exactly how `FCustomInput` serializes
  (field names like `InputName`, `Input=(Expression=…,OutputIndex=…)`, and whether there is any
  extra field such as `InputType`).
- The **`Code=`** line — exactly how UE escapes the newlines, the `//` comment, and the `"`.
- `OutputType=` (expect `CMOT_Float3`) and `Description=`.
- The **`AdditionalOutputs(0)=(…)`** element (`OutputName`, `OutputType`).
- On the two Multiply nodes, the `A=(Expression=…Custom…,OutputIndex=0)` (primary) and
  `OutputIndex=1` (the `Extra` additional output) so we can confirm additional-output indexing.

## Rules

- Do **not** hand-edit the pasted text. Byte-for-byte from UE is the whole point.
- Do **not** touch any other file. Only add `viewer/tests/fixtures/ue-custom-node.t3d`.
- If UE 5.7's `FCustomInput` has fields we did not anticipate, that is exactly what we want to
  learn — leave them in the verbatim paste.

Output: the new file `viewer/tests/fixtures/ue-custom-node.t3d`.

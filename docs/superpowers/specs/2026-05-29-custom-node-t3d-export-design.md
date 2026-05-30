# Custom Node T3D Export — Design

Date: 2026-05-29
Scope: viewer (emitter `ueT3D.ts` + a tests fixture) + agent-pack (`nodes-ue5.7.export.json` Custom entry) + a Codex hand-off for one ground-truth sample

## Problem

`MaterialExpressionCustom` (the inline-HLSL escape hatch) is currently flagged
`dynamicExport: true` in `agent-pack/nodes-ue5.7.export.json`, so the T3D emitter skips it
with a warning. A material containing a Custom node therefore exports incompletely — the user
must rebuild every Custom node by hand in UE. We want Custom to export like any other node so a
material that uses it pastes whole into UE's Material Editor.

Custom is a **dynamic-pin** node: its input pins come from the user-defined `params.Inputs`
list, and its output pins are the primary `Output` plus any `params.AdditionalOutputs`. The
emitter must synthesize these pins per instance.

## Decision

**Approach 1 — type special-case in the emitter**, mirroring the existing
`node.type === 'MaterialFunctionCall'` handling. Custom is another dynamic-pin special case; the
emitter already has that shape, so a parallel `node.type === 'Custom'` branch is the smallest,
most consistent change. (Rejected: a generic metadata-driven dynamic-pin engine — the four
dynamic nodes have incompatible shapes, YAGNI; and routing Custom pins through server-side
`derivedPins` — Custom pins are self-describing from its own params, no external file needed.)

**Ground truth first.** We have no real UE T3D sample for Custom, and the exact serialization of
the `Inputs` array and (especially) multi-line `Code` string escaping cannot be guessed reliably.
Codex captures one real sample on a UE 5.7 machine **before** implementation; the emitter is built
against it and a non-tautological golden test asserts the emitter reproduces it.

## Design

### 1. Ground-truth sample — Codex hand-off

Codex builds one Custom node in a UE 5.7 Material and copies its T3D into a new fixture
`viewer/tests/fixtures/ue-custom-node.t3d`. The node must exercise every feature in scope:

- **Description** = `WF_CustomProbe`, **OutputType** = `CMOT_Float3`.
- **Inputs** (2, both wired): `UV` (fed by a `TextureCoordinate`), `Mask` (fed by a `Constant`).
- **AdditionalOutputs** (1): `Extra` of type `CMOT_Float1`, wired into a downstream node so its
  `OutputIndex` is visible.
- The primary `Output` also wired into a downstream node.
- **Code** = a 3-line HLSL body containing a `//` comment and at least one embedded `"` and a
  newline, e.g.:
  ```
  // probe
  float v = UV.x * Mask;
  return float3(v, v, "q-escape-test" == 0 ? 0 : v);
  ```
  (The exact body is unimportant — the point is to capture how UE escapes newlines, `//`, and `"`
  inside an exported `Code` FString.)

Codex copies the **whole selection** (Custom + the two feeder nodes + the two downstream nodes) so
the sample shows: the `FCustomInput` element layout, the `Code` escaping, `OutputType`,
`AdditionalOutputs(i)=(OutputName=…,OutputType=…)`, and the additional-output `OutputIndex`.

The hand-off prompt is written to
`docs/superpowers/specs/2026-05-29-custom-node-t3d-export-codex-prompt.md` during implementation.

### 2. Metadata change — `agent-pack/nodes-ue5.7.export.json` `nodes.Custom`

Current entry is `dynamicExport: true` with `inputs: {}`, `outputs: {}`, and `params` that wrongly
list `Inputs`/`AdditionalOutputs`/`IncludeFilePaths`/`AdditionalDefines` as `kind: "string"`.
After this change:

- **Remove** `dynamicExport: true` (so the line-206 skip no longer fires).
- `params` keeps **only** `Code` (string), `OutputType` (enum, the existing `valueMap`), and
  `Description` (string). These flow through the emitter's generic param loop.
- **Remove** `Inputs`, `AdditionalOutputs`, `IncludeFilePaths`, `AdditionalDefines` from `params`
  — they are handled structurally by the Custom branch (not as generic string params, which would
  emit garbage).
- `inputs` / `outputs` stay `{}` (pins are synthesized per instance from node params).
- Set `verified: true` once the golden test passes against the captured sample.

The `export-meta.test.ts` integrity tests still pass: Custom remains a valid `NodeExportMeta`
(ueClass + maps present), and it is no longer counted as dynamic.

### 3. Emitter — `viewer/web/src/export/ueT3D.ts`, `node.type === 'Custom'` branch

Four touch points mirror the MaterialFunctionCall handling:

**a. `nodeInputPins(node, meta, derivedPins)`** — add before the generic return:
```ts
if (node.type === 'Custom') {
  return ((node.params?.Inputs ?? []) as { InputName: string }[]).map(i => i.InputName);
}
```

**b. `nodeOutputPins(node, meta, derivedPins)`** — add before the generic return:
```ts
if (node.type === 'Custom') {
  const extra = ((node.params?.AdditionalOutputs ?? []) as { OutputName: string }[]).map(o => o.OutputName);
  return ['Output', ...extra];
}
```

**c. `srcRef(srcId, srcPin)`** (inside `graphToUET3D`) — add a Custom branch so a connection
*from* a Custom output resolves the right `OutputIndex`:
```ts
if (node?.type === 'Custom') {
  const outs = ['Output', ...((node.params?.AdditionalOutputs ?? []) as { OutputName: string }[]).map(o => o.OutputName)];
  const idx = outs.indexOf(srcPin);
  return { index: idx < 0 ? 0 : idx };
}
```

**d. Inner-fill emission** (the per-node block at lines ~312–352) — for Custom, the input
connections serialize into the `Inputs` array (every declared input emits an element so the pin
exists; connected ones also carry `Input=(…)`), and `AdditionalOutputs` serialize as their own
array. Replace the generic connection loop for Custom with:
```ts
if (node.type === 'Custom') {
  const inputs = (node.params?.Inputs ?? []) as { InputName: string }[];
  const incomingByPin = new Map((incoming.get(node.id) ?? []).map(c => [c.dstPin, c]));
  inputs.forEach((inp, i) => {
    const c = incomingByPin.get(inp.InputName);
    if (c) {
      const { index, mask } = srcRef(c.srcId, c.srcPin);
      const ref = `Expression=${byNodeId.get(c.srcId)!.expressionName},OutputIndex=${index}${maskBits(mask)}`;
      lines.push(`${I}${I}Inputs(${i})=(InputName=${quote(inp.InputName)},Input=(${ref}))`);
    } else {
      lines.push(`${I}${I}Inputs(${i})=(InputName=${quote(inp.InputName)})`);
    }
  });
  const addOuts = (node.params?.AdditionalOutputs ?? []) as { OutputName: string; OutputType?: string }[];
  addOuts.forEach((o, i) => {
    lines.push(`${I}${I}AdditionalOutputs(${i})=(OutputName=${quote(o.OutputName)},OutputType=${o.OutputType ?? 'CMOT_Float1'})`);
  });
} else {
  // existing generic connection loop
}
```
The generic param loop (Code/OutputType/Description), the `CustomProperties Pin` lines (driven by
`nodeInputPins`/`nodeOutputPins`), `MaterialExpression=`, `NodePosX/Y`, and `NodeGuid` are all
unchanged — they already work once the pin lists and the inner array emission are in place.

**Code escaping.** `Code` is `kind: 'string'` → `fmtParam` → `quote()`, which today escapes only
`\` and `"`. The captured sample dictates newline handling. If UE escapes newlines as literal `\n`
inside the quoted string, extend `quote()` (or a dedicated `quoteCode` helper) to replace `\n` →
`\\n` and `\r` → ``; the exact rule is locked to the fixture, not guessed. This is the one detail
that must match the sample byte-for-byte.

The byte structure of the `Inputs(i)=(…)` element above is the design's best reading of
`FCustomInput`; if the captured sample differs (e.g. an extra `InputType` field), the emitter is
corrected to match the sample before `verified` is set.

### 4. Tests — `viewer/tests/ueT3D.test.ts`

A ground-truth reproduction test in the same shape as the existing core-fixture test:
- Reconstruct the sampled graph (the Custom node + feeders + downstream) as a `MatGraph`, drive it
  through the emitter with the real `nodes-ue5.7.export.json`.
- Read `viewer/tests/fixtures/ue-custom-node.t3d` and assert every Custom-specific real-UE token
  appears in **both** the fixture and the emitter output: the `Inputs(0)=(InputName="UV",Input=(…`
  element, `Inputs(1)=(InputName="Mask"…`, `Code=` with the sampled escaping,
  `OutputType=CMOT_Float3`, `AdditionalOutputs(0)=(OutputName="Extra"`, the additional-output
  `OutputIndex=1` on the downstream connection, and `Description="WF_CustomProbe"`.
- Assert the no-longer-skipped behavior: the warnings list contains **no** `not exportable`
  warning for the Custom node.

### 5. Scope

In scope: `Code`, `OutputType`, `Description`, dynamic `Inputs` (input pins + connections),
primary `Output`, and `AdditionalOutputs` (extra output pins + connections).

Out of scope (defer; do not emit unless the captured sample makes it trivially free):
`IncludeFilePaths`, `AdditionalDefines`. They do not affect graph connectivity. The other three
dynamic-pin nodes (`SetMaterialAttributes`, `GetMaterialAttributes`, `LandscapeLayerBlend`) remain
`dynamicExport` and skipped — separate future work.

### 6. Constraint on the Step-2 stress material

For Custom to export, the authored node's `params.Inputs[i].InputName` must equal the pin name used
on the wire (`connections[].to` = `"<customId>:<InputName>"`), and `params.AdditionalOutputs[i].OutputName`
must equal the source pin name on any wire leaving that output. The Step-2 subagent prompt will state
this explicitly.

## Files touched

- New: `viewer/tests/fixtures/ue-custom-node.t3d` (Codex sample),
  `docs/superpowers/specs/2026-05-29-custom-node-t3d-export-codex-prompt.md` (hand-off).
- Modified: `viewer/web/src/export/ueT3D.ts` (Custom branch), `agent-pack/nodes-ue5.7.export.json`
  (Custom entry), `viewer/tests/ueT3D.test.ts` (golden test).
- Unchanged: `.matgraph.json` schema, server, the authoring DB `nodes-ue5.7.json`.

## Out of scope

- The four-dynamic-node generic exporter.
- Import (T3D → JSON) — still a stub.
- `IncludeFilePaths` / `AdditionalDefines` emission.

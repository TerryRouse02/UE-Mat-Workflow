# Custom Node T3D Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `MaterialExpressionCustom` export to UE T3D clipboard like any other node, by adding a `node.type === 'Custom'` branch to the emitter that synthesizes its dynamic input/output pins.

**Architecture:** Approach 1 (emitter type special-case, mirroring the existing `MaterialFunctionCall` handling). Custom input pins come from `params.Inputs`, output pins from primary `Output` + `params.AdditionalOutputs`; the `Inputs(i)` and `AdditionalOutputs(i)` arrays are emitted structurally. Built and tested against a real UE 5.7 sample captured by Codex first.

**Tech Stack:** TypeScript, vitest. Run tests from `viewer/`: `PATH="/usr/local/bin:$PATH" ./node_modules/.bin/vitest run <files>` (node is at `/usr/local/bin/node`; pnpm is not on PATH).

**Reference:** Design spec `docs/superpowers/specs/2026-05-29-custom-node-t3d-export-design.md`. Emitter currently at `viewer/web/src/export/ueT3D.ts`; the MaterialFunctionCall special-casing it mirrors lives in `nodeInputPins` (~149), `nodeOutputPins` (~140), `srcRef` (~227), and the connection loop (~333).

---

## Task 0: Obtain the ground-truth sample (PREREQUISITE — external, no code)

**Files:**
- Create (by Codex): `viewer/tests/fixtures/ue-custom-node.t3d`

- [ ] **Step 1: Run the Codex hand-off**

The hand-off prompt is `docs/superpowers/specs/2026-05-29-custom-node-t3d-export-codex-prompt.md`. The user runs it on a UE 5.7 machine; Codex commits `viewer/tests/fixtures/ue-custom-node.t3d` (a verbatim UE clipboard paste of a Custom node with 2 inputs `UV`/`Mask`, 1 additional output `Extra`/CMOT_Float1, OutputType CMOT_Float3, Description `WF_CustomProbe`, and a 3-line `Code` body).

- [ ] **Step 2: Verify the fixture is real and complete before proceeding**

Run: `grep -c "MaterialExpressionCustom" viewer/tests/fixtures/ue-custom-node.t3d`
Expected: ≥ 1. Also confirm by eye that the file contains `Inputs(0)=(`, `Inputs(1)=(`, `Code=`, `OutputType=CMOT_Float3`, and `AdditionalOutputs(0)=(`.

**Do not start Tasks 1–3 until this file exists.** Tasks 2–3 derive their exact expected tokens (especially `Code` escaping and the `Inputs(i)` field layout) from this file.

---

## Task 1: Un-skip Custom in the export metadata

**Files:**
- Modify: `agent-pack/nodes-ue5.7.export.json` (the `nodes.Custom` entry)
- Test: `viewer/tests/export-meta.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `viewer/tests/export-meta.test.ts` inside the `describe('nodes-ue5.7.export.json', …)` block:

```ts
it('exports Custom as a non-dynamic node with only structural scalar params', () => {
  const c = exp.nodes.Custom;
  expect(c, 'Custom export meta missing').toBeTruthy();
  expect(c.dynamicExport ?? false).toBe(false);
  expect(c.ueClass).toBe('/Script/Engine.MaterialExpressionCustom');
  // Code/OutputType/Description flow through the generic param loop:
  expect(Object.keys(c.params).sort()).toEqual(['Code', 'Description', 'OutputType']);
  // Inputs/AdditionalOutputs are handled structurally, NOT as generic string params:
  expect(c.params.Inputs).toBeUndefined();
  expect(c.params.AdditionalOutputs).toBeUndefined();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd viewer && PATH="/usr/local/bin:$PATH" ./node_modules/.bin/vitest run tests/export-meta.test.ts`
Expected: FAIL — current entry has `dynamicExport: true` and lists `Inputs`/`AdditionalOutputs`/`IncludeFilePaths`/`AdditionalDefines` in `params`.

- [ ] **Step 3: Edit the Custom entry**

In `agent-pack/nodes-ue5.7.export.json`, replace the `nodes.Custom` entry's body so it reads exactly:

```json
"Custom": {
  "ueClass": "/Script/Engine.MaterialExpressionCustom",
  "inputs": {},
  "outputs": {},
  "params": {
    "Code": { "property": "Code", "kind": "string" },
    "OutputType": {
      "property": "OutputType",
      "kind": "enum",
      "valueMap": {
        "CMOT_Float1": "CMOT_Float1",
        "CMOT_Float2": "CMOT_Float2",
        "CMOT_Float3": "CMOT_Float3",
        "CMOT_Float4": "CMOT_Float4",
        "CMOT_MaterialAttributes": "CMOT_MaterialAttributes"
      }
    },
    "Description": { "property": "Description", "kind": "string" }
  },
  "sample": "",
  "verified": false,
  "note": "Inputs and AdditionalOutputs are emitted structurally by the Custom branch in ueT3D.ts; verified against viewer/tests/fixtures/ue-custom-node.t3d."
}
```
(Leave `verified: false` for now; Task 3 flips it to `true` after the golden test passes.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd viewer && PATH="/usr/local/bin:$PATH" ./node_modules/.bin/vitest run tests/export-meta.test.ts`
Expected: PASS (all export-meta tests, including the new one and the existing orphan/well-formed checks).

- [ ] **Step 5: Commit**

```bash
git add agent-pack/nodes-ue5.7.export.json viewer/tests/export-meta.test.ts
git commit -m "feat(export): un-skip Custom in export metadata (structural Inputs/AdditionalOutputs)"
```

---

## Task 2: Emitter Custom branch + golden test (TDD against the real sample)

**Files:**
- Modify: `viewer/web/src/export/ueT3D.ts` (`nodeInputPins`, `nodeOutputPins`, `srcRef`, the inner-fill connection loop)
- Test: `viewer/tests/ueT3D.test.ts`

- [ ] **Step 1: Write the failing golden test**

Add to `viewer/tests/ueT3D.test.ts` inside `describe('graphToUET3D', …)`. Reconstruct the sampled graph and assert the emitter reproduces the Custom-specific tokens that also appear in the real fixture. Read the fixture and assert each token in BOTH (grounding, non-tautological):

```ts
it('exports a Custom node with dynamic inputs and additional outputs matching the UE fixture', () => {
  const exportMeta = JSON.parse(readFileSync(
    resolve(__dirname, '../../agent-pack/nodes-ue5.7.export.json'), 'utf-8',
  )) as ExportMeta;
  const fixture = readFileSync(resolve(__dirname, 'fixtures/ue-custom-node.t3d'), 'utf-8');

  const graph: MatGraph = {
    schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'customprobe',
    nodes: [
      { id: 'uv', type: 'TextureCoordinate' },
      { id: 'k', type: 'Constant', params: { R: 1 } },
      { id: 'cust', type: 'Custom', params: {
        Description: 'WF_CustomProbe',
        OutputType: 'CMOT_Float3',
        Code: '// probe\nfloat v = UV.x * Mask;\nreturn float3(v, v, "x" == 0 ? 0.0 : v);',
        Inputs: [{ InputName: 'UV' }, { InputName: 'Mask' }],
        AdditionalOutputs: [{ OutputName: 'Extra', OutputType: 'CMOT_Float1' }],
      } },
      { id: 'm1', type: 'Multiply' },
      { id: 'm2', type: 'Multiply' },
    ],
    connections: [
      { from: 'uv:UVs', to: 'cust:UV' },
      { from: 'k:Value', to: 'cust:Mask' },
      { from: 'cust:Output', to: 'm1:A' },
      { from: 'cust:Extra', to: 'm2:A' },
    ],
  };
  const positions = layout({ uv: [0, 0], k: [0, 200], cust: [240, 0], m1: [480, 0], m2: [480, 200] });

  const { text, warnings } = graphToUET3D(graph, positions, exportMeta, NO_PINS);

  // Custom is no longer skipped:
  expect(warnings.some(w => /cust.*not exportable/i.test(w))).toBe(false);

  // Tokens that must appear in BOTH the real fixture and the emitter output:
  const tokens = [
    'Begin Object Class=/Script/Engine.MaterialExpressionCustom',
    'OutputType=CMOT_Float3',
    'Description="WF_CustomProbe"',
    'Inputs(0)=(InputName="UV"',
    'Inputs(1)=(InputName="Mask"',
    'AdditionalOutputs(0)=(OutputName="Extra"',
  ];
  for (const t of tokens) {
    expect(fixture, `fixture must contain ${t}`).toContain(t);
    expect(text, `emitter must reproduce ${t}`).toContain(t);
  }

  // Dynamic input pins and both output pins are declared:
  expect(text).toContain('PinName="UV"');
  expect(text).toContain('PinName="Mask"');
  expect(text).toContain('PinName="Output"');
  expect(text).toContain('PinName="Extra"');

  // Connections land on Inputs(i).Input, and the additional output indexes at 1:
  expect(text).toMatch(/Inputs\(0\)=\(InputName="UV",Input=\(Expression=MaterialExpressionTextureCoordinate_\d+,OutputIndex=0\)\)/);
  expect(text).toMatch(/A=\(Expression=MaterialExpressionCustom_\d+,OutputIndex=1\)/); // m2 <- cust:Extra
});
```

> **Sample-derived detail:** the literal `Code=` form is the one thing that depends on UE's escaping (newlines, `//`, `"`). After capturing the fixture, read its `Code=` line and add one assertion that the emitter reproduces that exact escaped form, e.g. `expect(text).toContain(fixtureCodeLine)` where `fixtureCodeLine` is the trimmed `Code=…` line extracted from the fixture. If the fixture's `FCustomInput` element carries a field beyond `InputName`/`Input` (e.g. `InputType`), add it to the emitted element in Step 3 and to these assertions.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd viewer && PATH="/usr/local/bin:$PATH" ./node_modules/.bin/vitest run tests/ueT3D.test.ts`
Expected: FAIL — Custom currently emits no `Inputs(...)`/`AdditionalOutputs(...)` and no `PinName="UV"` etc.

- [ ] **Step 3: Implement the Custom branch (four touch points)**

In `viewer/web/src/export/ueT3D.ts`:

(a) In `nodeInputPins(node, meta, derivedPins)`, add before the final `return Object.keys(meta.inputs);`:
```ts
if (node.type === 'Custom') {
  return ((node.params?.Inputs ?? []) as { InputName: string }[]).map(i => i.InputName);
}
```

(b) In `nodeOutputPins(node, meta, derivedPins)`, add before the final generic return:
```ts
if (node.type === 'Custom') {
  const extra = ((node.params?.AdditionalOutputs ?? []) as { OutputName: string }[]).map(o => o.OutputName);
  return ['Output', ...extra];
}
```

(c) Inside `graphToUET3D`, in the `srcRef` closure, add a Custom branch after the MaterialFunctionCall branch:
```ts
if (node?.type === 'Custom') {
  const outs = ['Output', ...((node.params?.AdditionalOutputs ?? []) as { OutputName: string }[]).map(o => o.OutputName)];
  const idx = outs.indexOf(srcPin);
  return { index: idx < 0 ? 0 : idx };
}
```

(d) In the per-node inner-fill emission, replace the connection loop
`for (const connection of incoming.get(node.id) ?? []) { … }` with a Custom-aware version:
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
  for (const connection of incoming.get(node.id) ?? []) {
    const src = byNodeId.get(connection.srcId);
    if (!src) continue;
    const { index, mask } = srcRef(connection.srcId, connection.srcPin);
    const ref = `Expression=${src.expressionName},OutputIndex=${index}${maskBits(mask)}`;
    if (nodeMeta.functionRefProperty) {
      lines.push(`${I}${I}FunctionInputs(${functionInputIndex(node, nodeMeta, connection.dstPin, derivedPins)})=(Input=(${ref}))`);
    } else {
      const inProp = nodeMeta.inputs[connection.dstPin]?.property;
      if (!inProp) {
        warnings.push(`Node "${node.id}" (${node.type}): input pin "${connection.dstPin}" has no UE mapping - connection skipped.`);
        continue;
      }
      lines.push(`${I}${I}${inProp}=(${ref})`);
    }
  }
}
```

If the fixture's `Code=` line shows escaped newlines, update `quote()` (or add a `quoteMultiline` used only for the `Code` param) so the emitted `Code=` matches the fixture byte-for-byte. Make the minimal change that reproduces the fixture.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd viewer && PATH="/usr/local/bin:$PATH" ./node_modules/.bin/vitest run tests/ueT3D.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add viewer/web/src/export/ueT3D.ts viewer/tests/ueT3D.test.ts
git commit -m "feat(export): emit MaterialExpressionCustom with dynamic Inputs + AdditionalOutputs"
```

---

## Task 3: Full-suite verification + flip `verified`

**Files:**
- Modify: `agent-pack/nodes-ue5.7.export.json` (`nodes.Custom.verified`)

- [ ] **Step 1: Run the entire suite**

Run: `cd viewer && PATH="/usr/local/bin:$PATH" ./node_modules/.bin/vitest run`
Expected: PASS — all test files green (the new Custom golden test included), no regressions.

- [ ] **Step 2: Flip the verified flag**

In `agent-pack/nodes-ue5.7.export.json`, set `nodes.Custom.verified` to `true` (the golden test against the real fixture is the confirmation the repo convention requires).

- [ ] **Step 3: Re-run export-meta tests**

Run: `cd viewer && PATH="/usr/local/bin:$PATH" ./node_modules/.bin/vitest run tests/export-meta.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add agent-pack/nodes-ue5.7.export.json
git commit -m "chore(export): mark Custom export verified against UE fixture"
```

---

## Notes for the implementer

- Custom's generic param loop already emits `Code`/`OutputType`/`Description` from the metadata params — the branch only adds the `Inputs(i)`/`AdditionalOutputs(i)` arrays and the dynamic pin lists. Do not also emit `Inputs`/`AdditionalOutputs` as generic string params (they are no longer in the metadata params, so the generic loop will not).
- `I`, `quote`, `maskBits`, `byNodeId`, `incoming`, `srcRef` are all in scope at the inner-fill emission point. `srcRef` is defined above the per-node loop.
- The other three dynamic-pin nodes (`SetMaterialAttributes`, `GetMaterialAttributes`, `LandscapeLayerBlend`) stay `dynamicExport` and skipped — out of scope.

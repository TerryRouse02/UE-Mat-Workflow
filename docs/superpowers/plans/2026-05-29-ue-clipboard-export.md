# UE Clipboard Export (T3D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click "Export to UE" that copies the currently-open graph to the clipboard as Unreal's native T3D material-expression text, pasteable into UE's Material Editor.

**Architecture:** A pure, unit-tested emitter (`graph + layout + derivedPins + metadata → T3D string`) in the web package, fed by a UE-metadata sidecar (`agent-pack/nodes-ue5.7.export.json`) that Codex backfills on a UE machine. A toolbar Panel in the graph view builds the layout map from live node positions and writes the result to the clipboard. Import is a disabled stub.

**Tech Stack:** TypeScript, React + React Flow (existing), vitest. Sidecar bundled via a `@export-meta` vite alias mirroring the existing `@db` alias.

**Key facts about the existing codebase (do not re-derive):**
- Tests live in `viewer/tests/*.test.ts`, run by `viewer/vitest.config.ts` (node env, no path aliases). They import web sources by relative path, e.g. `../web/src/groupFiles`. Run from `viewer/`.
- `viewer/web/vite.config.ts` defines `@db` → `../../agent-pack/nodes-ue5.7.json`; `viewer/web/src/vite-env.d.ts` declares `module '@db'`; `viewer/web/src/db.ts` does `import dbJson from '@db'`. Mirror this exactly for `@export-meta`.
- Graph types are in `viewer/web/src/protocol.ts`: `MatGraph` (`nodes: {id,type,params?}[]`, `connections: {from,to}[]`, `comments?: {id,text,color?,contains}[]`, `type`, `name`), `DerivedPins` (`{inputs,outputs: {name,type}[]}`), `GraphPayload` (`{graph, derivedPins, warnings}`).
- `viewer/web/src/Graph.tsx` holds live positioned nodes in `const [nodes] = useNodesState(...)` (each `n.position.{x,y}`) and receives `payload` (with `derivedPins`) and `basePath`. This is where the export Panel goes.
- pnpm is not on PATH in CI shells. Run tests with: `cd viewer && PATH="/usr/local/bin:$PATH" ./node_modules/.bin/vitest run`. Typecheck/build the web bundle with `PATH="/usr/local/bin:$PATH" ./node_modules/.bin/vite build` from `viewer/web` (or `./node_modules/.bin/tsc -p tsconfig.json` for a typecheck-only pass if present).

**v1 fidelity note (read before implementing):** Simple expression nodes (math, constants, parameters, texture samples) map cleanly. Three areas are emitted **best-effort pending Codex sample verification** and are explicitly called out where they occur: (a) `QualitySwitch`/`FeatureLevelSwitch` array-indexed inputs (`Inputs(n)`), (b) channel-mask outputs, (c) `MaterialFunctionCall` nested `FunctionInputs(n)=(Input=(...))` wiring. Golden tests assert *our* chosen format so behavior is locked and regressions are caught; Codex confirms the exact UE framing later.

---

## File Structure

- Create `viewer/web/src/export/export-meta-types.ts` — pure TypeScript interfaces for the sidecar. **No runtime imports** (so the emitter and tests can import types without pulling the `@export-meta` alias).
- Create `agent-pack/nodes-ue5.7.export.json` — the metadata sidecar with a hand-authored subset (`verified:false`) + `reserved` block.
- Create `viewer/web/src/export/export-meta.ts` — loader: `import meta from '@export-meta'; export const EXPORT_META = meta as ExportMeta`. Only the React layer imports this.
- Create `viewer/web/src/export/ueT3D.ts` — pure emitter `graphToUET3D(...)` + `parseUET3D(...)` stub. Imports **types only**.
- Modify `viewer/web/vite.config.ts` and `viewer/web/src/vite-env.d.ts` — add the `@export-meta` alias + module declaration.
- Modify `viewer/web/src/Graph.tsx` — add the export Panel (button, disabled import, MF-root input, transient toast).
- Create `viewer/tests/export-meta.test.ts` — sidecar integrity tests.
- Create `viewer/tests/ueT3D.test.ts` — emitter golden tests.
- Create `docs/superpowers/specs/2026-05-29-ue-clipboard-export-codex-prompt.md` — Codex hand-off prompt.
- Modify `agent-pack/SPEC.md` — engine-path MF + auto-link convention note.

---

## Task 1: Metadata types + sidecar + integrity test

**Files:**
- Create: `viewer/web/src/export/export-meta-types.ts`
- Create: `agent-pack/nodes-ue5.7.export.json`
- Test: `viewer/tests/export-meta.test.ts`

- [ ] **Step 1: Write the types file**

`viewer/web/src/export/export-meta-types.ts`:

```ts
// UE export metadata contract. Pure types — no runtime imports.
export type ParamKind =
  | 'float' | 'int' | 'bool' | 'name' | 'string' | 'enum'
  | 'vector2' | 'vector3' | 'vector4' | 'texture';

export interface ParamMeta {
  property: string;                       // UE UProperty name
  kind: ParamKind;
  valueMap?: Record<string, string>;      // enum: our value -> UE literal
  components?: Record<string, string>;    // vectorN: UE struct key (R/G/B/A) -> our param name
}

export interface InputMeta {
  property: string;                       // UE FExpressionInput property; may be "A" or "Inputs(0)"
}

export interface OutputMeta {
  index: number;                          // UE OutputIndex
  mask?: string;                          // channel mask like "R", "G", "RG" (omit for full output)
}

export interface NodeExportMeta {
  ueClass: string;                        // e.g. "/Script/Engine.MaterialExpressionMultiply"
  inputs: Record<string, InputMeta>;      // our pin name -> input mapping
  outputs: Record<string, OutputMeta>;    // our pin name -> output mapping
  params: Record<string, ParamMeta>;      // our param name -> param mapping
  functionRefProperty?: string;           // MaterialFunctionCall only
  sample?: string;                        // raw copied T3D (reference only; not parsed)
  verified?: boolean;
  dynamicExport?: boolean;                // dynamic-pin node; emitter skips with a warning
}

export interface ExportMeta {
  schemaVersion: string;
  ueVersion: string;
  generatedAt?: string;
  source?: string;
  nodes: Record<string, NodeExportMeta>;
  reserved: Record<string, NodeExportMeta>;
}
```

- [ ] **Step 2: Write the integrity test (red)**

`viewer/tests/export-meta.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExportMeta } from '../web/src/export/export-meta-types';

const ROOT = resolve(__dirname, '../../agent-pack');
const exp: ExportMeta = JSON.parse(readFileSync(resolve(ROOT, 'nodes-ue5.7.export.json'), 'utf-8'));
const db = JSON.parse(readFileSync(resolve(ROOT, 'nodes-ue5.7.json'), 'utf-8'));

describe('nodes-ue5.7.export.json', () => {
  it('declares ue 5.7', () => {
    expect(exp.ueVersion).toBe('5.7');
  });

  it('has no orphan node entries (every export key exists in the authoring DB)', () => {
    const orphans = Object.keys(exp.nodes).filter(k => !(k in db.nodes));
    expect(orphans).toEqual([]);
  });

  it('includes the hand-authored subset', () => {
    for (const t of ['Multiply', 'Add', 'Subtract', 'Saturate', 'Lerp', 'Constant',
                     'ScalarParameter', 'StaticSwitchParameter', 'QualitySwitch',
                     'FeatureLevelSwitch', 'TextureSampleParameter2D']) {
      expect(exp.nodes[t], `missing export meta for ${t}`).toBeTruthy();
      expect(exp.nodes[t].ueClass).toMatch(/^\/Script\/Engine\.MaterialExpression/);
    }
  });

  it('covers the reserved types that are exportable', () => {
    for (const t of ['MaterialFunctionCall', 'FunctionInput', 'FunctionOutput']) {
      expect(exp.reserved[t], `missing reserved export meta for ${t}`).toBeTruthy();
    }
    expect(exp.reserved['MaterialOutput']).toBeUndefined(); // never exported
  });

  it('every node/reserved entry has well-formed outputs and params maps', () => {
    for (const m of [...Object.values(exp.nodes), ...Object.values(exp.reserved)]) {
      expect(typeof m.ueClass).toBe('string');
      expect(typeof m.inputs).toBe('object');
      expect(typeof m.outputs).toBe('object');
      expect(typeof m.params).toBe('object');
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd viewer && PATH="/usr/local/bin:$PATH" ./node_modules/.bin/vitest run tests/export-meta.test.ts`
Expected: FAIL — cannot read `nodes-ue5.7.export.json` (file does not exist).

- [ ] **Step 4: Create the sidecar file**

`agent-pack/nodes-ue5.7.export.json` (hand-authored subset, all `verified:false`):

```json
{
  "schemaVersion": "1.0",
  "ueVersion": "5.7",
  "generatedAt": "2026-05-29",
  "source": "hand-authored subset (best-effort, unverified) — Codex backfills/verifies on a UE 5.7 machine",
  "nodes": {
    "Multiply": {
      "ueClass": "/Script/Engine.MaterialExpressionMultiply",
      "inputs": { "A": { "property": "A" }, "B": { "property": "B" } },
      "outputs": { "Result": { "index": 0 } },
      "params": { "ConstA": { "property": "ConstA", "kind": "float" }, "ConstB": { "property": "ConstB", "kind": "float" } },
      "verified": false
    },
    "Add": {
      "ueClass": "/Script/Engine.MaterialExpressionAdd",
      "inputs": { "A": { "property": "A" }, "B": { "property": "B" } },
      "outputs": { "Result": { "index": 0 } },
      "params": { "ConstA": { "property": "ConstA", "kind": "float" }, "ConstB": { "property": "ConstB", "kind": "float" } },
      "verified": false
    },
    "Subtract": {
      "ueClass": "/Script/Engine.MaterialExpressionSubtract",
      "inputs": { "A": { "property": "A" }, "B": { "property": "B" } },
      "outputs": { "Result": { "index": 0 } },
      "params": { "ConstA": { "property": "ConstA", "kind": "float" }, "ConstB": { "property": "ConstB", "kind": "float" } },
      "verified": false
    },
    "Saturate": {
      "ueClass": "/Script/Engine.MaterialExpressionSaturate",
      "inputs": { "Input": { "property": "Input" } },
      "outputs": { "Result": { "index": 0 } },
      "params": {},
      "verified": false
    },
    "Lerp": {
      "ueClass": "/Script/Engine.MaterialExpressionLinearInterpolate",
      "inputs": { "A": { "property": "A" }, "B": { "property": "B" }, "Alpha": { "property": "Alpha" } },
      "outputs": { "Result": { "index": 0 } },
      "params": { "ConstAlpha": { "property": "ConstAlpha", "kind": "float" } },
      "verified": false
    },
    "Constant": {
      "ueClass": "/Script/Engine.MaterialExpressionConstant",
      "inputs": {},
      "outputs": { "Value": { "index": 0 } },
      "params": { "R": { "property": "R", "kind": "float" } },
      "verified": false
    },
    "ScalarParameter": {
      "ueClass": "/Script/Engine.MaterialExpressionScalarParameter",
      "inputs": {},
      "outputs": { "Value": { "index": 0 } },
      "params": { "ParameterName": { "property": "ParameterName", "kind": "name" }, "DefaultValue": { "property": "DefaultValue", "kind": "float" } },
      "verified": false
    },
    "StaticSwitchParameter": {
      "ueClass": "/Script/Engine.MaterialExpressionStaticSwitchParameter",
      "inputs": { "A": { "property": "A" }, "B": { "property": "B" } },
      "outputs": { "Result": { "index": 0 } },
      "params": { "ParameterName": { "property": "ParameterName", "kind": "name" }, "DefaultValue": { "property": "DefaultValue", "kind": "bool" } },
      "verified": false
    },
    "QualitySwitch": {
      "ueClass": "/Script/Engine.MaterialExpressionQualitySwitch",
      "inputs": { "Default": { "property": "Default" }, "Low": { "property": "Inputs(0)" }, "High": { "property": "Inputs(1)" } },
      "outputs": { "Result": { "index": 0 } },
      "params": {},
      "verified": false
    },
    "FeatureLevelSwitch": {
      "ueClass": "/Script/Engine.MaterialExpressionFeatureLevelSwitch",
      "inputs": { "Default": { "property": "Default" }, "ES2": { "property": "Inputs(0)" }, "ES3.1": { "property": "Inputs(1)" }, "SM4": { "property": "Inputs(2)" }, "SM5": { "property": "Inputs(3)" } },
      "outputs": { "Result": { "index": 0 } },
      "params": {},
      "verified": false
    },
    "TextureSampleParameter2D": {
      "ueClass": "/Script/Engine.MaterialExpressionTextureSampleParameter2D",
      "inputs": { "UVs": { "property": "Coordinates" }, "Tex": { "property": "TextureObject" } },
      "outputs": { "RGB": { "index": 0 }, "R": { "index": 1 }, "G": { "index": 2 }, "B": { "index": 3 }, "A": { "index": 4 }, "RGBA": { "index": 5 } },
      "params": {
        "ParameterName": { "property": "ParameterName", "kind": "name" },
        "Texture": { "property": "Texture", "kind": "texture" },
        "SamplerType": { "property": "SamplerType", "kind": "enum", "valueMap": {
          "Color": "SAMPLERTYPE_Color", "LinearColor": "SAMPLERTYPE_LinearColor",
          "Grayscale": "SAMPLERTYPE_Grayscale", "LinearGrayscale": "SAMPLERTYPE_LinearGrayscale",
          "Normal": "SAMPLERTYPE_Normal", "Alpha": "SAMPLERTYPE_Alpha", "Masks": "SAMPLERTYPE_Masks",
          "Data": "SAMPLERTYPE_Data", "External": "SAMPLERTYPE_External", "VirtualColor": "SAMPLERTYPE_VirtualColor" } }
      },
      "verified": false
    }
  },
  "reserved": {
    "MaterialFunctionCall": {
      "ueClass": "/Script/Engine.MaterialExpressionMaterialFunctionCall",
      "functionRefProperty": "MaterialFunction",
      "inputs": {}, "outputs": {}, "params": {},
      "verified": false
    },
    "FunctionInput": {
      "ueClass": "/Script/Engine.MaterialExpressionFunctionInput",
      "inputs": {},
      "outputs": { "Input": { "index": 0 } },
      "params": {
        "InputName": { "property": "InputName", "kind": "name" },
        "InputType": { "property": "InputType", "kind": "enum", "valueMap": {
          "Scalar": "FunctionInput_Scalar", "VectorFloat2": "FunctionInput_Vector2",
          "VectorFloat3": "FunctionInput_Vector3", "VectorFloat4": "FunctionInput_Vector4",
          "Texture2D": "FunctionInput_Texture2D", "MaterialAttributes": "FunctionInput_MaterialAttributes" } }
      },
      "verified": false
    },
    "FunctionOutput": {
      "ueClass": "/Script/Engine.MaterialExpressionFunctionOutput",
      "inputs": { "Input": { "property": "A" } },
      "outputs": {},
      "params": { "OutputName": { "property": "OutputName", "kind": "name" } },
      "verified": false
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd viewer && PATH="/usr/local/bin:$PATH" ./node_modules/.bin/vitest run tests/export-meta.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add viewer/web/src/export/export-meta-types.ts agent-pack/nodes-ue5.7.export.json viewer/tests/export-meta.test.ts
git commit -m "feat(export): UE metadata sidecar + types + integrity tests"
```

---

## Task 2: Pure T3D emitter + golden tests

**Files:**
- Create: `viewer/web/src/export/ueT3D.ts`
- Test: `viewer/tests/ueT3D.test.ts`

- [ ] **Step 1: Write the emitter test suite (red)**

`viewer/tests/ueT3D.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { graphToUET3D, parseUET3D } from '../web/src/export/ueT3D';
import type { ExportMeta } from '../web/src/export/export-meta-types';
import type { MatGraph, DerivedPins } from '../web/src/protocol';

const META: ExportMeta = {
  schemaVersion: '1.0', ueVersion: '5.7', nodes: {
    Multiply: { ueClass: '/Script/Engine.MaterialExpressionMultiply',
      inputs: { A: { property: 'A' }, B: { property: 'B' } }, outputs: { Result: { index: 0 } },
      params: { ConstB: { property: 'ConstB', kind: 'float' } } },
    Constant: { ueClass: '/Script/Engine.MaterialExpressionConstant',
      inputs: {}, outputs: { Value: { index: 0 } }, params: { R: { property: 'R', kind: 'float' } } },
    TextureSampleParameter2D: { ueClass: '/Script/Engine.MaterialExpressionTextureSampleParameter2D',
      inputs: { UVs: { property: 'Coordinates' } },
      outputs: { RGB: { index: 0 }, R: { index: 1 } },
      params: { SamplerType: { property: 'SamplerType', kind: 'enum', valueMap: { Normal: 'SAMPLERTYPE_Normal' } } } },
  },
  reserved: {
    MaterialFunctionCall: { ueClass: '/Script/Engine.MaterialExpressionMaterialFunctionCall',
      functionRefProperty: 'MaterialFunction', inputs: {}, outputs: {}, params: {} },
    FunctionInput: { ueClass: '/Script/Engine.MaterialExpressionFunctionInput',
      inputs: {}, outputs: { Input: { index: 0 } },
      params: { InputName: { property: 'InputName', kind: 'name' } } },
    FunctionOutput: { ueClass: '/Script/Engine.MaterialExpressionFunctionOutput',
      inputs: { Input: { property: 'A' } }, outputs: {},
      params: { OutputName: { property: 'OutputName', kind: 'name' } } },
  },
};

const NO_PINS: Record<string, DerivedPins> = {};
const layout = (m: Record<string, [number, number]>) =>
  Object.fromEntries(Object.entries(m).map(([k, [x, y]]) => [k, { x, y }]));

describe('graphToUET3D', () => {
  it('emits two-pass objects with params, positions, and a connection', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 'c', type: 'Constant', params: { R: 2 } },
        { id: 'm', type: 'Multiply', params: { ConstB: 3 } },
      ],
      connections: [{ from: 'c:Value', to: 'm:A' }],
    };
    const { text, warnings } = graphToUET3D(graph, layout({ c: [-100, 0], m: [100, 0] }), META, NO_PINS);
    expect(warnings).toEqual([]);
    // pass 1 declares both classes
    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionConstant Name="MaterialExpressionConstant_0"');
    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionMultiply Name="MaterialExpressionMultiply_1"');
    // pass 2 fills properties
    expect(text).toContain('R=2.0');
    expect(text).toContain('ConstB=3.0');
    expect(text).toContain('A=(Expression=MaterialExpressionConstant_0,OutputIndex=0)');
    expect(text).toContain('MaterialExpressionEditorX=100');
    expect(text).toContain('MaterialExpressionEditorY=0');
  });

  it('emits a channel-mask connection for a sub-channel output', () => {
    const META2: ExportMeta = JSON.parse(JSON.stringify(META));
    META2.nodes.TextureSampleParameter2D.outputs.R = { index: 0, mask: 'R' };
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 't', type: 'TextureSampleParameter2D', params: { SamplerType: 'Normal' } },
        { id: 'm', type: 'Multiply' },
      ],
      connections: [{ from: 't:R', to: 'm:A' }],
    };
    const { text } = graphToUET3D(graph, layout({ t: [0, 0], m: [200, 0] }), META2, NO_PINS);
    expect(text).toContain('SamplerType=SAMPLERTYPE_Normal');
    expect(text).toContain('A=(Expression=MaterialExpressionTextureSampleParameter2D_0,OutputIndex=0,Mask=1,MaskR=1,MaskG=0,MaskB=0,MaskA=0)');
  });

  it('skips MaterialOutput with a warning and drops connections into it', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 'c', type: 'Constant', params: { R: 1 } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [{ from: 'c:Value', to: 'OUT:BaseColor' }],
    };
    const { text, warnings } = graphToUET3D(graph, layout({ c: [0, 0], OUT: [300, 0] }), META, NO_PINS);
    expect(text).not.toContain('MaterialOutput');
    expect(text).not.toContain('BaseColor');
    expect(warnings.some(w => /MaterialOutput.*manually/i.test(w))).toBe(true);
  });

  it('warns and skips a node type with no metadata', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [{ id: 'x', type: 'Fresnel' }],
      connections: [],
    };
    const { text, warnings } = graphToUET3D(graph, layout({ x: [0, 0] }), META, NO_PINS);
    expect(text.trim()).toBe('');
    expect(warnings.some(w => /Fresnel.*not exportable/i.test(w))).toBe(true);
  });

  it('emits a comment box sized around its contained nodes', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [{ id: 'c', type: 'Constant', params: { R: 1 } }],
      connections: [],
      comments: [{ id: 'k', text: 'group', color: '#ff0000', contains: ['c'] }],
    };
    const { text } = graphToUET3D(graph, layout({ c: [100, 50] }), META, NO_PINS);
    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionComment');
    expect(text).toContain('Text="group"');
    expect(text).toContain('CommentColor=(R=1.0,G=0.0,B=0.0,A=1.0)');
  });

  it('emits a MaterialFunctionCall with auto-link path + warning for a local MF', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [
        { id: 'src', type: 'Constant', params: { R: 1 } },
        { id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: './blend_normals.matgraph.json' } },
      ],
      connections: [{ from: 'src:Value', to: 'mfc:BaseNormal' }],
    };
    const derived: Record<string, DerivedPins> = {
      mfc: { inputs: [{ name: 'BaseNormal', type: 'Float3' }], outputs: [{ name: 'Result', type: 'Float3' }] },
    };
    const { text, warnings } = graphToUET3D(graph, layout({ src: [0, 0], mfc: [200, 0] }), META, derived, { mfContentRoot: '/Game/' });
    expect(text).toContain("MaterialFunction=MaterialFunction'\"/Game/blend_normals.blend_normals\"'");
    expect(text).toContain('FunctionInputs(0)=(Input=(Expression=MaterialExpressionConstant_0,OutputIndex=0))');
    expect(warnings.some(w => /blend_normals.*auto-link|create.*blend_normals/i.test(w))).toBe(true);
  });

  it('passes through an engine-path MaterialFunction without a warning', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'm',
      nodes: [{ id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: '/Engine/Functions/Engine_MaterialFunctions02/Utility/Foo.Foo' } }],
      connections: [],
    };
    const { text, warnings } = graphToUET3D(graph, layout({ mfc: [0, 0] }), META, { mfc: { inputs: [], outputs: [] } });
    expect(text).toContain("MaterialFunction=MaterialFunction'\"/Engine/Functions/Engine_MaterialFunctions02/Utility/Foo.Foo\"'");
    expect(warnings).toEqual([]);
  });

  it('emits FunctionInput/FunctionOutput for an MF graph', () => {
    const graph: MatGraph = {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'MaterialFunction', name: 'fn',
      nodes: [
        { id: 'i', type: 'FunctionInput', params: { InputName: 'A', InputType: 'VectorFloat3' } },
        { id: 'o', type: 'FunctionOutput', params: { OutputName: 'Result' } },
      ],
      connections: [{ from: 'i:Input', to: 'o:Input' }],
    };
    const { text, warnings } = graphToUET3D(graph, layout({ i: [0, 0], o: [200, 0] }), META, NO_PINS);
    expect(warnings).toEqual([]);
    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionFunctionInput');
    expect(text).toContain('InputName="A"');
    expect(text).toContain('OutputName="Result"');
    expect(text).toContain('A=(Expression=MaterialExpressionFunctionInput_0,OutputIndex=0)');
  });
});

describe('parseUET3D', () => {
  it('is a stub that throws not-implemented', () => {
    expect(() => parseUET3D('anything')).toThrow(/not implemented/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd viewer && PATH="/usr/local/bin:$PATH" ./node_modules/.bin/vitest run tests/ueT3D.test.ts`
Expected: FAIL — `graphToUET3D`/`parseUET3D` not found.

- [ ] **Step 3: Implement the emitter**

`viewer/web/src/export/ueT3D.ts`:

```ts
import type { MatGraph, NodeJson, DerivedPins } from '../protocol';
import type { ExportMeta, NodeExportMeta, OutputMeta, ParamMeta } from './export-meta-types';

export interface UEExportOptions { mfContentRoot?: string; }
export interface UEExportResult { text: string; warnings: string[]; }

const I = '   '; // 3-space indent, mirroring UE

function metaFor(meta: ExportMeta, type: string): NodeExportMeta | undefined {
  return meta.nodes[type] ?? meta.reserved[type];
}

function ueClassName(ueClass: string): string {
  const dot = ueClass.lastIndexOf('.');
  return dot >= 0 ? ueClass.slice(dot + 1) : ueClass;
}

function fmtFloat(v: unknown): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '0.0';
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

function fmtParam(value: unknown, p: ParamMeta, node: NodeJson): string | null {
  switch (p.kind) {
    case 'float': return fmtFloat(value);
    case 'int': return String(Math.trunc(Number(value)));
    case 'bool': return value ? 'True' : 'False';
    case 'name':
    case 'string': return `"${String(value)}"`;
    case 'enum': return p.valueMap?.[String(value)] ?? String(value);
    case 'texture': return 'None';
    case 'vector2': case 'vector3': case 'vector4': {
      if (!p.components) return null;
      const parts = Object.entries(p.components)
        .map(([ueKey, ourParam]) => `${ueKey}=${fmtFloat(node.params?.[ourParam])}`);
      return `(${parts.join(',')})`;
    }
    default: return String(value);
  }
}

function hexToRGBA(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex ?? '').trim());
  if (!m) return '(R=0.5,G=0.5,B=0.5,A=1.0)';
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  return `(R=${fmtFloat(r)},G=${fmtFloat(g)},B=${fmtFloat(b)},A=1.0)`;
}

function maskBits(mask?: OutputMeta['mask']): string {
  if (!mask) return '';
  const on = (c: string) => (mask.includes(c) ? 1 : 0);
  return `,Mask=1,MaskR=${on('R')},MaskG=${on('G')},MaskB=${on('B')},MaskA=${on('A')}`;
}

function mfPathToAssetRef(mfRef: string, root: string): string {
  if (mfRef.startsWith('/')) return mfRef;            // engine / explicit asset path
  const base = (mfRef.split('/').pop() ?? mfRef).replace(/\.matgraph\.json$/, '');
  const clean = root.replace(/\/+$/, '');
  return `${clean}/${base}.${base}`;
}

export function graphToUET3D(
  graph: MatGraph,
  layout: Record<string, { x: number; y: number }>,
  meta: ExportMeta,
  derivedPins: Record<string, DerivedPins>,
  opts: UEExportOptions = {},
): UEExportResult {
  const warnings: string[] = [];
  const mfRoot = opts.mfContentRoot || '/Game/';
  const byId = new Map(graph.nodes.map(n => [n.id, n]));

  // Decide which nodes are emitted, and assign UE names.
  const emitted: NodeJson[] = [];
  const ueName = new Map<string, string>();
  let counter = 0;
  for (const n of graph.nodes) {
    if (n.type === 'MaterialOutput') {
      warnings.push(`MaterialOutput "${n.id}" skipped — connect final pins manually in UE.`);
      continue;
    }
    const m = metaFor(meta, n.type);
    if (!m || m.dynamicExport) {
      warnings.push(`Node "${n.id}" (type ${n.type}) not exportable yet — skipped.`);
      continue;
    }
    emitted.push(n);
    ueName.set(n.id, `${ueClassName(m.ueClass)}_${counter++}`);
  }
  const isEmitted = (id: string) => ueName.has(id);

  // Source output index/mask for a connection endpoint.
  const srcRef = (srcId: string, srcPin: string): { index: number; mask?: string } => {
    const node = byId.get(srcId);
    if (node?.type === 'MaterialFunctionCall') {
      const idx = (derivedPins[srcId]?.outputs ?? []).findIndex(o => o.name === srcPin);
      return { index: idx < 0 ? 0 : idx };
    }
    const o = node ? metaFor(meta, node.type)?.outputs?.[srcPin] : undefined;
    return { index: o?.index ?? 0, mask: o?.mask };
  };

  // Incoming connections per emitted node.
  const incoming = new Map<string, { srcId: string; srcPin: string; dstPin: string }[]>();
  for (const c of graph.connections) {
    const [srcId, srcPin] = c.from.split(':');
    const [dstId, dstPin] = c.to.split(':');
    if (!isEmitted(srcId) || !isEmitted(dstId)) continue;
    (incoming.get(dstId) ?? incoming.set(dstId, []).get(dstId)!).push({ srcId, srcPin, dstPin });
  }

  const lines: string[] = [];

  // Comment objects (declare + fill) first so they sit behind in UE.
  const comments = graph.comments ?? [];
  const commentName = new Map<string, string>();
  comments.forEach((cm, i) => commentName.set(cm.id, `MaterialExpressionComment_${i}`));

  // ---- PASS 1: declare every object ----
  for (const cm of comments) {
    lines.push(`Begin Object Class=/Script/Engine.MaterialExpressionComment Name="${commentName.get(cm.id)}"`);
    lines.push(`End Object`);
  }
  for (const n of emitted) {
    const m = metaFor(meta, n.type)!;
    lines.push(`Begin Object Class=${m.ueClass} Name="${ueName.get(n.id)}"`);
    lines.push(`End Object`);
  }

  // ---- PASS 2: fill properties ----
  for (const cm of comments) {
    const pts = cm.contains.map(id => layout[id]).filter(Boolean) as { x: number; y: number }[];
    let x = 0, y = 0, w = 400, h = 200;
    if (pts.length > 0) {
      const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x));
      const minY = Math.min(...pts.map(p => p.y)), maxY = Math.max(...pts.map(p => p.y));
      x = Math.round(minX - 40); y = Math.round(minY - 50);
      w = Math.round((maxX - minX) + 220 + 80); h = Math.round((maxY - minY) + 120 + 80);
    }
    lines.push(`Begin Object Name="${commentName.get(cm.id)}"`);
    lines.push(`${I}Text="${cm.text}"`);
    lines.push(`${I}CommentColor=${hexToRGBA(cm.color ?? '#888888')}`);
    lines.push(`${I}SizeX=${w}`);
    lines.push(`${I}SizeY=${h}`);
    lines.push(`${I}MaterialExpressionEditorX=${x}`);
    lines.push(`${I}MaterialExpressionEditorY=${y}`);
    lines.push(`End Object`);
  }

  for (const n of emitted) {
    const m = metaFor(meta, n.type)!;
    lines.push(`Begin Object Name="${ueName.get(n.id)}"`);

    // Params
    for (const [paramName, value] of Object.entries(n.params ?? {})) {
      const pm = m.params[paramName];
      if (!pm) continue;
      const formatted = fmtParam(value, pm, n);
      if (formatted === null) continue;
      lines.push(`${I}${pm.property}=${formatted}`);
    }

    // MaterialFunctionCall: function asset reference (+ auto-link warning for local MFs)
    if (n.type === 'MaterialFunctionCall') {
      const mfRef = (n.params?.MaterialFunction as string | undefined) ?? '';
      if (mfRef) {
        const assetRef = mfPathToAssetRef(mfRef, mfRoot);
        lines.push(`${I}${m.functionRefProperty ?? 'MaterialFunction'}=MaterialFunction'"${assetRef}"'`);
        if (!mfRef.startsWith('/')) {
          warnings.push(`MaterialFunctionCall "${n.id}" → create Material Function "${assetRef}" in UE for auto-link.`);
        }
      }
    }

    // Incoming connections
    for (const c of incoming.get(n.id) ?? []) {
      const { index, mask } = srcRef(c.srcId, c.srcPin);
      const ref = `Expression=${ueName.get(c.srcId)},OutputIndex=${index}${maskBits(mask)}`;
      if (n.type === 'MaterialFunctionCall') {
        const i = (derivedPins[n.id]?.inputs ?? []).findIndex(p => p.name === c.dstPin);
        lines.push(`${I}FunctionInputs(${i < 0 ? 0 : i})=(Input=(${ref}))`);
      } else {
        const inProp = m.inputs[c.dstPin]?.property;
        if (!inProp) {
          warnings.push(`Node "${n.id}" (${n.type}): input pin "${c.dstPin}" has no UE mapping — connection skipped.`);
          continue;
        }
        lines.push(`${I}${inProp}=(${ref})`);
      }
    }

    // Position
    const pos = layout[n.id] ?? { x: 0, y: 0 };
    lines.push(`${I}MaterialExpressionEditorX=${Math.round(pos.x)}`);
    lines.push(`${I}MaterialExpressionEditorY=${Math.round(pos.y)}`);
    lines.push(`End Object`);
  }

  return { text: lines.join('\n'), warnings };
}

// Import is deferred — stub only, so the signature/wiring exists.
export function parseUET3D(_text: string): MatGraph {
  throw new Error('parseUET3D not implemented (import is not supported yet)');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd viewer && PATH="/usr/local/bin:$PATH" ./node_modules/.bin/vitest run tests/ueT3D.test.ts`
Expected: PASS (all `graphToUET3D` cases + the `parseUET3D` stub).

- [ ] **Step 5: Commit**

```bash
git add viewer/web/src/export/ueT3D.ts viewer/tests/ueT3D.test.ts
git commit -m "feat(export): pure T3D emitter + golden tests"
```

---

## Task 3: Web wiring — alias, loader, export Panel

**Files:**
- Modify: `viewer/web/vite.config.ts`
- Modify: `viewer/web/src/vite-env.d.ts`
- Create: `viewer/web/src/export/export-meta.ts`
- Modify: `viewer/web/src/Graph.tsx`

- [ ] **Step 1: Add the `@export-meta` alias**

In `viewer/web/vite.config.ts`, add to `resolve.alias` (next to `@db`):

```ts
      '@export-meta': resolve(__dirname, '../../agent-pack/nodes-ue5.7.export.json'),
```

- [ ] **Step 2: Declare the module**

In `viewer/web/src/vite-env.d.ts`, after the `@db` block, add:

```ts
declare module '@export-meta' {
  const value: unknown;
  export default value;
}
```

- [ ] **Step 3: Create the loader**

`viewer/web/src/export/export-meta.ts`:

```ts
import metaJson from '@export-meta';
import type { ExportMeta } from './export-meta-types';
export const EXPORT_META: ExportMeta = metaJson as ExportMeta;
```

- [ ] **Step 4: Add the export Panel to `Graph.tsx`**

In `viewer/web/src/Graph.tsx`:

(a) Extend the imports at the top:

```ts
import { useMemo, useEffect, useState } from 'react';
import ReactFlow, { type Node, type Edge, Background, Controls, MiniMap, Panel, useNodesState } from 'reactflow';
```

(b) Add these imports with the other local imports:

```ts
import { graphToUET3D } from './export/ueT3D';
import { EXPORT_META } from './export/export-meta';
```

(c) Inside the `Graph` component, after `const edges = initialLayout.edges;`, add the export handler and toast state:

```ts
  const [mfRoot, setMfRoot] = useState(() => localStorage.getItem('ue-mf-root') || '/Game/');
  const [toast, setToast] = useState<{ msg: string; warnings: string[] } | null>(null);

  const handleExport = async () => {
    const positions: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) positions[n.id] = { x: n.position.x, y: n.position.y };
    const { text, warnings } = graphToUET3D(graph, positions, EXPORT_META, derivedPins, { mfContentRoot: mfRoot });
    const count = text ? text.split('Begin Object Class=').length - 1 : 0;
    try {
      await navigator.clipboard.writeText(text);
      const msg = graph.type === 'MaterialFunction'
        ? `Copied ${count} nodes. Create a Material Function "${graph.name}" under ${mfRoot} and paste here.`
        : `Copied ${count} nodes — paste into UE's Material Editor.`;
      setToast({ msg, warnings });
    } catch {
      setToast({ msg: 'Clipboard blocked by the browser — copy manually from the console.', warnings });
      // eslint-disable-next-line no-console
      console.log(text);
    }
    setTimeout(() => setToast(null), 8000);
  };
```

(d) Add a `<Panel>` as the first child inside `<ReactFlow>` (before `<Background />`):

```tsx
      <Panel position="top-right">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={handleExport}
              style={{ background: '#2d7d46', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: 4, cursor: 'pointer' }}>
              導出到 UE
            </button>
            <button disabled title="coming soon"
              style={{ background: '#333', color: '#888', border: 'none', padding: '6px 10px', borderRadius: 4, cursor: 'not-allowed' }}>
              導入
            </button>
          </div>
          <label style={{ color: '#aaa', fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
            MF root
            <input value={mfRoot}
              onChange={e => { setMfRoot(e.target.value); localStorage.setItem('ue-mf-root', e.target.value); }}
              style={{ width: 120, background: '#222', color: '#ddd', border: '1px solid #444', borderRadius: 3, padding: '2px 4px', fontSize: 11 }} />
          </label>
          {toast && (
            <div style={{ maxWidth: 280, background: '#222', border: '1px solid #444', borderRadius: 4, padding: 8, color: '#ddd', fontSize: 11 }}>
              <div>{toast.msg}</div>
              {toast.warnings.length > 0 && (
                <ul style={{ margin: '6px 0 0', paddingLeft: 16, color: '#e0b050' }}>
                  {toast.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      </Panel>
```

- [ ] **Step 5: Typecheck + build the web bundle**

The web `build` script is `tsc -b && vite build`, so this both typechecks (catches any
`Graph.tsx` type error — Graph is not covered by vitest) and bundles:

Run: `cd viewer/web && PATH="/usr/local/bin:$PATH" ./node_modules/.bin/tsc -b && ./node_modules/.bin/vite build`
Expected: `tsc -b` reports no errors and `vite build` writes `dist/` successfully.

- [ ] **Step 6: Manual smoke test**

Rebuild the server bundle and restart, then verify in the browser the open material shows a green **導出到 UE** button; clicking it shows the toast and (for `multilayer_blend`) lists the per-MF auto-link warnings.

```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
PATH="/usr/local/bin:$PATH" ./viewer/node_modules/.bin/tsc -p viewer/tsconfig.json   # server bundle (unchanged here, harmless)
# restart the viewer if running, then open http://localhost:5790
```

Confirm the clipboard text begins with `Begin Object Class=/Script/Engine.MaterialExpression…`. (Paste-into-UE verification happens after Codex fills/verifies the metadata.)

- [ ] **Step 7: Commit**

```bash
git add viewer/web/vite.config.ts viewer/web/src/vite-env.d.ts viewer/web/src/export/export-meta.ts viewer/web/src/Graph.tsx
git commit -m "feat(export): @export-meta alias, loader, and export Panel in the graph view"
```

---

## Task 4: Codex hand-off prompt + SPEC note

**Files:**
- Create: `docs/superpowers/specs/2026-05-29-ue-clipboard-export-codex-prompt.md`
- Modify: `agent-pack/SPEC.md`

- [ ] **Step 1: Write the Codex prompt doc**

Create `docs/superpowers/specs/2026-05-29-ue-clipboard-export-codex-prompt.md` with this content:

```markdown
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
```

- [ ] **Step 2: Add the SPEC.md note**

In `agent-pack/SPEC.md`, under the Hard rules section's rule 7 (`MaterialFunctionCall.params.MaterialFunction`), append this paragraph:

```markdown
   - For **UE clipboard export**, this path may also be a UE engine asset path
     (e.g. `/Engine/Functions/...`) to reference a built-in Material Function; such references
     paste resolved but cannot be previewed in the viewer. For local MFs, export uses an
     auto-link convention: create the MF in UE under the configured MF content root (default
     `/Game/`) with the JSON's base name, and a pasted parent material auto-links its calls.
     Positions (`x`/`y`) remain forbidden in the JSON — export synthesizes them from layout.
```

- [ ] **Step 3: Run the full suite**

Run: `cd viewer && PATH="/usr/local/bin:$PATH" ./node_modules/.bin/vitest run`
Expected: all tests pass (existing 39 + export-meta + ueT3D).

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-05-29-ue-clipboard-export-codex-prompt.md agent-pack/SPEC.md
git commit -m "docs(export): Codex metadata prompt + SPEC engine-path/auto-link note"
```

---

## Self-Review notes (for the implementer)

- The emitter never imports `@export-meta`; only `export-meta.ts` does. Keep it that way so
  `viewer/tests/ueT3D.test.ts` (which imports the emitter) runs without the vite alias.
- `graphToUET3D` signature is `(graph, layout, meta, derivedPins, opts?)` — `derivedPins` is the
  4th positional arg in every call (tests, Panel). Do not reorder.
- Node count in the toast is derived by counting `Begin Object Class=` occurrences — comments
  count too; that is acceptable for a status toast.
- `Lerp` (our type) maps to UE class `MaterialExpressionLinearInterpolate`.
- All hand-authored metadata is `verified:false` until Codex confirms; that is expected and the
  integrity test does not assert `verified`.
```

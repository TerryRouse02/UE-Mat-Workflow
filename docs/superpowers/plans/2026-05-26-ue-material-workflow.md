# UE Material Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified workflow that lets AI agents output UE5.7 material node graphs as `.matgraph.json` files, viewed live in a local React browser app with auto-layout, Material Function navigation, and standalone HTML export.

**Architecture:** Two top-level pieces in a single repo. `agent-pack/` is plain text (SPEC, node DB, examples, per-CLI entry files) consumed by AI. `viewer/` is a Node http+ws server (built with Node's built-in http + the `ws` library + `chokidar`) that watches `graphs/`, serves a Vite-built React+ReactFlow UI, runs dagre auto-layout, and supports HTML export. AI writes files → server detects → WebSocket pushes → UI re-renders.

**Tech Stack:** Node 18+, TypeScript, React 18, Vite, React Flow, dagre, ws, chokidar, Ajv (dev only), Vitest, pnpm workspaces.

**Spec reference:** All section numbers (§1–§12) below refer to `docs/superpowers/specs/2026-05-26-ue-material-workflow-design.md`.

---

## Phase 0 — Repo Foundation

### Task 1: Initialize repo, workspace, base config

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `README.md`
- Create: `graphs/.gitkeep`
- Create: `agent-pack/.gitkeep` (placeholder, real files in Phase 1)
- Create: `viewer/.gitkeep` (placeholder)

- [ ] **Step 1: git init and create root package.json**

```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
git init
```

Create `package.json`:
```json
{
  "name": "ue-mat-workflow",
  "version": "0.1.0",
  "private": true,
  "engines": { "node": ">=18" },
  "packageManager": "pnpm@9.0.0",
  "scripts": {
    "build": "pnpm --filter viewer build",
    "test": "pnpm -r test",
    "start": "pnpm --filter viewer start"
  }
}
```

- [ ] **Step 2: Workspace + tsconfig + .gitignore**

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'viewer'
  - 'viewer/web'
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
*.log
.DS_Store
.vite/
coverage/
```

- [ ] **Step 3: Stub README + empty dirs**

`README.md`:
```markdown
# UE Material Workflow

AI 與人協作 UE5.7 材質節點圖的統一工作流。設計：`docs/superpowers/specs/2026-05-26-ue-material-workflow-design.md`。

## Quick Start
```bash
pnpm install
pnpm --filter viewer build
pnpm start
```

Browser opens `http://localhost:5790`. AI 對話時 Write `graphs/<name>.matgraph.json` 即時呈現。
```

```bash
mkdir -p graphs agent-pack viewer
touch graphs/.gitkeep agent-pack/.gitkeep viewer/.gitkeep
```

- [ ] **Step 4: Commit**

```bash
git add .
git commit -m "chore: initialize workspace skeleton"
```

---

### Task 2: Define shared TypeScript types for `.matgraph.json`

**Files:**
- Create: `viewer/server/types.ts`

This is shared by server + tests + (later) the web bundle via path import.

- [ ] **Step 1: Write the failing test**

Create `viewer/tests/types.test.ts`:
```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type { MatGraph, Node, Connection, Comment } from '../server/types';

describe('MatGraph types', () => {
  it('Material graph compiles', () => {
    const g: MatGraph = {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      type: 'Material',
      name: 'x',
      nodes: [{ id: 'n1', type: 'Multiply', params: { ConstB: 0.5 } }],
      connections: [{ from: 'n1:Result', to: 'OUT:BaseColor' }],
      comments: [],
    };
    expectTypeOf(g).toMatchTypeOf<MatGraph>();
  });
});
```

- [ ] **Step 2: Verify it fails**

```bash
cd viewer && pnpm vitest run tests/types.test.ts
```
Expected: fails — `server/types` not found.

- [ ] **Step 3: Implement types**

Create `viewer/server/types.ts`:
```typescript
export type GraphType = 'Material' | 'MaterialFunction';

export interface Node {
  id: string;
  type: string;
  params?: Record<string, unknown>;
}

export interface Connection {
  from: string; // "<nodeId>:<pinName>"
  to: string;
}

export interface Comment {
  id: string;
  text: string;
  color?: string;
  contains: string[]; // node ids
}

export interface MatGraph {
  schemaVersion: string;
  ueVersion: string;
  type: GraphType;
  name: string;
  description?: string;
  nodes: Node[];
  connections: Connection[];
  comments?: Comment[];
}
```

- [ ] **Step 4: Verify pass**

```bash
pnpm vitest run tests/types.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add viewer/server/types.ts viewer/tests/types.test.ts
git commit -m "feat: define MatGraph TypeScript types"
```

---

### Task 3: Define node DB types

**Files:**
- Create: `viewer/server/db-types.ts`

- [ ] **Step 1: Write failing test**

`viewer/tests/db-types.test.ts`:
```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type { NodeDB, NodeDef, PinDef, ParamDef } from '../server/db-types';

describe('NodeDB types', () => {
  it('valid DB compiles', () => {
    const db: NodeDB = {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      generatedAt: '2026-05-26',
      source: 'manual',
      reservedTypes: ['MaterialOutput', 'FunctionInput', 'FunctionOutput', 'MaterialFunctionCall'],
      nodes: {
        Multiply: {
          category: 'Math',
          description: '',
          inputs: [{ name: 'A', type: 'Float1|2|3|4', required: true }],
          outputs: [{ name: 'Result', type: 'matchInput' }],
          params: [{ name: 'ConstB', type: 'Float', default: 1, when: 'B unconnected' }],
          verified: true,
        },
      },
    };
    expectTypeOf(db).toMatchTypeOf<NodeDB>();
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
pnpm vitest run tests/db-types.test.ts
```

- [ ] **Step 3: Implement**

`viewer/server/db-types.ts`:
```typescript
export interface PinDef {
  name: string;
  type: string; // free-form: "Float1|2|3|4", "Float3", "Texture2D", "matchInput"
  required?: boolean;
}

export interface ParamDef {
  name: string;
  type: string; // "Float", "Name", "Enum", "TextureRef", ...
  default?: unknown;
  values?: string[]; // for Enum
  required?: boolean;
  when?: string; // human-readable condition like "A unconnected"
}

export interface NodeDef {
  category: string;
  description: string;
  inputs: PinDef[];
  outputs: PinDef[];
  params?: ParamDef[];
  verified: boolean;
}

export interface NodeDB {
  schemaVersion: string;
  ueVersion: string;
  generatedAt: string;
  source: string;
  nodes: Record<string, NodeDef>;
  reservedTypes: string[];
}
```

- [ ] **Step 4: Verify pass**

- [ ] **Step 5: Commit**

```bash
git add viewer/server/db-types.ts viewer/tests/db-types.test.ts
git commit -m "feat: define NodeDB TypeScript types"
```

---

### Task 4: Set up viewer package + Vitest

**Files:**
- Create: `viewer/package.json`
- Create: `viewer/tsconfig.json`
- Create: `viewer/vitest.config.ts`

- [ ] **Step 1: Create viewer package.json**

```json
{
  "name": "viewer",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "ue-mat-viewer": "./bin/ue-mat-viewer" },
  "scripts": {
    "test": "vitest run",
    "build": "tsc -p tsconfig.json && pnpm --filter web build",
    "start": "node dist/server/index.js"
  },
  "dependencies": {
    "ws": "^8.18.0",
    "chokidar": "^4.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^2.0.0",
    "ajv": "^8.17.0",
    "@types/node": "^20.0.0",
    "@types/ws": "^8.5.0"
  }
}
```

- [ ] **Step 2: tsconfig + vitest config**

`viewer/tsconfig.json`:
```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["server/**/*.ts", "bin/**/*.ts"],
  "exclude": ["dist", "node_modules", "web", "tests"]
}
```

`viewer/vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
});
```

- [ ] **Step 3: Install and verify**

```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
pnpm install
cd viewer && pnpm vitest run
```
Expected: tests from Tasks 2/3 pass.

- [ ] **Step 4: Commit**

```bash
git add viewer/package.json viewer/tsconfig.json viewer/vitest.config.ts pnpm-lock.yaml
git commit -m "chore: set up viewer package with vitest"
```

---

## Phase 1 — agent-pack

### Task 5: Seed `nodes-ue5.7.json` with structure + 10 entries

**Files:**
- Create: `agent-pack/nodes-ue5.7.json`

- [ ] **Step 1: Write the file**

Write `agent-pack/nodes-ue5.7.json`:
```json
{
  "schemaVersion": "1.0",
  "ueVersion": "5.7",
  "generatedAt": "2026-05-26",
  "source": "manual seed; expand from https://dev.epicgames.com/documentation/en-us/unreal-engine/material-expression-reference",
  "reservedTypes": ["MaterialOutput", "FunctionInput", "FunctionOutput", "MaterialFunctionCall"],
  "nodes": {
    "Multiply": {
      "category": "Math",
      "description": "Multiplies two values component-wise. Unconnected pins use ConstA/ConstB.",
      "inputs": [
        { "name": "A", "type": "Float1|2|3|4", "required": true },
        { "name": "B", "type": "Float1|2|3|4", "required": false }
      ],
      "outputs": [{ "name": "Result", "type": "matchInput" }],
      "params": [
        { "name": "ConstA", "type": "Float", "default": 0, "when": "A unconnected" },
        { "name": "ConstB", "type": "Float", "default": 1, "when": "B unconnected" }
      ],
      "verified": true
    },
    "Add": {
      "category": "Math",
      "description": "Adds two values.",
      "inputs": [
        { "name": "A", "type": "Float1|2|3|4", "required": true },
        { "name": "B", "type": "Float1|2|3|4", "required": false }
      ],
      "outputs": [{ "name": "Result", "type": "matchInput" }],
      "params": [
        { "name": "ConstA", "type": "Float", "default": 0, "when": "A unconnected" },
        { "name": "ConstB", "type": "Float", "default": 0, "when": "B unconnected" }
      ],
      "verified": true
    },
    "OneMinus": {
      "category": "Math",
      "description": "Returns 1 - input.",
      "inputs": [{ "name": "Input", "type": "Float1|2|3|4", "required": true }],
      "outputs": [{ "name": "Result", "type": "matchInput" }],
      "verified": true
    },
    "Lerp": {
      "category": "Math",
      "description": "Linear interpolation: lerp(A, B, Alpha).",
      "inputs": [
        { "name": "A", "type": "Float1|2|3|4", "required": true },
        { "name": "B", "type": "Float1|2|3|4", "required": true },
        { "name": "Alpha", "type": "Float1", "required": false }
      ],
      "outputs": [{ "name": "Result", "type": "matchInput" }],
      "params": [{ "name": "ConstAlpha", "type": "Float", "default": 0, "when": "Alpha unconnected" }],
      "verified": true
    },
    "Saturate": {
      "category": "Math",
      "description": "Clamps input to [0,1].",
      "inputs": [{ "name": "Input", "type": "Float1|2|3|4", "required": true }],
      "outputs": [{ "name": "Result", "type": "matchInput" }],
      "verified": true
    },
    "TextureSampleParameter2D": {
      "category": "Texture",
      "description": "Samples a 2D texture exposed as a Material Parameter.",
      "inputs": [
        { "name": "UVs", "type": "Float2", "required": false },
        { "name": "Tex", "type": "Texture2D", "required": false }
      ],
      "outputs": [
        { "name": "RGB", "type": "Float3" },
        { "name": "R", "type": "Float1" },
        { "name": "G", "type": "Float1" },
        { "name": "B", "type": "Float1" },
        { "name": "A", "type": "Float1" },
        { "name": "RGBA", "type": "Float4" }
      ],
      "params": [
        { "name": "ParameterName", "type": "Name", "required": true },
        { "name": "Texture", "type": "TextureRef" },
        { "name": "SamplerType", "type": "Enum", "values": ["Color", "Grayscale", "Normal", "Alpha", "Masks"] }
      ],
      "verified": true
    },
    "TextureCoordinate": {
      "category": "Coordinates",
      "description": "Outputs the UV coordinates of the surface.",
      "inputs": [],
      "outputs": [{ "name": "UVs", "type": "Float2" }],
      "params": [
        { "name": "CoordinateIndex", "type": "Int", "default": 0 },
        { "name": "UTiling", "type": "Float", "default": 1.0 },
        { "name": "VTiling", "type": "Float", "default": 1.0 }
      ],
      "verified": true
    },
    "Constant3Vector": {
      "category": "Constants",
      "description": "A constant RGB vector.",
      "inputs": [],
      "outputs": [
        { "name": "RGB", "type": "Float3" },
        { "name": "R", "type": "Float1" },
        { "name": "G", "type": "Float1" },
        { "name": "B", "type": "Float1" }
      ],
      "params": [
        { "name": "R", "type": "Float", "default": 0 },
        { "name": "G", "type": "Float", "default": 0 },
        { "name": "B", "type": "Float", "default": 0 }
      ],
      "verified": true
    },
    "ScalarParameter": {
      "category": "Parameters",
      "description": "A scalar value exposed as a Material Parameter.",
      "inputs": [],
      "outputs": [{ "name": "Value", "type": "Float1" }],
      "params": [
        { "name": "ParameterName", "type": "Name", "required": true },
        { "name": "DefaultValue", "type": "Float", "default": 0 }
      ],
      "verified": true
    },
    "BlendAngleCorrectedNormals": {
      "category": "Vector",
      "description": "Blends two tangent-space normals while preserving angle.",
      "inputs": [
        { "name": "BaseNormal", "type": "Float3", "required": true },
        { "name": "AdditionalNormal", "type": "Float3", "required": true }
      ],
      "outputs": [{ "name": "Result", "type": "Float3" }],
      "verified": true
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add agent-pack/nodes-ue5.7.json
git commit -m "feat: seed nodes-ue5.7.json with 10 common nodes"
```

---

### Task 6: Validate the seed DB

**Files:**
- Create: `viewer/tests/db.test.ts`
- Create: `viewer/server/db-loader.ts`

- [ ] **Step 1: Write the failing test**

`viewer/tests/db.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDB, validateDB } from '../server/db-loader';

const DB_PATH = resolve(__dirname, '../../agent-pack/nodes-ue5.7.json');

describe('db-loader', () => {
  it('loads the seed DB without errors', () => {
    const db = loadDB(DB_PATH);
    expect(db.ueVersion).toBe('5.7');
    expect(Object.keys(db.nodes).length).toBeGreaterThanOrEqual(10);
  });

  it('every node has at least one output', () => {
    const db = loadDB(DB_PATH);
    for (const [name, def] of Object.entries(db.nodes)) {
      expect(def.outputs.length, `${name} must have outputs`).toBeGreaterThan(0);
    }
  });

  it('validateDB rejects DB with duplicate pin names', () => {
    const bad = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
    bad.nodes.Multiply.inputs.push({ name: 'A', type: 'Float1', required: false });
    expect(() => validateDB(bad)).toThrow(/duplicate pin/i);
  });

  it('validateDB rejects when a node has no outputs', () => {
    const bad = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
    bad.nodes.Multiply.outputs = [];
    expect(() => validateDB(bad)).toThrow(/no outputs/i);
  });
});
```

- [ ] **Step 2: Verify fail**

```bash
cd viewer && pnpm vitest run tests/db.test.ts
```

- [ ] **Step 3: Implement db-loader**

`viewer/server/db-loader.ts`:
```typescript
import { readFileSync } from 'node:fs';
import type { NodeDB } from './db-types.js';

export function loadDB(path: string): NodeDB {
  const raw = readFileSync(path, 'utf-8');
  const db = JSON.parse(raw) as NodeDB;
  validateDB(db);
  return db;
}

export function validateDB(db: NodeDB): void {
  if (!db.nodes || typeof db.nodes !== 'object') {
    throw new Error('DB.nodes missing');
  }
  for (const [name, def] of Object.entries(db.nodes)) {
    if (!def.outputs || def.outputs.length === 0) {
      throw new Error(`Node "${name}" has no outputs`);
    }
    assertUniquePinNames(name, 'inputs', def.inputs ?? []);
    assertUniquePinNames(name, 'outputs', def.outputs);
  }
}

function assertUniquePinNames(node: string, side: string, pins: { name: string }[]): void {
  const seen = new Set<string>();
  for (const p of pins) {
    if (seen.has(p.name)) {
      throw new Error(`duplicate pin "${p.name}" on ${node}.${side}`);
    }
    seen.add(p.name);
  }
}
```

- [ ] **Step 4: Verify pass**

```bash
pnpm vitest run tests/db.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add viewer/server/db-loader.ts viewer/tests/db.test.ts
git commit -m "feat: db-loader with validation"
```

---

### Task 7: Write 2 example .matgraph.json + validate them

**Files:**
- Create: `agent-pack/examples/01_basic_pbr.matgraph.json`
- Create: `agent-pack/examples/02_with_function.matgraph.json`
- Create: `agent-pack/examples/functions/blend_normals.matgraph.json`

- [ ] **Step 1: Write 01_basic_pbr**

```json
{
  "schemaVersion": "1.0",
  "ueVersion": "5.7",
  "type": "Material",
  "name": "01_basic_pbr",
  "description": "Minimum PBR: a base color parameter wired to the output.",
  "nodes": [
    { "id": "tex",  "type": "TextureSampleParameter2D",
      "params": { "ParameterName": "BaseColorMap", "SamplerType": "Color" } },
    { "id": "tint", "type": "Constant3Vector",
      "params": { "R": 1.0, "G": 0.95, "B": 0.9 } },
    { "id": "mul",  "type": "Multiply" },
    { "id": "rough","type": "ScalarParameter",
      "params": { "ParameterName": "Roughness", "DefaultValue": 0.5 } },
    { "id": "OUT",  "type": "MaterialOutput" }
  ],
  "connections": [
    { "from": "tex:RGB",   "to": "mul:A" },
    { "from": "tint:RGB",  "to": "mul:B" },
    { "from": "mul:Result","to": "OUT:BaseColor" },
    { "from": "rough:Value","to": "OUT:Roughness" }
  ],
  "comments": [
    { "id": "c1", "text": "Base Color Tinting", "color": "#4a90e2", "contains": ["tex","tint","mul"] }
  ]
}
```

- [ ] **Step 2: Write 02_with_function + its function**

`agent-pack/examples/functions/blend_normals.matgraph.json`:
```json
{
  "schemaVersion": "1.0",
  "ueVersion": "5.7",
  "type": "MaterialFunction",
  "name": "blend_normals",
  "nodes": [
    { "id": "in_a",  "type": "FunctionInput",
      "params": { "InputName": "BaseNormal", "InputType": "VectorFloat3" } },
    { "id": "in_b",  "type": "FunctionInput",
      "params": { "InputName": "DetailNormal", "InputType": "VectorFloat3" } },
    { "id": "blend", "type": "BlendAngleCorrectedNormals" },
    { "id": "out",   "type": "FunctionOutput",
      "params": { "OutputName": "Result" } }
  ],
  "connections": [
    { "from": "in_a:Input",     "to": "blend:BaseNormal" },
    { "from": "in_b:Input",     "to": "blend:AdditionalNormal" },
    { "from": "blend:Result",   "to": "out:Input" }
  ]
}
```

Note: `FunctionInput` and `FunctionOutput` expose a single pin called `Input` / `Output` for wiring within the function graph; viewer treats this as built-in.

`agent-pack/examples/02_with_function.matgraph.json`:
```json
{
  "schemaVersion": "1.0",
  "ueVersion": "5.7",
  "type": "Material",
  "name": "02_with_function",
  "description": "Uses a MaterialFunction to blend two normals.",
  "nodes": [
    { "id": "n_base",  "type": "TextureSampleParameter2D",
      "params": { "ParameterName": "BaseNormal", "SamplerType": "Normal" } },
    { "id": "n_det",   "type": "TextureSampleParameter2D",
      "params": { "ParameterName": "DetailNormal", "SamplerType": "Normal" } },
    { "id": "blendfn", "type": "MaterialFunctionCall",
      "params": { "MaterialFunction": "./functions/blend_normals.matgraph.json" } },
    { "id": "OUT",     "type": "MaterialOutput" }
  ],
  "connections": [
    { "from": "n_base:RGB",  "to": "blendfn:BaseNormal" },
    { "from": "n_det:RGB",   "to": "blendfn:DetailNormal" },
    { "from": "blendfn:Result","to": "OUT:Normal" }
  ]
}
```

- [ ] **Step 3: Commit**

```bash
git add agent-pack/examples/
git commit -m "docs: add 2 example matgraphs (basic PBR + MF blend)"
```

---

### Task 8: Schema validator (runtime, minimal)

**Files:**
- Create: `viewer/server/schema.ts`
- Create: `viewer/tests/schema.test.ts`

- [ ] **Step 1: Write failing test**

`viewer/tests/schema.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateGraph } from '../server/schema';

function loadJson(rel: string) {
  return JSON.parse(readFileSync(resolve(__dirname, '..', '..', rel), 'utf-8'));
}

describe('validateGraph', () => {
  it('accepts the basic PBR example', () => {
    const g = loadJson('agent-pack/examples/01_basic_pbr.matgraph.json');
    expect(validateGraph(g).errors).toEqual([]);
  });

  it('accepts the with-function example', () => {
    const g = loadJson('agent-pack/examples/02_with_function.matgraph.json');
    expect(validateGraph(g).errors).toEqual([]);
  });

  it('rejects missing schemaVersion', () => {
    const r = validateGraph({ ueVersion: '5.7', type: 'Material', name: 'x', nodes: [], connections: [] });
    expect(r.errors.some(e => /schemaVersion/.test(e))).toBe(true);
  });

  it('rejects connection format without colon', () => {
    const r = validateGraph({
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'x',
      nodes: [{ id: 'a', type: 'X' }],
      connections: [{ from: 'a-Result', to: 'b:Input' }],
    });
    expect(r.errors.some(e => /from/.test(e))).toBe(true);
  });

  it('rejects duplicate node ids', () => {
    const r = validateGraph({
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'x',
      nodes: [{ id: 'a', type: 'X' }, { id: 'a', type: 'Y' }],
      connections: [],
    });
    expect(r.errors.some(e => /duplicate node id/i.test(e))).toBe(true);
  });

  it('rejects connection referencing unknown node', () => {
    const r = validateGraph({
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'x',
      nodes: [{ id: 'a', type: 'X' }],
      connections: [{ from: 'a:R', to: 'ghost:Input' }],
    });
    expect(r.errors.some(e => /ghost/.test(e))).toBe(true);
  });
});
```

- [ ] **Step 2: Verify fail**

- [ ] **Step 3: Implement validator**

`viewer/server/schema.ts`:
```typescript
import type { MatGraph } from './types.js';

export interface ValidationResult {
  errors: string[];
  graph: MatGraph | null;
}

const REQUIRED_TOP: (keyof MatGraph)[] = ['schemaVersion', 'ueVersion', 'type', 'name', 'nodes', 'connections'];

export function validateGraph(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null) {
    return { errors: ['root must be an object'], graph: null };
  }
  const g = input as Record<string, unknown>;

  for (const k of REQUIRED_TOP) {
    if (!(k in g)) errors.push(`missing required field: ${k}`);
  }
  if (g.type !== 'Material' && g.type !== 'MaterialFunction') {
    errors.push(`type must be "Material" or "MaterialFunction"`);
  }

  const nodes = Array.isArray(g.nodes) ? (g.nodes as { id: unknown; type: unknown }[]) : [];
  const ids = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (typeof n.id !== 'string') { errors.push(`nodes[${i}].id must be string`); continue; }
    if (typeof n.type !== 'string') { errors.push(`nodes[${i}].type must be string`); continue; }
    if (ids.has(n.id)) errors.push(`duplicate node id: ${n.id}`);
    ids.add(n.id);
  }

  const conns = Array.isArray(g.connections) ? (g.connections as { from: unknown; to: unknown }[]) : [];
  for (let i = 0; i < conns.length; i++) {
    const c = conns[i];
    const checkEnd = (label: 'from' | 'to', v: unknown) => {
      if (typeof v !== 'string' || !v.includes(':')) {
        errors.push(`connections[${i}].${label} must be "nodeId:pinName"`);
        return null;
      }
      const [nodeId] = v.split(':');
      if (!ids.has(nodeId)) errors.push(`connections[${i}].${label} references unknown node: ${nodeId}`);
      return nodeId;
    };
    checkEnd('from', c.from);
    checkEnd('to', c.to);
  }

  return { errors, graph: errors.length === 0 ? (input as MatGraph) : null };
}
```

- [ ] **Step 4: Verify pass**

- [ ] **Step 5: Commit**

```bash
git add viewer/server/schema.ts viewer/tests/schema.test.ts
git commit -m "feat: minimal runtime schema validator"
```

---

### Task 9: Write SPEC.md (AI 規範書)

**Files:**
- Create: `agent-pack/SPEC.md`

- [ ] **Step 1: Write SPEC.md**

```markdown
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

7. **`MaterialFunctionCall.params.MaterialFunction`** is a path relative to `graphs/`, e.g. `"./functions/blend_normals.matgraph.json"`.

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
```

- [ ] **Step 2: Commit**

```bash
git add agent-pack/SPEC.md
git commit -m "docs: write AI SPEC.md"
```

---

### Task 10: Per-CLI entry files

**Files:**
- Create: `agent-pack/CLAUDE.md`
- Create: `agent-pack/AGENTS.md`
- Create: `agent-pack/.cursorrules`
- Create: `agent-pack/GEMINI.md`

- [ ] **Step 1: Write entry files (all delegate to SPEC.md + DB)**

`agent-pack/CLAUDE.md`:
```markdown
# UE Material Workflow

When asked to design or modify a UE5 material, follow the spec:

@SPEC.md
@nodes-ue5.7.json

Examples: @examples/01_basic_pbr.matgraph.json, @examples/02_with_function.matgraph.json

Write output files to `graphs/` (or `graphs/functions/` for MaterialFunctions).
```

`agent-pack/AGENTS.md`:
```markdown
# UE Material Workflow

For UE5 material work: read `agent-pack/SPEC.md` and `agent-pack/nodes-ue5.7.json` before writing any `.matgraph.json` file.

Output location: `graphs/<name>.matgraph.json` for Materials, `graphs/functions/<name>.matgraph.json` for MaterialFunctions.

Examples in `agent-pack/examples/`.
```

`agent-pack/.cursorrules`:
```
For UE5 material work, follow agent-pack/SPEC.md and only use node types from agent-pack/nodes-ue5.7.json (plus the reserved types MaterialOutput/FunctionInput/FunctionOutput/MaterialFunctionCall). Write Materials to graphs/<name>.matgraph.json and MaterialFunctions to graphs/functions/<name>.matgraph.json. Connections use "node:pin" strings. Never write x/y positions.
```

`agent-pack/GEMINI.md`:
```markdown
# UE Material Workflow

For UE5 material tasks: read `agent-pack/SPEC.md` and `agent-pack/nodes-ue5.7.json` first. Write `.matgraph.json` files to `graphs/` per the spec.
```

- [ ] **Step 2: Commit**

```bash
git add agent-pack/CLAUDE.md agent-pack/AGENTS.md agent-pack/.cursorrules agent-pack/GEMINI.md
git commit -m "docs: per-CLI entry files pointing to SPEC.md"
```

---

## Phase 2 — Viewer Server Core

### Task 11: Graph loader (file path → validated MatGraph or errors)

**Files:**
- Create: `viewer/server/graph-loader.ts`
- Create: `viewer/tests/graph-loader.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { loadGraph } from '../server/graph-loader';

const REPO = resolve(__dirname, '..', '..');

describe('loadGraph', () => {
  it('loads a valid example', async () => {
    const r = await loadGraph(resolve(REPO, 'agent-pack/examples/01_basic_pbr.matgraph.json'));
    expect(r.errors).toEqual([]);
    expect(r.graph?.name).toBe('01_basic_pbr');
  });

  it('returns errors for missing file', async () => {
    const r = await loadGraph(resolve(REPO, 'graphs/nonexistent.matgraph.json'));
    expect(r.errors[0]).toMatch(/not found/i);
    expect(r.graph).toBe(null);
  });

  it('returns errors for malformed JSON', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(resolve(tmpdir(), 'mat-'));
    const p = resolve(dir, 'bad.matgraph.json');
    writeFileSync(p, '{bad json');
    const r = await loadGraph(p);
    expect(r.errors[0]).toMatch(/JSON/);
  });
});
```

- [ ] **Step 2: Verify fail**

- [ ] **Step 3: Implement loader**

`viewer/server/graph-loader.ts`:
```typescript
import { readFile } from 'node:fs/promises';
import type { ValidationResult } from './schema.js';
import { validateGraph } from './schema.js';

export async function loadGraph(path: string): Promise<ValidationResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { errors: [`file not found: ${path}`], graph: null };
    return { errors: [`read error: ${(e as Error).message}`], graph: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { errors: [`invalid JSON: ${(e as Error).message}`], graph: null };
  }
  return validateGraph(parsed);
}
```

- [ ] **Step 4: Verify pass**

- [ ] **Step 5: Commit**

```bash
git add viewer/server/graph-loader.ts viewer/tests/graph-loader.test.ts
git commit -m "feat: graph-loader (file → validated MatGraph)"
```

---

### Task 12: MaterialFunction resolver with circular detection

**Files:**
- Create: `viewer/server/mf-resolver.ts`
- Create: `viewer/tests/mf-resolver.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolveMaterialFunctions } from '../server/mf-resolver';
import { loadGraph } from '../server/graph-loader';

function makeRepo() {
  const root = mkdtempSync(resolve(tmpdir(), 'mfres-'));
  mkdirSync(resolve(root, 'functions'), { recursive: true });
  return root;
}

function write(p: string, obj: unknown) { writeFileSync(p, JSON.stringify(obj, null, 2)); }

describe('resolveMaterialFunctions', () => {
  it('derives MFC pins from the referenced function', async () => {
    const root = makeRepo();
    write(resolve(root, 'functions/foo.matgraph.json'), {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'MaterialFunction', name: 'foo',
      nodes: [
        { id: 'i', type: 'FunctionInput',  params: { InputName: 'A' } },
        { id: 'o', type: 'FunctionOutput', params: { OutputName: 'R' } },
      ],
      connections: [{ from: 'i:Input', to: 'o:Input' }],
    });
    write(resolve(root, 'main.matgraph.json'), {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'main',
      nodes: [
        { id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: './functions/foo.matgraph.json' } },
        { id: 'OUT', type: 'MaterialOutput' },
      ],
      connections: [{ from: 'mfc:R', to: 'OUT:BaseColor' }],
    });
    const r = await loadGraph(resolve(root, 'main.matgraph.json'));
    const resolved = await resolveMaterialFunctions(r.graph!, root);
    expect(resolved.derivedPins['mfc']).toEqual({
      inputs: [{ name: 'A', type: 'Float3' }],
      outputs: [{ name: 'R', type: 'Float3' }],
    });
    expect(resolved.warnings).toEqual([]);
  });

  it('warns when MF file is missing', async () => {
    const root = makeRepo();
    write(resolve(root, 'main.matgraph.json'), {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'main',
      nodes: [{ id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: './ghost.matgraph.json' } }],
      connections: [],
    });
    const r = await loadGraph(resolve(root, 'main.matgraph.json'));
    const resolved = await resolveMaterialFunctions(r.graph!, root);
    expect(resolved.warnings[0]).toMatch(/not found/i);
    expect(resolved.derivedPins['mfc']).toEqual({ inputs: [], outputs: [] });
  });

  it('detects circular references', async () => {
    const root = makeRepo();
    write(resolve(root, 'functions/a.matgraph.json'), {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'MaterialFunction', name: 'a',
      nodes: [
        { id: 'in', type: 'FunctionInput', params: { InputName: 'X' } },
        { id: 'call', type: 'MaterialFunctionCall', params: { MaterialFunction: './b.matgraph.json' } },
        { id: 'out', type: 'FunctionOutput', params: { OutputName: 'Y' } },
      ],
      connections: [],
    });
    write(resolve(root, 'functions/b.matgraph.json'), {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'MaterialFunction', name: 'b',
      nodes: [
        { id: 'in', type: 'FunctionInput', params: { InputName: 'X' } },
        { id: 'call', type: 'MaterialFunctionCall', params: { MaterialFunction: './a.matgraph.json' } },
        { id: 'out', type: 'FunctionOutput', params: { OutputName: 'Y' } },
      ],
      connections: [],
    });
    write(resolve(root, 'main.matgraph.json'), {
      schemaVersion: '1.0', ueVersion: '5.7', type: 'Material', name: 'main',
      nodes: [{ id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: './functions/a.matgraph.json' } }],
      connections: [],
    });
    const r = await loadGraph(resolve(root, 'main.matgraph.json'));
    const resolved = await resolveMaterialFunctions(r.graph!, root);
    expect(resolved.warnings.some(w => /circular/i.test(w))).toBe(true);
  });
});
```

- [ ] **Step 2: Verify fail**

- [ ] **Step 3: Implement resolver**

`viewer/server/mf-resolver.ts`:
```typescript
import { resolve, dirname } from 'node:path';
import type { MatGraph } from './types.js';
import { loadGraph } from './graph-loader.js';

export interface DerivedPins {
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
}

export interface ResolvedGraph {
  graph: MatGraph;
  derivedPins: Record<string, DerivedPins>; // mfcNodeId → pins
  warnings: string[];
}

export async function resolveMaterialFunctions(
  graph: MatGraph,
  graphsRoot: string,
  visited: Set<string> = new Set(),
): Promise<ResolvedGraph> {
  const derivedPins: Record<string, DerivedPins> = {};
  const warnings: string[] = [];

  for (const node of graph.nodes) {
    if (node.type !== 'MaterialFunctionCall') continue;
    const relPath = (node.params?.MaterialFunction as string | undefined) ?? '';
    if (!relPath) {
      warnings.push(`MFC "${node.id}": params.MaterialFunction missing`);
      derivedPins[node.id] = { inputs: [], outputs: [] };
      continue;
    }
    const absPath = resolve(graphsRoot, relPath);
    if (visited.has(absPath)) {
      warnings.push(`circular reference detected at MFC "${node.id}" → ${relPath}`);
      derivedPins[node.id] = { inputs: [], outputs: [] };
      continue;
    }
    const loaded = await loadGraph(absPath);
    if (!loaded.graph) {
      warnings.push(`MFC "${node.id}": MaterialFunction not found: ${relPath}`);
      derivedPins[node.id] = { inputs: [], outputs: [] };
      continue;
    }
    if (loaded.graph.type !== 'MaterialFunction') {
      warnings.push(`MFC "${node.id}": expected MaterialFunction, got ${loaded.graph.type}`);
      derivedPins[node.id] = { inputs: [], outputs: [] };
      continue;
    }
    const nextVisited = new Set(visited);
    nextVisited.add(absPath);
    const subResolved = await resolveMaterialFunctions(loaded.graph, graphsRoot, nextVisited);
    warnings.push(...subResolved.warnings);

    derivedPins[node.id] = {
      inputs: loaded.graph.nodes
        .filter(n => n.type === 'FunctionInput')
        .map(n => ({
          name: (n.params?.InputName as string | undefined) ?? '(unnamed)',
          type: typeMapForInput(n.params?.InputType as string | undefined),
        })),
      outputs: loaded.graph.nodes
        .filter(n => n.type === 'FunctionOutput')
        .map(n => ({
          name: (n.params?.OutputName as string | undefined) ?? '(unnamed)',
          type: 'Float3', // conservative default; UE infers from wiring
        })),
    };
  }

  return { graph, derivedPins, warnings };
}

function typeMapForInput(uiType?: string): string {
  switch (uiType) {
    case 'Scalar':         return 'Float1';
    case 'VectorFloat2':   return 'Float2';
    case 'VectorFloat3':   return 'Float3';
    case 'VectorFloat4':   return 'Float4';
    case 'Texture2D':      return 'Texture2D';
    default:               return 'Float3';
  }
}
```

- [ ] **Step 4: Verify pass**

- [ ] **Step 5: Commit**

```bash
git add viewer/server/mf-resolver.ts viewer/tests/mf-resolver.test.ts
git commit -m "feat: mf-resolver with circular detection"
```

---

### Task 13: Debouncer utility

**Files:**
- Create: `viewer/server/debounce.ts`
- Create: `viewer/tests/debounce.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createDebouncer } from '../server/debounce';

describe('createDebouncer', () => {
  it('coalesces rapid calls into one trigger', async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createDebouncer(fn, 300);
    d.trigger('a');
    d.trigger('b');
    d.trigger('c');
    await vi.advanceTimersByTimeAsync(299);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(['a', 'b', 'c']);
    vi.useRealTimers();
  });

  it('fires twice if calls span beyond debounce window', async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createDebouncer(fn, 100);
    d.trigger('x');
    await vi.advanceTimersByTimeAsync(150);
    d.trigger('y');
    await vi.advanceTimersByTimeAsync(150);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, ['x']);
    expect(fn).toHaveBeenNthCalledWith(2, ['y']);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Verify fail**

- [ ] **Step 3: Implement**

`viewer/server/debounce.ts`:
```typescript
export interface Debouncer<T> {
  trigger(item: T): void;
}

export function createDebouncer<T>(fn: (items: T[]) => void, delayMs: number): Debouncer<T> {
  let buf: T[] = [];
  let timer: NodeJS.Timeout | null = null;
  return {
    trigger(item: T) {
      buf.push(item);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const items = buf;
        buf = [];
        timer = null;
        fn(items);
      }, delayMs);
    },
  };
}
```

- [ ] **Step 4: Verify pass**

- [ ] **Step 5: Commit**

```bash
git add viewer/server/debounce.ts viewer/tests/debounce.test.ts
git commit -m "feat: debouncer that coalesces rapid triggers"
```

---

### Task 14: Chokidar watcher wrapper

**Files:**
- Create: `viewer/server/watcher.ts`

This task uses integration testing rather than unit TDD (chokidar's file events are inherently I/O).

- [ ] **Step 1: Write integration test**

`viewer/tests/watcher.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { watchGraphs } from '../server/watcher';

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

describe('watchGraphs', () => {
  it('fires once for a batch of writes within debounce window', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'watch-'));
    mkdirSync(resolve(root, 'functions'), { recursive: true });

    const changes: string[][] = [];
    const w = watchGraphs(root, (paths) => { changes.push(paths); }, { debounceMs: 100 });
    await sleep(150); // let watcher settle

    writeFileSync(resolve(root, 'a.matgraph.json'), '{}');
    writeFileSync(resolve(root, 'functions/b.matgraph.json'), '{}');
    await sleep(50);
    writeFileSync(resolve(root, 'c.matgraph.json'), '{}');
    await sleep(250);

    await w.close();
    expect(changes.length).toBe(1);
    expect(changes[0].length).toBe(3);
  }, 5000);
});
```

- [ ] **Step 2: Verify fail**

- [ ] **Step 3: Implement watcher**

`viewer/server/watcher.ts`:
```typescript
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { createDebouncer } from './debounce.js';

export interface WatchHandle {
  close(): Promise<void>;
}

export interface WatchOptions {
  debounceMs?: number;
}

export function watchGraphs(
  graphsRoot: string,
  onBatch: (paths: string[]) => void,
  opts: WatchOptions = {},
): WatchHandle {
  const debounce = createDebouncer<string>(onBatch, opts.debounceMs ?? 300);

  const watcher: FSWatcher = chokidarWatch(`${graphsRoot}/**/*.matgraph.json`, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
  });

  const handler = (path: string) => debounce.trigger(path);
  watcher.on('add', handler);
  watcher.on('change', handler);
  watcher.on('unlink', handler);

  return {
    async close() { await watcher.close(); },
  };
}
```

- [ ] **Step 4: Verify pass**

- [ ] **Step 5: Commit**

```bash
git add viewer/server/watcher.ts viewer/tests/watcher.test.ts
git commit -m "feat: chokidar watcher with debounced batches"
```

---

### Task 15: WebSocket message protocol + types

**Files:**
- Create: `viewer/server/ws-protocol.ts`

This is shared by server and (later) web — define the message shapes once.

- [ ] **Step 1: Write the file**

```typescript
import type { MatGraph } from './types.js';
import type { ResolvedGraph } from './mf-resolver.js';

export type ServerMessage =
  | { kind: 'hello'; graphsRoot: string; files: string[] }
  | { kind: 'fileList'; files: string[] }
  | { kind: 'graph'; path: string; payload: GraphPayload }
  | { kind: 'graphError'; path: string; errors: string[] };

export interface GraphPayload {
  graph: MatGraph;
  derivedPins: ResolvedGraph['derivedPins'];
  warnings: string[];
}

export type ClientMessage =
  | { kind: 'open'; path: string }
  | { kind: 'listFiles' };
```

- [ ] **Step 2: Commit**

```bash
git add viewer/server/ws-protocol.ts
git commit -m "feat: WS message protocol types"
```

---

### Task 16: HTTP + WebSocket server

**Files:**
- Create: `viewer/server/http-server.ts`
- Create: `viewer/tests/http-server.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
import { describe, it, expect } from 'vitest';
import { startServer } from '../server/http-server';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';

describe('startServer', () => {
  it('serves WS hello with file list on connect', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'srv-'));
    mkdirSync(resolve(root, 'graphs/functions'), { recursive: true });
    writeFileSync(resolve(root, 'graphs/a.matgraph.json'), '{}');
    writeFileSync(resolve(root, 'graphs/functions/b.matgraph.json'), '{}');

    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const url = `ws://localhost:${server.port}`;
    const ws = new WebSocket(url);

    const hello: any = await new Promise((res, rej) => {
      ws.on('message', d => res(JSON.parse(d.toString())));
      ws.on('error', rej);
    });
    expect(hello.kind).toBe('hello');
    expect(hello.files.sort()).toEqual(['a.matgraph.json', 'functions/b.matgraph.json']);

    ws.close();
    await server.close();
  }, 5000);
});
```

- [ ] **Step 2: Verify fail**

- [ ] **Step 3: Implement http-server**

`viewer/server/http-server.ts`:
```typescript
import { createServer, type Server } from 'node:http';
import { readFile, stat, readdir } from 'node:fs/promises';
import { resolve, join, extname, relative } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { watchGraphs } from './watcher.js';
import { loadGraph } from './graph-loader.js';
import { resolveMaterialFunctions } from './mf-resolver.js';
import type { ServerMessage, ClientMessage } from './ws-protocol.js';

export interface ServerOpts {
  repoRoot: string;     // contains graphs/
  port: number;         // 0 = auto
  webDist: string;      // path to built web files (empty for test)
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export async function startServer(opts: ServerOpts): Promise<RunningServer> {
  const graphsRoot = resolve(opts.repoRoot, 'graphs');

  const http: Server = createServer(async (req, res) => {
    if (!opts.webDist) { res.writeHead(404); res.end(); return; }
    try {
      const url = (req.url || '/').split('?')[0];
      const rel = url === '/' ? '/index.html' : url;
      const filePath = join(opts.webDist, rel);
      const data = await readFile(filePath);
      const ext = extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      try {
        const index = await readFile(join(opts.webDist, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(index);
      } catch { res.writeHead(404); res.end(); }
    }
  });

  const wss = new WebSocketServer({ server: http });

  const send = (ws: WebSocket, msg: ServerMessage) => ws.send(JSON.stringify(msg));

  async function listFiles(): Promise<string[]> {
    const out: string[] = [];
    async function walk(dir: string) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch { return; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile() && e.name.endsWith('.matgraph.json')) {
          out.push(relative(graphsRoot, full));
        }
      }
    }
    await walk(graphsRoot);
    return out.sort();
  }

  async function sendGraph(ws: WebSocket, relPath: string) {
    const abs = resolve(graphsRoot, relPath);
    const loaded = await loadGraph(abs);
    if (!loaded.graph) {
      send(ws, { kind: 'graphError', path: relPath, errors: loaded.errors });
      return;
    }
    const resolved = await resolveMaterialFunctions(loaded.graph, graphsRoot);
    send(ws, {
      kind: 'graph', path: relPath,
      payload: { graph: resolved.graph, derivedPins: resolved.derivedPins, warnings: resolved.warnings },
    });
  }

  wss.on('connection', async (ws) => {
    const files = await listFiles();
    send(ws, { kind: 'hello', graphsRoot, files });
    ws.on('message', async (raw) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.kind === 'listFiles') {
        send(ws, { kind: 'fileList', files: await listFiles() });
      } else if (msg.kind === 'open') {
        await sendGraph(ws, msg.path);
      }
    });
  });

  const watcher = watchGraphs(graphsRoot, async (paths) => {
    const files = await listFiles();
    for (const ws of wss.clients) {
      send(ws, { kind: 'fileList', files });
      for (const p of paths) {
        const rel = relative(graphsRoot, p);
        await sendGraph(ws, rel);
      }
    }
  }, { debounceMs: 300 });

  await new Promise<void>((res) => http.listen(opts.port, res));
  const addr = http.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : opts.port;

  return {
    port: actualPort,
    async close() {
      await watcher.close();
      await new Promise<void>((res) => wss.close(() => res()));
      await new Promise<void>((res) => http.close(() => res()));
    },
  };
}
```

- [ ] **Step 4: Verify pass**

- [ ] **Step 5: Commit**

```bash
git add viewer/server/http-server.ts viewer/tests/http-server.test.ts
git commit -m "feat: http+ws server with file listing and live push"
```

---

### Task 17: Server bootstrap (with port fallback)

**Files:**
- Create: `viewer/server/index.ts`

- [ ] **Step 1: Write bootstrap**

`viewer/server/index.ts`:
```typescript
import { resolve } from 'node:path';
import { startServer } from './http-server.js';

const BASE_PORT = 5790;
const MAX_ATTEMPTS = 10;

async function main() {
  const repoRoot = process.cwd();
  const webDist = resolve(repoRoot, 'viewer/web/dist');

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const port = BASE_PORT + i;
    try {
      const server = await startServer({ repoRoot, port, webDist });
      console.log(`ue-mat-viewer listening on http://localhost:${server.port}`);
      console.log(`watching: ${resolve(repoRoot, 'graphs')}`);
      process.on('SIGINT', async () => { await server.close(); process.exit(0); });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE') throw e;
      console.log(`port ${port} in use, trying ${port + 1}...`);
    }
  }
  console.error(`failed to bind a port in range ${BASE_PORT}-${BASE_PORT + MAX_ATTEMPTS - 1}`);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Manual smoke test**

```bash
cd viewer && pnpm tsc -p tsconfig.json
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
node viewer/dist/server/index.js &
sleep 1
echo '{"schemaVersion":"1.0","ueVersion":"5.7","type":"Material","name":"test","nodes":[{"id":"OUT","type":"MaterialOutput"}],"connections":[]}' > graphs/test.matgraph.json
sleep 1
kill %1
```
Expected: server log shows "listening on http://localhost:5790" and watcher detects the new file.

- [ ] **Step 3: Commit**

```bash
git add viewer/server/index.ts
git commit -m "feat: server bootstrap with port fallback"
```

---

### Task 18: CLI entry script

**Files:**
- Create: `viewer/bin/ue-mat-viewer`

- [ ] **Step 1: Write CLI**

`viewer/bin/ue-mat-viewer`:
```bash
#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cmd = process.argv[2] ?? 'start';
const __dirname = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(__dirname, '../dist/server/index.js');

if (cmd === 'start') {
  await import(serverEntry);
} else if (cmd === 'export') {
  const exportEntry = resolve(__dirname, '../dist/server/html-export.js');
  await import(exportEntry);
} else {
  console.error(`Unknown command: ${cmd}`);
  console.error(`Usage: ue-mat-viewer [start|export <name> --out <path>]`);
  process.exit(1);
}
```

Rename to `ue-mat-viewer.mjs` if your environment requires extension for ESM. The shebang and `import.meta.url` need ESM.

- [ ] **Step 2: Make executable**

```bash
chmod +x viewer/bin/ue-mat-viewer
```

- [ ] **Step 3: Verify pnpm linking**

```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
pnpm install
which ue-mat-viewer || pnpm exec ue-mat-viewer start --help
```

- [ ] **Step 4: Commit**

```bash
git add viewer/bin/ue-mat-viewer viewer/package.json
git commit -m "feat: ue-mat-viewer CLI entry"
```

---

## Phase 3 — Viewer Web

### Task 19: Vite + React skeleton

**Files:**
- Create: `viewer/web/package.json`
- Create: `viewer/web/tsconfig.json`
- Create: `viewer/web/vite.config.ts`
- Create: `viewer/web/index.html`
- Create: `viewer/web/src/main.tsx`
- Create: `viewer/web/src/App.tsx`

- [ ] **Step 1: Create web package**

`viewer/web/package.json`:
```json
{
  "name": "web",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "reactflow": "^11.11.0",
    "dagre": "^0.8.5"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/dagre": "^0.7.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.4.0",
    "vite": "^5.0.0"
  }
}
```

- [ ] **Step 2: Vite + tsconfig + index.html**

`viewer/web/vite.config.ts`:
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { port: 5791 },
  build: { outDir: 'dist', emptyOutDir: true },
});
```

`viewer/web/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["DOM", "ES2022"],
    "types": ["vite/client"]
  },
  "include": ["src"]
}
```

`viewer/web/index.html`:
```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>UE Material Viewer</title>
  </head>
  <body style="margin:0">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: React entry**

`viewer/web/src/main.tsx`:
```typescript
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
```

`viewer/web/src/App.tsx`:
```typescript
import React from 'react';
export function App() {
  return <div style={{ padding: 20 }}>UE Material Viewer — loading...</div>;
}
```

- [ ] **Step 4: Install + verify build**

```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
pnpm install
pnpm --filter web build
ls viewer/web/dist/index.html
```

- [ ] **Step 5: Commit**

```bash
git add viewer/web/
git commit -m "feat: vite+react skeleton for viewer web"
```

---

### Task 20: WS client + state store (zustand-free, plain React context)

**Files:**
- Create: `viewer/web/src/ws-client.ts`
- Create: `viewer/web/src/store.ts`
- Create: `viewer/web/src/protocol.ts`

To keep dep count low, no zustand — use React's built-in `useReducer` + Context.

- [ ] **Step 1: Mirror the protocol types in web**

`viewer/web/src/protocol.ts`:
```typescript
// Duplicate of viewer/server/ws-protocol.ts. Keep in sync.
// (Acceptable duplication; alternative is a shared package which costs more than it saves.)

export interface NodeJson { id: string; type: string; params?: Record<string, unknown>; }
export interface ConnectionJson { from: string; to: string; }
export interface CommentJson { id: string; text: string; color?: string; contains: string[]; }

export interface MatGraph {
  schemaVersion: string;
  ueVersion: string;
  type: 'Material' | 'MaterialFunction';
  name: string;
  description?: string;
  nodes: NodeJson[];
  connections: ConnectionJson[];
  comments?: CommentJson[];
}

export interface DerivedPins {
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
}

export interface GraphPayload {
  graph: MatGraph;
  derivedPins: Record<string, DerivedPins>;
  warnings: string[];
}

export type ServerMessage =
  | { kind: 'hello'; graphsRoot: string; files: string[] }
  | { kind: 'fileList'; files: string[] }
  | { kind: 'graph'; path: string; payload: GraphPayload }
  | { kind: 'graphError'; path: string; errors: string[] };

export type ClientMessage =
  | { kind: 'open'; path: string }
  | { kind: 'listFiles' };
```

- [ ] **Step 2: WS client**

`viewer/web/src/ws-client.ts`:
```typescript
import type { ServerMessage, ClientMessage } from './protocol';

export interface WSClient {
  send(msg: ClientMessage): void;
  close(): void;
}

export function connect(onMessage: (m: ServerMessage) => void): WSClient {
  const url = `ws://${location.host}`;
  let ws = new WebSocket(url);

  ws.onmessage = (e) => {
    try { onMessage(JSON.parse(e.data)); } catch (err) { console.error('bad ws msg', err); }
  };
  ws.onclose = () => {
    setTimeout(() => { ws = new WebSocket(url); attachHandlers(); }, 500);
  };
  function attachHandlers() {
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => { setTimeout(() => { ws = new WebSocket(url); attachHandlers(); }, 500); };
  }

  return {
    send(msg) {
      const fire = () => ws.send(JSON.stringify(msg));
      if (ws.readyState === WebSocket.OPEN) fire();
      else ws.addEventListener('open', fire, { once: true });
    },
    close() { ws.close(); },
  };
}
```

- [ ] **Step 3: Store**

`viewer/web/src/store.ts`:
```typescript
import React, { createContext, useContext, useReducer, useEffect } from 'react';
import { connect } from './ws-client';
import type { ServerMessage, GraphPayload } from './protocol';

interface State {
  files: string[];
  currentPath: string | null;        // top-level graph being viewed
  breadcrumb: string[];               // [topLevel, ...mfStack]
  graphs: Record<string, GraphPayload>;
  errors: Record<string, string[]>;
}

type Action =
  | { type: 'hello'; files: string[] }
  | { type: 'fileList'; files: string[] }
  | { type: 'graph'; path: string; payload: GraphPayload }
  | { type: 'graphError'; path: string; errors: string[] }
  | { type: 'open'; path: string }
  | { type: 'enterMF'; mfPath: string }
  | { type: 'popBreadcrumb'; toIndex: number };

const initial: State = {
  files: [], currentPath: null, breadcrumb: [], graphs: {}, errors: {},
};

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'hello':
    case 'fileList':
      return { ...s, files: a.files };
    case 'graph':
      return { ...s, graphs: { ...s.graphs, [a.path]: a.payload }, errors: { ...s.errors, [a.path]: [] } };
    case 'graphError':
      return { ...s, errors: { ...s.errors, [a.path]: a.errors } };
    case 'open':
      return { ...s, currentPath: a.path, breadcrumb: [a.path] };
    case 'enterMF':
      return { ...s, breadcrumb: [...s.breadcrumb, a.mfPath] };
    case 'popBreadcrumb':
      return { ...s, breadcrumb: s.breadcrumb.slice(0, a.toIndex + 1) };
    default: return s;
  }
}

interface Ctx {
  state: State;
  open(path: string): void;
  enterMF(path: string): void;
  popBreadcrumb(i: number): void;
}

const C = createContext<Ctx | null>(null);

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial);
  const wsRef = React.useRef<ReturnType<typeof connect> | null>(null);

  useEffect(() => {
    const ws = connect((m: ServerMessage) => {
      if (m.kind === 'hello') dispatch({ type: 'hello', files: m.files });
      else if (m.kind === 'fileList') dispatch({ type: 'fileList', files: m.files });
      else if (m.kind === 'graph') dispatch({ type: 'graph', path: m.path, payload: m.payload });
      else if (m.kind === 'graphError') dispatch({ type: 'graphError', path: m.path, errors: m.errors });
    });
    wsRef.current = ws;
    return () => ws.close();
  }, []);

  return (
    <C.Provider value={{
      state,
      open(path) { wsRef.current?.send({ kind: 'open', path }); dispatch({ type: 'open', path }); },
      enterMF(path) { wsRef.current?.send({ kind: 'open', path }); dispatch({ type: 'enterMF', mfPath: path }); },
      popBreadcrumb(i) { dispatch({ type: 'popBreadcrumb', toIndex: i }); },
    }}>{children}</C.Provider>
  );
}

export function useStore() {
  const c = useContext(C);
  if (!c) throw new Error('useStore outside StoreProvider');
  return c;
}
```

- [ ] **Step 4: Commit**

```bash
git add viewer/web/src/ws-client.ts viewer/web/src/store.ts viewer/web/src/protocol.ts
git commit -m "feat: WS client + React store"
```

---

### Task 21: Dagre layout utility

**Files:**
- Create: `viewer/web/src/layout.ts`

- [ ] **Step 1: Write layout helper**

`viewer/web/src/layout.ts`:
```typescript
import dagre from 'dagre';
import type { Node, Edge } from 'reactflow';

const NODE_W = 220;
const NODE_H = 100;

export interface LayoutInput {
  nodes: { id: string }[];
  edges: { id: string; source: string; target: string }[];
}

export function autoLayout(input: LayoutInput): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of input.nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of input.edges) g.setEdge(e.source, e.target);

  dagre.layout(g);

  const out: Record<string, { x: number; y: number }> = {};
  for (const n of input.nodes) {
    const p = g.node(n.id);
    out[n.id] = { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 };
  }
  return out;
}

export function applyLayout(nodes: Node[], edges: Edge[]): Node[] {
  const positions = autoLayout({
    nodes: nodes.map(n => ({ id: n.id })),
    edges: edges.map(e => ({ id: e.id, source: e.source, target: e.target })),
  });
  return nodes.map(n => ({ ...n, position: positions[n.id] ?? { x: 0, y: 0 } }));
}
```

- [ ] **Step 2: Commit**

```bash
git add viewer/web/src/layout.ts
git commit -m "feat: dagre layout helper"
```

---

### Task 22: Generic MaterialNode component

**Files:**
- Create: `viewer/web/src/nodes/MaterialNode.tsx`
- Create: `viewer/web/src/nodes/styles.css`

- [ ] **Step 1: Component**

`viewer/web/src/nodes/MaterialNode.tsx`:
```typescript
import React from 'react';
import { Handle, Position } from 'reactflow';
import './styles.css';

export interface MaterialNodeData {
  label: string;          // node type, e.g. "Multiply"
  id: string;
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
  params?: Record<string, unknown>;
  warning?: string;        // if non-empty, show warning style
  isReserved?: boolean;
}

export function MaterialNode({ data }: { data: MaterialNodeData }) {
  const cls = ['mat-node'];
  if (data.warning) cls.push('mat-warn');
  if (data.isReserved) cls.push('mat-reserved');

  return (
    <div className={cls.join(' ')}>
      <div className="mat-node-title">{data.label}</div>
      <div className="mat-node-body">
        <div className="mat-node-pins mat-inputs">
          {data.inputs.map((p, i) => (
            <div key={p.name} className="mat-pin">
              <Handle id={p.name} type="target" position={Position.Left} style={{ top: 30 + i * 18 }} />
              <span className="mat-pin-name">{p.name}</span>
            </div>
          ))}
        </div>
        <div className="mat-node-pins mat-outputs">
          {data.outputs.map((p, i) => (
            <div key={p.name} className="mat-pin mat-pin-right">
              <span className="mat-pin-name">{p.name}</span>
              <Handle id={p.name} type="source" position={Position.Right} style={{ top: 30 + i * 18 }} />
            </div>
          ))}
        </div>
      </div>
      {data.params && Object.keys(data.params).length > 0 && (
        <div className="mat-node-params">
          {Object.entries(data.params).map(([k, v]) => (
            <div key={k} className="mat-param"><span>{k}:</span> <code>{JSON.stringify(v)}</code></div>
          ))}
        </div>
      )}
      {data.warning && <div className="mat-warn-msg">{data.warning}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Styles**

`viewer/web/src/nodes/styles.css`:
```css
.mat-node {
  background: #2b2b2b;
  border: 1px solid #555;
  border-radius: 4px;
  min-width: 180px;
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 12px;
  color: #ddd;
}
.mat-node-title {
  padding: 6px 10px;
  font-weight: 600;
  background: #1e1e1e;
  border-bottom: 1px solid #555;
  border-radius: 4px 4px 0 0;
}
.mat-node-body { display: flex; padding: 6px 0; min-height: 30px; }
.mat-node-pins { flex: 1; }
.mat-inputs { padding-left: 10px; }
.mat-outputs { padding-right: 10px; text-align: right; }
.mat-pin { position: relative; height: 18px; line-height: 18px; }
.mat-pin-name { padding: 0 4px; }
.mat-node-params {
  border-top: 1px solid #444; padding: 4px 10px;
  background: #252525; font-size: 10px;
}
.mat-param { margin: 2px 0; color: #aaa; }
.mat-param code { color: #d4a050; }

.mat-warn { border-color: #d4a050; }
.mat-warn-msg { padding: 4px 10px; background: #4a3a20; color: #f0c060; font-size: 10px; }

.mat-reserved { background: #2b3a4a; }

/* connection lines */
.react-flow__edge-path { stroke: #888; stroke-width: 2; }
```

- [ ] **Step 3: Commit**

```bash
git add viewer/web/src/nodes/MaterialNode.tsx viewer/web/src/nodes/styles.css
git commit -m "feat: generic MaterialNode component"
```

---

### Task 23: Specialized node components

**Files:**
- Create: `viewer/web/src/nodes/MaterialOutputNode.tsx`
- Create: `viewer/web/src/nodes/FunctionIONode.tsx`
- Create: `viewer/web/src/nodes/MaterialFunctionCallNode.tsx`

These are thin wrappers around `MaterialNode` with type-specific defaults.

- [ ] **Step 1: MaterialOutputNode**

```typescript
import React from 'react';
import { MaterialNode, type MaterialNodeData } from './MaterialNode';

export const MATERIAL_OUTPUT_PINS = [
  'BaseColor', 'Metallic', 'Specular', 'Roughness', 'EmissiveColor',
  'Opacity', 'OpacityMask', 'Normal', 'WorldPositionOffset',
  'Refraction', 'AmbientOcclusion', 'PixelDepthOffset',
  'SubsurfaceColor', 'ClearCoat', 'ClearCoatRoughness',
];

export function MaterialOutputNode(props: { data: Pick<MaterialNodeData, 'id' | 'params' | 'warning'> }) {
  const data: MaterialNodeData = {
    id: props.data.id,
    label: 'Material Output',
    inputs: MATERIAL_OUTPUT_PINS.map(n => ({ name: n, type: 'Float' })),
    outputs: [],
    params: props.data.params,
    warning: props.data.warning,
    isReserved: true,
  };
  return <MaterialNode data={data} />;
}
```

- [ ] **Step 2: FunctionIONode**

```typescript
import React from 'react';
import { MaterialNode, type MaterialNodeData } from './MaterialNode';

export function FunctionInputNode(props: { data: Pick<MaterialNodeData, 'id' | 'params'> }) {
  const name = (props.data.params?.InputName as string) ?? '(unnamed)';
  const data: MaterialNodeData = {
    id: props.data.id, label: `FunctionInput: ${name}`,
    inputs: [], outputs: [{ name: 'Input', type: 'Float' }],
    params: props.data.params, isReserved: true,
  };
  return <MaterialNode data={data} />;
}

export function FunctionOutputNode(props: { data: Pick<MaterialNodeData, 'id' | 'params'> }) {
  const name = (props.data.params?.OutputName as string) ?? '(unnamed)';
  const data: MaterialNodeData = {
    id: props.data.id, label: `FunctionOutput: ${name}`,
    inputs: [{ name: 'Input', type: 'Float' }], outputs: [],
    params: props.data.params, isReserved: true,
  };
  return <MaterialNode data={data} />;
}
```

- [ ] **Step 3: MaterialFunctionCallNode**

```typescript
import React from 'react';
import { MaterialNode, type MaterialNodeData } from './MaterialNode';

export interface MFCData {
  id: string;
  label: string;                                   // function name
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
  params?: Record<string, unknown>;
  onDoubleClick(): void;
  warning?: string;
}

export function MaterialFunctionCallNode({ data }: { data: MFCData }) {
  const md: MaterialNodeData = {
    id: data.id, label: `f() ${data.label}`,
    inputs: data.inputs, outputs: data.outputs,
    params: data.params, warning: data.warning, isReserved: true,
  };
  return <div onDoubleClick={data.onDoubleClick} style={{ cursor: 'pointer' }}><MaterialNode data={md} /></div>;
}
```

- [ ] **Step 4: Commit**

```bash
git add viewer/web/src/nodes/MaterialOutputNode.tsx viewer/web/src/nodes/FunctionIONode.tsx viewer/web/src/nodes/MaterialFunctionCallNode.tsx
git commit -m "feat: specialized node components"
```

---

### Task 24: Graph component (assembles ReactFlow + node DB + layout)

**Files:**
- Create: `viewer/web/src/Graph.tsx`

- [ ] **Step 1: Write Graph component**

```typescript
import React, { useMemo } from 'react';
import ReactFlow, { type Node, type Edge, Background, Controls, MiniMap } from 'reactflow';
import 'reactflow/dist/style.css';
import { MaterialNode } from './nodes/MaterialNode';
import { MaterialOutputNode } from './nodes/MaterialOutputNode';
import { FunctionInputNode, FunctionOutputNode } from './nodes/FunctionIONode';
import { MaterialFunctionCallNode } from './nodes/MaterialFunctionCallNode';
import { applyLayout } from './layout';
import type { GraphPayload } from './protocol';
import type { NodeDB } from '../../server/db-types.js';

const NODE_TYPES = {
  generic: MaterialNode,
  materialOutput: MaterialOutputNode,
  functionInput: FunctionInputNode,
  functionOutput: FunctionOutputNode,
  materialFunctionCall: MaterialFunctionCallNode,
};

export interface GraphProps {
  payload: GraphPayload;
  db: NodeDB;
  onEnterMF(path: string): void;
}

export function Graph({ payload, db, onEnterMF }: GraphProps) {
  const { graph, derivedPins } = payload;

  const { nodes, edges } = useMemo(() => {
    const rfNodes: Node[] = graph.nodes.map(n => {
      if (n.type === 'MaterialOutput') {
        return { id: n.id, type: 'materialOutput', position: { x: 0, y: 0 }, data: { id: n.id, params: n.params } };
      }
      if (n.type === 'FunctionInput') {
        return { id: n.id, type: 'functionInput', position: { x: 0, y: 0 }, data: { id: n.id, params: n.params } };
      }
      if (n.type === 'FunctionOutput') {
        return { id: n.id, type: 'functionOutput', position: { x: 0, y: 0 }, data: { id: n.id, params: n.params } };
      }
      if (n.type === 'MaterialFunctionCall') {
        const mfPath = (n.params?.MaterialFunction as string | undefined) ?? '';
        const pins = derivedPins[n.id] ?? { inputs: [], outputs: [] };
        return {
          id: n.id, type: 'materialFunctionCall', position: { x: 0, y: 0 },
          data: {
            id: n.id,
            label: mfPath.split('/').pop()?.replace('.matgraph.json', '') ?? 'unknown',
            inputs: pins.inputs, outputs: pins.outputs,
            params: n.params,
            onDoubleClick: () => onEnterMF(normalizeMFPath(mfPath)),
            warning: pins.inputs.length === 0 && pins.outputs.length === 0 ? 'MaterialFunction missing or empty' : undefined,
          },
        };
      }
      const def = db.nodes[n.type];
      if (def) {
        return {
          id: n.id, type: 'generic', position: { x: 0, y: 0 },
          data: {
            id: n.id, label: n.type,
            inputs: def.inputs, outputs: def.outputs,
            params: n.params,
          },
        };
      }
      return {
        id: n.id, type: 'generic', position: { x: 0, y: 0 },
        data: { id: n.id, label: n.type, inputs: [], outputs: [], params: n.params, warning: `Unknown node type: ${n.type}` },
      };
    });

    const rfEdges: Edge[] = graph.connections.map((c, i) => {
      const [src, srcPin] = c.from.split(':');
      const [tgt, tgtPin] = c.to.split(':');
      return { id: `e${i}`, source: src, sourceHandle: srcPin, target: tgt, targetHandle: tgtPin };
    });

    return { nodes: applyLayout(rfNodes, rfEdges), edges: rfEdges };
  }, [graph, derivedPins, db, onEnterMF]);

  return (
    <ReactFlow
      nodes={nodes} edges={edges} nodeTypes={NODE_TYPES}
      fitView style={{ background: '#1a1a1a' }}
    >
      <Background gap={20} color="#333" />
      <Controls />
      <MiniMap />
    </ReactFlow>
  );
}

function normalizeMFPath(p: string): string {
  // Convert "./functions/foo.matgraph.json" → "functions/foo.matgraph.json"
  return p.replace(/^\.\//, '');
}
```

- [ ] **Step 2: Commit**

```bash
git add viewer/web/src/Graph.tsx
git commit -m "feat: Graph component composing ReactFlow + dagre + node renderers"
```

---

### Task 25: Breadcrumb + FileList + WarningPanel

**Files:**
- Create: `viewer/web/src/Breadcrumb.tsx`
- Create: `viewer/web/src/FileList.tsx`
- Create: `viewer/web/src/WarningPanel.tsx`

- [ ] **Step 1: Breadcrumb**

```typescript
import React from 'react';
import { useStore } from './store';

export function Breadcrumb() {
  const { state, popBreadcrumb } = useStore();
  return (
    <div style={{ padding: '8px 12px', background: '#252525', color: '#ddd', display: 'flex', gap: 6 }}>
      {state.breadcrumb.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span style={{ color: '#666' }}>▸</span>}
          <span
            style={{ cursor: 'pointer', textDecoration: i === state.breadcrumb.length - 1 ? 'none' : 'underline' }}
            onClick={() => popBreadcrumb(i)}
          >{niceName(p)}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

function niceName(p: string) {
  return p.replace(/^functions\//, '').replace('.matgraph.json', '');
}
```

- [ ] **Step 2: FileList**

```typescript
import React from 'react';
import { useStore } from './store';

export function FileList() {
  const { state, open } = useStore();
  return (
    <div style={{ padding: 8, background: '#1e1e1e', color: '#ddd', overflowY: 'auto', height: '100%' }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Graphs</div>
      {state.files.map(f => (
        <div
          key={f}
          onClick={() => open(f)}
          style={{
            padding: '4px 6px', cursor: 'pointer',
            background: state.breadcrumb[0] === f ? '#3a3a3a' : 'transparent',
            fontSize: 12, color: f.startsWith('functions/') ? '#8ab' : '#ddd',
          }}
        >{f}</div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: WarningPanel**

```typescript
import React from 'react';
import { useStore } from './store';

export function WarningPanel() {
  const { state } = useStore();
  const current = state.breadcrumb[state.breadcrumb.length - 1];
  if (!current) return null;
  const warnings = state.graphs[current]?.warnings ?? [];
  const errors = state.errors[current] ?? [];
  if (warnings.length === 0 && errors.length === 0) return null;
  return (
    <div style={{ padding: '6px 12px', background: '#4a2020', color: '#fbb', fontSize: 12 }}>
      {errors.map((e, i) => <div key={`e${i}`}>⛔ {e}</div>)}
      {warnings.map((w, i) => <div key={`w${i}`}>⚠ {w}</div>)}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add viewer/web/src/Breadcrumb.tsx viewer/web/src/FileList.tsx viewer/web/src/WarningPanel.tsx
git commit -m "feat: Breadcrumb, FileList, WarningPanel components"
```

---

### Task 26: Node DB loading on the web side

**Files:**
- Modify: `viewer/web/vite.config.ts` (alias to read DB at build)
- Create: `viewer/web/src/db.ts`

The web side needs the node DB to render correct pin names. We bundle it at build time via Vite's JSON import.

- [ ] **Step 1: Update vite config alias**

Edit `viewer/web/vite.config.ts`:
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@db': resolve(__dirname, '../../agent-pack/nodes-ue5.7.json'),
    },
  },
  server: { port: 5791 },
  build: { outDir: 'dist', emptyOutDir: true },
});
```

- [ ] **Step 2: Create db.ts**

`viewer/web/src/db.ts`:
```typescript
import dbJson from '@db';
import type { NodeDB } from '../../server/db-types';
export const DB: NodeDB = dbJson as NodeDB;
```

(Also add a `vite-env.d.ts` if TS complains about `@db`.)

`viewer/web/src/vite-env.d.ts`:
```typescript
/// <reference types="vite/client" />
declare module '@db' {
  const value: unknown;
  export default value;
}
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
pnpm --filter web build
```

- [ ] **Step 4: Commit**

```bash
git add viewer/web/vite.config.ts viewer/web/src/db.ts viewer/web/src/vite-env.d.ts
git commit -m "feat: bundle node DB into web build via vite alias"
```

---

### Task 27: Wire App.tsx — full UI assembly

**Files:**
- Modify: `viewer/web/src/App.tsx`
- Modify: `viewer/web/src/main.tsx`

- [ ] **Step 1: Rewrite App.tsx**

```typescript
import React, { useEffect } from 'react';
import { StoreProvider, useStore } from './store';
import { Breadcrumb } from './Breadcrumb';
import { FileList } from './FileList';
import { WarningPanel } from './WarningPanel';
import { Graph } from './Graph';
import { DB } from './db';

function Body() {
  const { state, open, enterMF } = useStore();

  useEffect(() => {
    if (!state.currentPath && state.files.length > 0) {
      open(state.files[0]);
    }
  }, [state.files, state.currentPath, open]);

  const current = state.breadcrumb[state.breadcrumb.length - 1];
  const payload = current ? state.graphs[current] : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#1a1a1a' }}>
      <Breadcrumb />
      <WarningPanel />
      <div style={{ flex: 1, display: 'flex' }}>
        <div style={{ width: 220 }}><FileList /></div>
        <div style={{ flex: 1 }}>
          {payload ? <Graph payload={payload} db={DB} onEnterMF={enterMF} /> :
            <div style={{ color: '#888', padding: 20 }}>Select a graph from the left.</div>}
        </div>
      </div>
    </div>
  );
}

export function App() {
  return <StoreProvider><Body /></StoreProvider>;
}
```

- [ ] **Step 2: Build + smoke test**

```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
pnpm --filter web build
# Start server (will serve the built web)
cd viewer && pnpm tsc -p tsconfig.json && cd ..
node viewer/dist/server/index.js &
sleep 1
# Drop one of the examples into graphs/
cp agent-pack/examples/01_basic_pbr.matgraph.json graphs/
echo "Open http://localhost:5790 manually and check the graph renders."
```

- [ ] **Step 3: Commit**

```bash
git add viewer/web/src/App.tsx
git commit -m "feat: assemble App with file list, breadcrumb, graph viewer"
```

---

## Phase 4 — Integration & Polish

### Task 28: MF navigation interaction (auto-fetch on enter)

**Files:**
- Modify: `viewer/web/src/store.ts`

Currently `enterMF(path)` only updates breadcrumb but doesn't ensure the MF graph is fetched. Add eager fetch.

- [ ] **Step 1: Update enterMF to send `open` before pushing breadcrumb**

Already does send (`wsRef.current?.send({ kind: 'open', path: a.mfPath })` from Task 20). Verify the path matches the server's `relative-to-graphs/` format.

Edit `Graph.tsx`'s `normalizeMFPath` to handle relative paths correctly when inside a nested MF:

Modify `viewer/web/src/Graph.tsx`:
```typescript
// Add a basePath prop so paths resolve relative to the current graph's location.
export interface GraphProps {
  payload: GraphPayload;
  basePath: string;       // path of the current graph file, relative to graphs/
  db: NodeDB;
  onEnterMF(path: string): void;
}

function resolveMFRelative(mfRef: string, currentPath: string): string {
  // currentPath like "main.matgraph.json" or "functions/x.matgraph.json"
  // mfRef like "./functions/y.matgraph.json" or "./z.matgraph.json"
  const dir = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/') + 1) : '';
  const cleaned = mfRef.replace(/^\.\//, '');
  // If the cleaned path starts with `functions/` already and currentPath is in functions/, we still want to resolve relative.
  return (dir + cleaned).replace(/\/\.\//g, '/');
}
```

Use in the MFC node creation:
```typescript
const mfRefAbs = resolveMFRelative(mfPath, basePath);
// pass mfRefAbs into onDoubleClick
onDoubleClick: () => onEnterMF(mfRefAbs),
```

- [ ] **Step 2: Pass basePath from App**

In `App.tsx`'s Body:
```typescript
{payload ? <Graph payload={payload} basePath={current} db={DB} onEnterMF={enterMF} /> : ...}
```

- [ ] **Step 3: Manual test**

```bash
cp -r agent-pack/examples/* graphs/
# Open browser, click 02_with_function, double-click the MFC node, verify breadcrumb shows
# "02_with_function ▸ functions/blend_normals" and the function graph renders.
```

- [ ] **Step 4: Commit**

```bash
git add viewer/web/src/Graph.tsx viewer/web/src/App.tsx
git commit -m "feat: MF navigation resolves relative paths correctly"
```

---

### Task 29: Comment box rendering

**Files:**
- Create: `viewer/web/src/nodes/CommentBox.tsx`
- Modify: `viewer/web/src/Graph.tsx`

Comments wrap groups of nodes with a colored border and a title. We render them as background SVG rects sized to the bounding box of `contains` after layout.

- [ ] **Step 1: CommentBox component**

`viewer/web/src/nodes/CommentBox.tsx`:
```typescript
import React from 'react';

export interface CommentBoxData {
  text: string;
  color: string;
  bounds: { x: number; y: number; w: number; h: number };
}

export function CommentBoxOverlay({ comments }: { comments: CommentBoxData[] }) {
  return (
    <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', width: '100%', height: '100%' }}>
      {comments.map((c, i) => (
        <g key={i}>
          <rect
            x={c.bounds.x - 12} y={c.bounds.y - 28}
            width={c.bounds.w + 24} height={c.bounds.h + 40}
            fill={c.color + '20'} stroke={c.color} strokeWidth={2} rx={4}
          />
          <text x={c.bounds.x - 8} y={c.bounds.y - 12} fill={c.color} fontSize={12} fontWeight={600}>{c.text}</text>
        </g>
      ))}
    </svg>
  );
}
```

- [ ] **Step 2: Wire into Graph**

In `Graph.tsx`:
```typescript
import { CommentBoxOverlay, type CommentBoxData } from './nodes/CommentBox';

// After applyLayout, compute comment bounds:
const commentBoxes: CommentBoxData[] = useMemo(() => {
  if (!graph.comments) return [];
  const positions = Object.fromEntries(nodes.map(n => [n.id, n.position]));
  return graph.comments.map(c => {
    const inside = c.contains.map(id => positions[id]).filter(Boolean);
    if (inside.length === 0) return null;
    const xs = inside.map(p => p.x), ys = inside.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs) + 220;
    const minY = Math.min(...ys), maxY = Math.max(...ys) + 100;
    return { text: c.text, color: c.color ?? '#888', bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
  }).filter((c): c is CommentBoxData => c !== null);
}, [graph.comments, nodes]);

// Wrap ReactFlow in a relative div and overlay comments:
return (
  <div style={{ position: 'relative', width: '100%', height: '100%' }}>
    <ReactFlow ...>...</ReactFlow>
    <CommentBoxOverlay comments={commentBoxes} />
  </div>
);
```

Note: this is a simple approach — comment boxes don't pan/zoom with the graph yet. Known v1 limitation; a follow-up could integrate them as proper ReactFlow background nodes.

- [ ] **Step 3: Manual test**

Open `01_basic_pbr` and verify the "Base Color Tinting" comment box appears.

- [ ] **Step 4: Commit**

```bash
git add viewer/web/src/nodes/CommentBox.tsx viewer/web/src/Graph.tsx
git commit -m "feat: render comment boxes around node groups"
```

---

### Task 30: HTML export server-side

**Files:**
- Create: `viewer/server/html-export.ts`

`ue-mat-viewer export <name>` reads a graph + dependencies and emits a self-contained HTML file.

- [ ] **Step 1: Write html-export**

`viewer/server/html-export.ts`:
```typescript
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from './graph-loader.js';
import { resolveMaterialFunctions } from './mf-resolver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(3); // skip "node", entry, "export"
  // Actually CLI passes ["export", name, "--out", out]; argv slice from index 2 already skips the entry.
  // Re-parse cleanly:
  const fullArgs = process.argv.slice(2);
  if (fullArgs[0] !== 'export' || !fullArgs[1]) {
    console.error('Usage: ue-mat-viewer export <name> [--out <path>]');
    process.exit(1);
  }
  const name = fullArgs[1];
  const outIdx = fullArgs.indexOf('--out');
  const outPath = outIdx >= 0 ? fullArgs[outIdx + 1] : `./${name}.html`;

  const repoRoot = process.cwd();
  const graphsRoot = resolve(repoRoot, 'graphs');
  const matgraphPath = resolve(graphsRoot, `${name}.matgraph.json`);

  const loaded = await loadGraph(matgraphPath);
  if (!loaded.graph) {
    console.error(`failed to load ${matgraphPath}:`, loaded.errors);
    process.exit(1);
  }
  const resolved = await resolveMaterialFunctions(loaded.graph, graphsRoot);

  // Load all referenced MFs recursively to inline them
  const allFiles: Record<string, unknown> = { [`${name}.matgraph.json`]: loaded.graph };
  async function collect(g: typeof loaded.graph) {
    if (!g) return;
    for (const node of g.nodes) {
      if (node.type !== 'MaterialFunctionCall') continue;
      const rel = (node.params?.MaterialFunction as string | undefined) ?? '';
      if (!rel) continue;
      const cleaned = rel.replace(/^\.\//, '');
      if (allFiles[cleaned]) continue;
      const sub = await loadGraph(resolve(graphsRoot, cleaned));
      if (sub.graph) { allFiles[cleaned] = sub.graph; await collect(sub.graph); }
    }
  }
  await collect(loaded.graph);

  const webIndexHtml = await readFile(resolve(repoRoot, 'viewer/web/dist/index.html'), 'utf-8');
  // Find all referenced asset files and inline them:
  const inlined = await inlineAssets(webIndexHtml, resolve(repoRoot, 'viewer/web/dist'));

  // Inject the graph data
  const dataInject = `<script>window.__UE_MAT_EXPORT__ = ${JSON.stringify({
    entry: `${name}.matgraph.json`,
    files: allFiles,
    derivedPins: resolved.derivedPins,
    warnings: resolved.warnings,
  })};</script>`;
  const final = inlined.replace('</body>', `${dataInject}</body>`);

  await writeFile(outPath, final);
  console.log(`exported to ${outPath}`);
}

async function inlineAssets(html: string, distDir: string): Promise<string> {
  let result = html;
  const scriptRe = /<script[^>]*src="([^"]+)"[^>]*><\/script>/g;
  const linkRe = /<link[^>]*href="([^"]+)"[^>]*\/?>/g;

  for (const match of [...html.matchAll(scriptRe)]) {
    const src = match[1].replace(/^\//, '');
    try {
      const js = await readFile(resolve(distDir, src), 'utf-8');
      result = result.replace(match[0], `<script type="module">${js}</script>`);
    } catch {}
  }
  for (const match of [...html.matchAll(linkRe)]) {
    const href = match[1].replace(/^\//, '');
    if (!href.endsWith('.css')) continue;
    try {
      const css = await readFile(resolve(distDir, href), 'utf-8');
      result = result.replace(match[0], `<style>${css}</style>`);
    } catch {}
  }
  return result;
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: The web side needs an export-mode entry**

Edit `viewer/web/src/store.ts` to detect `window.__UE_MAT_EXPORT__` and use static data instead of WebSocket:

```typescript
// Inside StoreProvider, before connect():
const exportData = (window as any).__UE_MAT_EXPORT__;
useEffect(() => {
  if (exportData) {
    dispatch({ type: 'hello', files: Object.keys(exportData.files) });
    for (const [path, graph] of Object.entries(exportData.files)) {
      dispatch({
        type: 'graph', path,
        payload: { graph: graph as any, derivedPins: exportData.derivedPins, warnings: exportData.warnings },
      });
    }
    dispatch({ type: 'open', path: exportData.entry });
    return;
  }
  const ws = connect((m: ServerMessage) => { /* ... existing ... */ });
  wsRef.current = ws;
  return () => ws.close();
}, []);
```

- [ ] **Step 3: Add export button in the UI**

Edit `Breadcrumb.tsx`:
```typescript
// Add a button on the right that links to a download endpoint, or:
// Print instructions: "Export from CLI: ue-mat-viewer export <name>"
// In v1, export is CLI-only to keep server simple.
```

For v1 we keep export CLI-only and add a note in the breadcrumb area.

- [ ] **Step 4: Build + smoke test**

```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
pnpm --filter web build
pnpm --filter viewer build
node viewer/dist/server/html-export.js export 01_basic_pbr --out ./test.html
open test.html  # macOS; verify the graph renders without a server
```

- [ ] **Step 5: Commit**

```bash
git add viewer/server/html-export.ts viewer/web/src/store.ts
git commit -m "feat: HTML export bundles graph + assets into single file"
```

---

### Task 31: README polish + final smoke

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite README**

```markdown
# UE Material Workflow

AI 與人協作 UE5.7 材質節點圖的統一工作流。AI 寫 `.matgraph.json` 標準格式檔，本地 viewer 即時呈現節點圖。

## 安裝

```bash
git clone <repo>
cd ue-mat-workflow
pnpm install
pnpm build
```

需要 Node 18+ 和 pnpm（`npm i -g pnpm`）。

## 使用

啟動 viewer：
```bash
pnpm start
# → http://localhost:5790 (自動嘗試 5790-5799)
```

在另一個 terminal 跟你的 AI 對話（Claude Code 等），AI 會根據 `agent-pack/SPEC.md` 把材質寫到 `graphs/`，瀏覽器自動更新。

匯出獨立 HTML（可離線、可分享給沒有 Node 的人）：
```bash
pnpm exec ue-mat-viewer export 01_basic_pbr --out ./my-graph.html
```

## 給非 Node 使用者

如果只是想「看一張別人匯出的圖」，雙擊 `.html` 即可，不需安裝任何東西。

## 範例

`agent-pack/examples/` 下有兩個範例：
- `01_basic_pbr.matgraph.json` — 純 Material
- `02_with_function.matgraph.json` — 含 MaterialFunction

把它們複製到 `graphs/`：
```bash
cp -r agent-pack/examples/* graphs/
```

## 設計與規格

- 設計文件：`docs/superpowers/specs/2026-05-26-ue-material-workflow-design.md`
- AI 規範：`agent-pack/SPEC.md`
- 節點 DB：`agent-pack/nodes-ue5.7.json`（v1 seed，需補充）

## 補充節點 DB

DB 內目前有 ~10 個示範條目。補充時：
1. 從 https://dev.epicgames.com/documentation/en-us/unreal-engine/material-expression-reference 查節點
2. 仿造現有條目格式新增到 `nodes.<NodeName>`
3. 確認 `verified: true`（你親自核對過）
4. 跑 `pnpm test` 確認 DB 仍合法
```

- [ ] **Step 2: Run full test suite**

```bash
cd /Users/rouseterry/ClaudeAgent/ue-mat-workflow
pnpm test
```
Expected: all green.

- [ ] **Step 3: Final smoke walkthrough**

```bash
pnpm build
cp -r agent-pack/examples/* graphs/
pnpm start &
sleep 2
echo "Manually open http://localhost:5790"
echo "Click 01_basic_pbr; verify nodes + comment box visible"
echo "Click 02_with_function; double-click the MFC node; verify breadcrumb + MF graph"
echo "Modify graphs/01_basic_pbr.matgraph.json (change a param); verify browser auto-refreshes"
kill %1
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: write README with install/use/export instructions"
```

---

## Done Criteria

- [ ] `pnpm test` all pass
- [ ] `pnpm start` serves on 5790 (or fallback)
- [ ] Modifying `graphs/foo.matgraph.json` triggers browser re-render within 1s
- [ ] Double-clicking a `MaterialFunctionCall` enters the MF; breadcrumb works back
- [ ] Unknown node types show red border + warning panel entry
- [ ] Missing MF file shows red MFC with `?` pins
- [ ] `ue-mat-viewer export <name>` produces a standalone HTML that opens directly in browser
- [ ] README covers install + use + export
- [ ] All 4 entry files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `GEMINI.md`) point to `SPEC.md`

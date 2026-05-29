# UE Material Workflow

A unified workflow for AI + human collaboration on UE 5.7 material node graphs. Your AI writes a standard `.matgraph.json` format; a local viewer renders the node graph live, with a faithful, accurate representation of UE expressions.

[繁體中文](./README.zh-TW.md)

---

## Why

- **No more text-wall node graphs.** AI describes materials in a strict JSON schema; the viewer renders them as real-looking UE nodes.
- **No more hallucinated node names.** A pinned UE 5.7 node DB (142 expressions) is the source of truth — AI must use existing types, exact pin names, exact param names.
- **One format across AI tools.** Same `agent-pack/` works in Claude Code, Cursor, Copilot CLI, Gemini CLI, or anything that reads agent rules.

---

## Install

```bash
git clone https://github.com/TerryRouse02/UE-Mat-Workflow.git
cd UE-Mat-Workflow
pnpm install
pnpm build
```

Requires Node 18+ and pnpm. No pnpm? `npx pnpm install` works.

---

## Run the viewer

```bash
pnpm start
# → http://localhost:5790 (auto-tries 5790–5799)
```

The sidebar has two tabs:

| Tab | What it shows |
|---|---|
| **Files** | Your materials, grouped by project folder. Each `graphs/<project>/` with exactly one Material + its MFs is a project; everything else falls under "Unorganized". |
| **Nodes** | The full UE 5.7 node library — search by name or description, browse by category, click a node to see its inputs / outputs / params with type info and badges (verified, dynamic-pin, deprecated). |

The viewer hot-reloads when files change.

---

## Use with AI tools

The `agent-pack/` directory contains the spec, node DB, examples, and rule files for every popular AI coding tool. Point your tool at this repo and start prompting.

### Claude Code

`agent-pack/CLAUDE.md` is auto-discovered. From any conversation in this repo:

> "Build me a stylized water material with normal map distortion and a fresnel rim glow."

Claude reads `SPEC.md`, picks node types from `nodes-ue5.7.json`, and writes the JSON to `graphs/<project>/`. The viewer renders it immediately.

### Cursor

`agent-pack/.cursorrules` is auto-discovered. Same prompt flow.

### Copilot CLI / Codex / generic agents

`agent-pack/AGENTS.md` is the convention most generic agent CLIs follow. Run from the repo root and prompt:

> "Read agent-pack/SPEC.md, then write a metal-rust blended material to graphs/."

### Gemini CLI

`agent-pack/GEMINI.md` is auto-discovered. Same flow.

### Other tools

Any tool that lets you point at a spec file works — give it `agent-pack/SPEC.md` and `agent-pack/nodes-ue5.7.json` and tell it to write `.matgraph.json` files into `graphs/<project>/`.

---

## File layout your AI produces

One project = one folder. The folder holds exactly one Material and any MaterialFunctions it uses (project-local, not shared across projects).

```
graphs/
├── obsidian/
│   ├── obsidian.matgraph.json          [Material]
│   └── fresnel_lib.matgraph.json       [MaterialFunction]
└── flashing_emissive/
    ├── flashing_emissive.matgraph.json
    └── sine_pulse.matgraph.json
```

Convention: folder name = material name. MaterialFunction paths inside the JSON are sibling-relative: `"./fresnel_lib.matgraph.json"`.

---

## Export & share

To send a graph to someone who doesn't have Node:

```bash
node viewer/dist/server/html-export.js export <project>/<name> --out ./shared.html
```

Produces a single self-contained `.html` file. Double-click to view.

---

## Examples

`agent-pack/examples/` has reference graphs in the legacy flat layout. To use them with the new convention:

```bash
mkdir -p graphs/basic_pbr graphs/with_function
cp agent-pack/examples/01_basic_pbr.matgraph.json graphs/basic_pbr/
cp agent-pack/examples/02_with_function.matgraph.json graphs/with_function/
cp agent-pack/examples/functions/blend_normals.matgraph.json graphs/with_function/
```

Then edit `with_function/02_with_function.matgraph.json` and change the MaterialFunction path from `"./functions/blend_normals.matgraph.json"` to `"./blend_normals.matgraph.json"`.

---

## Adding to the node DB

`agent-pack/nodes-ue5.7.json` currently has 142 expressions. To add more:

1. Find the node in the [UE Material Expression Reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/material-expression-reference).
2. Match the existing entry format under `nodes.<NodeName>` (inputs, outputs, params, category, description).
3. Set `verified: true` only after you've cross-checked against UE.
4. Run `pnpm test` to confirm the DB still validates.

---

## Documentation

| Path | What's there |
|---|---|
| `agent-pack/SPEC.md` | The JSON schema and authoring rules your AI must follow. |
| `agent-pack/nodes-ue5.7.json` | UE 5.7 node DB (the AI's vocabulary). |
| `agent-pack/nodes-ue5.7.export.json` | Per-node UE metadata for "Export to UE" (class paths, pin/param/output mappings). |
| `agent-pack/examples/` | Reference `.matgraph.json` files. |
| `tools/node-t3d-metadata/` | UE editor commandlet that auto-extracts & verifies the export metadata from a live UE 5.7 install — see its `README.md` / `docs/AGENT_WORKFLOW.md`. |
| `docs/superpowers/specs/` | Feature specs (design decisions). |
| `docs/superpowers/plans/` | Implementation plans (history). |

---

## Tech

TypeScript monorepo (pnpm workspaces). Viewer is React + React Flow + dagre, served by a tiny Node HTTP + WS server with chokidar watching the `graphs/` directory.

# UE Material Workflow

A unified workflow for AI + human collaboration on UE 5.7 material node graphs. Your AI writes a standard `.matgraph.json` format; a local viewer renders the node graph live, with a faithful, accurate representation of UE expressions.

[繁體中文](./README.zh-TW.md)

---

## Why

- **No more text-wall node graphs.** AI describes materials in a strict JSON schema; the viewer renders them as real-looking UE nodes.
- **No more hallucinated node names.** A pinned UE 5.7 node DB (296 expressions — effectively the full engine set) is the source of truth — AI must use existing types, exact pin names, exact param names. The viewer flags connections that reference a pin which doesn't exist on its node.
- **Final outputs survive export.** You wire results straight into the `MaterialOutput` node; on export the emitter auto-collects them into a `MakeMaterialAttributes` node, so a pasted material needs one wire in UE instead of one per attribute.
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

**Working on the viewer's code?** Use dev mode instead — it rebuilds the UI on every save, so you just refresh the browser (no manual `pnpm build`, no restart):

```bash
pnpm dev
# edit any UI file → save → refresh the browser (F5)
```

(Backend/server `.ts` changes still need a re-run of `pnpm dev`.)

The sidebar has four tabs:

| Tab | What it shows |
|---|---|
| **Files** | Your materials, grouped by project folder. Every sub-folder under `graphs/` is one project showing all its files; only files at the `graphs/` root fall under "Unorganized". |
| **Nodes** | The full UE 5.7 node library — search by name or description, browse by category, click a node to see its inputs / outputs / params with type info and badges (verified, dynamic-pin, deprecated). Below it sit two collapsible browsers: **Official Material Functions** (the engine's `/Engine/Functions` library) and **Project Material Functions** (your own `/Game` MFs, shown live once a WorkMF crawl has indexed them). |
| **Config** | Set the crawl's `ProjectPath` + `EngineRoot` and **Save** (writes `local.config.json` for you), read the environment checklist, run the UE metadata crawls, and configure the **AI assistant** (provider / model / API key) — all button-driven, no terminal. Windows and macOS; see [Refresh UE metadata from the browser](#refresh-ue-metadata-from-the-browser-windows--macos). |
| **Agent** | The built-in conversational material agent — see [Built-in AI material agent](#built-in-ai-material-agent). Hidden in exported HTML snapshots. |

The viewer hot-reloads when files change.

---

## Refresh UE metadata from the browser (Windows / macOS)

The viewer can run the local UE crawls itself — the sidebar's **Config tab** regenerates the node
export metadata, the engine-MF index, or your own project-MF index without touching a terminal.
It's **local-first**: the server, `UnrealEditor-Cmd`, and the browser all run on the same
machine. On Windows the runners use Windows PowerShell 5.1 (`powershell`); on macOS they use
PowerShell Core 7 (`pwsh`, installed via the official PowerShell `.pkg` or `brew install --cask powershell`).

In the Config tab you type your `ProjectPath` + `EngineRoot` and click **Save** (it writes
`tools/node-t3d-metadata/local.config.json` for you — no JSON editing), watch the environment
checklist turn green, then click the crawl buttons. The full walkthrough is in
[`tools/node-t3d-metadata/README.md`](./tools/node-t3d-metadata/README.md#trigger-a-crawl-from-the-web-viewer-no-terminal).

---

## Built-in AI material agent

The viewer's fourth sidebar tab is a conversational agent for people who **don't know materials**:
describe what you want in plain language and it builds the node graph live on the canvas, with a
plain-language change list after every edit. Configure it once in the **Config tab → AI assistant**
(Anthropic or any OpenAI-compatible endpoint — OpenAI, DeepSeek, Groq, or a local Ollama with no
API key); the key is stored in the gitignored `local.config.json` and never leaves your machine
except to the provider you chose.

What it can do:

- **Build & modify graphs** — validated before every write (an invalid graph never reaches disk),
  modifications are incremental patches (add/remove/rewire/retype single nodes) instead of full
  rewrites, changed nodes pulse on the canvas, and every turn is undoable (還原 / 重新生成).
- **See what you see** — the agent can look up the open graph and selected node on demand, so
  "this node" just works, while an open file never becomes the accidental target: "create a
  material" always writes a NEW file (overwriting an existing one requires your explicit say-so).
  The Inspector has an *ask AI* button, and the import dialog can auto-explain a graph you just
  pasted from UE.
- **Propose, never seize** — actions that touch your machine or the public node DB (running a
  UE metadata crawl, editing/adding a DB entry) only ever appear as **confirmation cards**; nothing
  runs until you click approve. Approved crawls report their outcome back into the conversation
  automatically so the agent can resume or diagnose failures (`read_crawl_log`).
- **Ship to UE** — ask for the clipboard and it copies the graph as paste-ready T3D (same path as
  the header export button); paste into UE's Material Editor with Ctrl+V.
- **Research** — zero-key web search + SSRF-guarded page fetch for knowledge newer than the model.
- **Stay long-lived** — persistent sessions (switch / replay / delete), two-layer memory, automatic
  context compaction, per-turn token usage, and one-click Markdown export of the conversation.
- **Stay on topic** — the agent only talks UE materials / shaders / game dev. Unrelated messages
  get a reminder, then a refusal; a third strike closes and deletes the session.

Type `/` in the input box for quick commands (`/validate`, `/explain`, `/export`, `/compact`,
`/log`, `/help`, `/regen`, `/undo`, `/md`, `/new`, `/crawlmf`). Developers: the full design
contract lives in [`viewer/AGENT_DESIGN.md`](./viewer/AGENT_DESIGN.md).

---

## Use with AI tools

The `agent-pack/` directory contains the spec, node DB, examples, and rule files for every popular AI coding tool. Point your tool at this repo and start prompting.

### Token-efficient DB access

The full `nodes-ue*.json` authoring DB is 45K–120K tokens — too large to inline into every AI session. The agent rules use a **progressive-disclosure** protocol instead:

1. Read `agent-pack/nodes-ue<version>.index.json` (~12K tokens, safe to read whole) to choose nodes. The index is auto-generated and CI-gated against the full DB.
2. Fetch full entries for the nodes you will use: `node agent-pack/query.js node 5.7 Multiply Lerp Fresnel`
3. Look up Material Function pin signatures: `node agent-pack/query.js mf "/Engine/Functions/.../Foo.Foo"`

`nodes-ue*.export.json` is consumed by the viewer's export/import code only — an authoring agent never reads it. `enginemf-index-ue*.json` is point-query only via `query.js mf`.

### Claude Code

`agent-pack/CLAUDE.md` is auto-discovered. From any conversation in this repo:

> "Build me a stylized water material with normal map distortion and a fresnel rim glow."

Claude reads `SPEC.md`, consults `nodes-ue5.7.index.json` for node selection, fetches full entries via `query.js`, and writes the JSON to `graphs/<project>/`. The viewer renders it immediately.

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

## Import from UE

The clipboard bridge is **bidirectional**. In the viewer, click **導入 (Import)**, then
paste a UE material selection — select nodes in the Material Editor, `Ctrl+C`, and paste
into the box. The viewer reconstructs a `.matgraph.json` (node types, params, connections,
comments, and reroutes) **fully locally — no Unreal needed**, writes it as a new project
folder under `graphs/`, and opens it.

Anything it can't map — a UE class not in the node DB, or a Material Function whose pin
names need its definition — is surfaced as a warning, never invented. (Reroute "knot" nodes
are collapsed: the wire is re-pointed at the reroute's real source so nothing dangles.)

---

## Examples

`agent-pack/examples/` holds reference graphs, each already a compliant project folder (`<name>/<name>.matgraph.json`, with any MaterialFunction copied alongside it — not shared). To try one, copy its whole folder into `graphs/`:

```bash
cp -r agent-pack/examples/02_with_function graphs/
```

The viewer then groups it as a project in the sidebar and it exports to UE as-is — no path edits needed.

---

## Multi-version UE support

The node DB is **version-scoped**. It ships as version pairs in `agent-pack/`:

- `nodes-ue<major.minor>.json` — the authoring DB (the AI's vocabulary).
- `nodes-ue<major.minor>.export.json` — per-node UE metadata for "Export to UE".

Today that's `nodes-ue5.7.json` + `nodes-ue5.7.export.json`; later `nodes-ue5.8.*`, and so on. The viewer auto-discovers every version present at build time and selects the pair matching each graph's `ueVersion` field. A graph that targets an unsupported version shows a clear banner in the viewer and is blocked from reliable export.

**Extending to a new version is a data drop, no code change:** generate both files with the UE commandlet (`tools/node-t3d-metadata`) against that engine version and drop them in `agent-pack/`.

> When prompting an AI, tell it which UE version you target first — the agent rules require it to confirm a supported version before writing any `.matgraph.json`.

---

## Adding to the node DB

The DB is version-scoped: edit the pair for the version you target (e.g. `agent-pack/nodes-ue5.7.json`, currently 296 expressions). To add more:

1. Find the node in the [UE Material Expression Reference](https://dev.epicgames.com/documentation/en-us/unreal-engine/material-expression-reference).
2. Match the existing entry format under `nodes.<NodeName>` (inputs, outputs, params, category, description).
3. Set `verified: true` only after you've cross-checked against UE. (Auto-discovered nodes that haven't been hand-checked stay `verified: false` — pin names are reflected from UE, but types may be placeholders.)
4. Run `pnpm test` to confirm the DB still validates.

**Don't know what's missing?** The commandlet can tell you. Its node-discovery mode enumerates
every `UMaterialExpression` the engine compiles in and diffs it against the DB, so you get a
report of exactly which nodes are absent — see `tools/node-t3d-metadata/docs/NODE_DISCOVERY.md`.

(To support a whole new UE version instead of extending an existing one, see [Multi-version UE support](#multi-version-ue-support) — generate the version pair via the commandlet rather than editing by hand.)

---

## Documentation

| Path | What's there |
|---|---|
| `agent-pack/SPEC.md` | The JSON schema and authoring rules your AI must follow. |
| `agent-pack/SPEC-DETAILS.md` | On-demand depth: full clipboard export/import spec, Set/Get attribute GUIDs, dynamic-pin field docs. Load only when SPEC.md points here. |
| `agent-pack/nodes-ue<version>.json` | Version-scoped node DB (the AI's full vocabulary), e.g. `nodes-ue5.7.json`. 45K–120K tokens — never read wholesale; use the index + query.js. |
| `agent-pack/nodes-ue<version>.index.json` | Generated minimal index (~12K tokens, safe to read whole). Lists every node with category, one-line description, and flags. Regenerated by `tools/node-t3d-metadata/gen-node-index.js`; CI-gated against the full DB. |
| `agent-pack/query.js` | Zero-dependency lookup CLI. `node agent-pack/query.js node 5.7 Multiply Lerp` fetches full DB entries; `node agent-pack/query.js mf "<path>"` fetches MF pin signatures; `node agent-pack/query.js search 5.7 noise` searches by keyword. |
| `agent-pack/nodes-ue<version>.export.json` | Per-version UE metadata for "Export to UE" (class paths, pin/param/output mappings). Viewer-only — authoring agents never read this. |
| `agent-pack/examples/` | Reference `.matgraph.json` files. |
| `tools/node-t3d-metadata/` | UE editor commandlet that auto-extracts & verifies the export metadata from a live UE install (run per version) — see its `README.md` / `docs/AGENT_WORKFLOW.md`. |

---

## Tech

TypeScript monorepo (pnpm workspaces). Viewer is React + React Flow + dagre, served by a tiny Node HTTP + WS server with chokidar watching the `graphs/` directory.

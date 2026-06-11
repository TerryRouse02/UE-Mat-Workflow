# CLAUDE.md — developing this repo

This file is the **architecture map for anyone (human or agent) hacking on the codebase**.
Read it once and you should know where everything lives, how data flows, what you must not
break, and how to make the common changes.

> Scope: this is about **building the tool**. If your task is **authoring UE materials**
> (writing `.matgraph.json`), the rules live in `agent-pack/SPEC.md` + `agent-pack/CLAUDE.md`,
> not here.

## TL;DR

- **Product:** a local viewer + format for AI↔human collaboration on UE 5.7 material node
  graphs. The AI writes a strict `.matgraph.json`; a local web app renders it as real-looking
  UE nodes, exports to / imports from the UE clipboard, and can refresh its UE metadata.
- **Stack:** TypeScript monorepo (pnpm workspaces). `viewer/server` = native Node http+ws.
  `viewer/web` = Vite + React + React Flow + dagre. `tools/node-t3d-metadata` = a UE editor
  commandlet + PowerShell (Windows `powershell` 5.1 or macOS `pwsh` 7). `agent-pack/` = the shipped data + agent rules.
- **Build:** `pnpm build`  **Test:** `pnpm -r test` (630 node + 72 react) + `node --test "tools/node-t3d-metadata/tests/**/*.test.js"` (114)  **Run:** `pnpm dev` (or `pnpm start`) → http://localhost:5790
- **Before committing public data, run the parity audit:** `node tools/node-t3d-metadata/audit-export-meta.js` (must exit 0).

## Mental model (data flow)

```
AI/human ──writes──> graphs/<project>/<name>.matgraph.json
                          │  (chokidar watch, 300ms debounce)
                   viewer/server ── validate (schema.ts) ── resolve MaterialFunction pins
                          │           (mf-resolver.ts + workmf-index + enginemf-index)
                          │  WebSocket (127.0.0.1)
                   viewer/web ── dagre layout ── React Flow render
                          │
        ┌─────────────────┼──────────────────────────┐
   Export → UE          Import ← UE              Config tab → crawl
   (clipboard T3D)      (paste T3D, local)       (spawns UnrealEditor-Cmd via
   Header "導出"        Header "導入"            tools/ PowerShell, regenerates
                                                 agent-pack metadata, live-refresh)
```

The node **DB is the source of truth**: the AI may only use node types/pins that exist in
`agent-pack/nodes-ue<version>.json`. The viewer flags anything that references a missing pin.

## Repo map

```
agent-pack/                 SHIPPED product data + agent rules (public, must stay clean)
  nodes-ue5.7.json          authoring DB — node types/pins/params (296 expressions)
  nodes-ue5.7.index.json    generated minimal index (~12K tokens); safe to read whole; CI-gated
  nodes-ue5.7.export.json   per-node UE metadata for clipboard export (class paths, GUIDs)
  query.js                  zero-dep lookup CLI: node/mf/search queries against the DB and MF indexes
  query-lib.js              the lookup logic behind query.js (CJS exports) — also consumed by
                            viewer/server/agent (query-bridge.ts); the ONLY home for query logic
  enginemf-index-ue5.7.json official /Engine Material Function signatures (committed)
  workmf-index.json         the USER's own /Game MF signatures — GITIGNORED, never shipped
  SPEC.md / SPEC-DETAILS.md / CLAUDE.md / AGENTS.md / GEMINI.md / .cursorrules   authoring rules
  examples/                 reference .matgraph.json project folders
graphs/                     AI output (gitignored except the stress_* regression fixtures)
viewer/
  server/                   Node http + single WebSocket, binds 127.0.0.1
  web/                      Vite + React SPA (the viewer UI)
tools/node-t3d-metadata/    UE commandlet (C++) + PowerShell runners + compiled plugin
  compiled/                 pre-built Win64 plugin (committed; loaded externally, see Gotchas)
  docs/                     per-mode tooling docs (WORKMF / ENGINE_MF / NODE_DISCOVERY / ...)
README.md / README.zh-TW.md user-facing docs (EN is source of truth; zh-TW mirrors it)
```

## viewer/server (native http + ws, loopback only)

Entry `index.ts` → `http-server.ts` (`startServer`). Binds **127.0.0.1** (base port 5790,
auto-tries 5790–5799). One WebSocket carries everything live.

- `http-server.ts` — routes + WS. HTTP: `GET /api/env`, `GET /api/agent-pack/:file`
  (filename allowlist), `GET /api/workmf`, `POST /api/config` (extended with optional `Llm`
  object for AI config), `POST /api/crawl`, `POST /api/import`,
  `POST /api/agent/chat` (SSE — agent conversation loop),
  `GET /api/agent/status` (ProviderStatus — never contains apiKey),
  `POST /api/agent/explain` (one-shot LLM node explanation; JSON response; sameOrigin; concurrent-safe),
  `POST /api/agent/undo` (restore previous checkpoint turn; sameOrigin; 409 while streaming),
  `POST /api/agent/regenerate` (rewind last user turn — files+history+transcript — and return its text for a client re-send; sameOrigin; 409 while streaming),
  `POST /api/agent/db-edit` (apply a user-approved node-DB edit: validate → write → regen index → parity audit, rollback on failure; sameOrigin; single-flight),
  `POST /api/agent/reset` (abort in-flight chat + clear session; sameOrigin),
  `POST /api/agent/test` (verify the SAVED LLM config with one minimal request; sameOrigin),
  `GET/POST /api/agent/sessions` + `GET/DELETE /api/agent/sessions/:id` (persistent sessions: list/create/replay/delete);
  static serve of `web/dist`. WS msgs: `open` (→ resolved graph),
  `listFiles`, crawl progress broadcast.
- `server/agent/` — the built-in conversational material agent (providers, 23-tool loop,
  checkpoints/undo, sessions, memory, compaction, web access, DB-edit apply). The design
  contract + per-file map live in `viewer/AGENT_DESIGN.md` — read that before touching it.
  Key invariant: the agent only PROPOSES crawls/DB edits; user-approved cards call the
  state-changing endpoints. `contextTokens` (last round in+out) gates compaction and the
  context ceiling; `totalTokens` is cumulative spend for display only.
- `server/agent/explain.ts` — `explainNode()` one-shot LLM call (no tools); `buildGraphContext()` graph connection summary; `RESERVED_NODE_DESCRIPTIONS` built-in zh-TW descriptions for the four reserved node types.
- `schema.ts` — `validateGraph` (the `.matgraph.json` contract). `graph-loader.ts` — read+parse+validate.
- `mf-resolver.ts` — resolves `MaterialFunctionCall` pins from sibling `.matgraph.json`,
  the engine-MF index, or the work-MF index. `workmf-index.ts` / `workmf-types.ts` (node-free types).
- `watcher.ts` — chokidar over `graphs/`, debounced; fans out fileList + re-resolved graphs.
- `crawl-runner.ts` — **the only place crawl commands live** (`defaultCommandFor`); single-job lock.
  `crawl-env.ts` — `probeEnv` (the 6 checks that gate the crawl button). `crawl-types.ts` — node-free types.
- `html-export.ts` — bakes a self-contained snapshot `.html` (no server) for sharing.
- `ws-protocol.ts` — wire types; **duplicated** in `web/src/protocol.ts`, keep them in sync.

## viewer/web (Vite + React + React Flow + dagre)

- `store.tsx` — global state: reducer + WS client + crawl lifecycle + `saveConfig`.
  Connection is `live | reconnecting | snapshot` (snapshot = exported HTML, no server).
- `dbContext.tsx` — derives the active node DB / export metadata / engine-MF / work-MF for the
  open graph's `ueVersion`. **Baked at build time** (`dbRegistry.ts`, `engineMfRegistry.ts` via
  `import.meta.glob`) so snapshot/offline renders; **re-fetched at runtime** in live mode
  (`agentPackClient.ts`) so a crawl refreshes without a rebuild.
- `Graph.tsx` + `layout.ts` — React Flow render; dagre auto-layout (no x/y in the JSON).
  Hover (≈500ms) on a node opens `NodeExplainPopover`; pane-click / Escape closes it.
- `Sidebar.tsx` — four tabs: **Files** (`FileList`), **Nodes** (`NodeLibrary`), **Config** (`ConfigPanel`), **Agent** (`AgentChat` — hidden in snapshot mode; in live mode it stays MOUNTED across tab switches via a display-toggled keep-alive wrapper so pending crawl reports / in-flight streams survive).
- `Header.tsx` — export to UE (`export/ueT3D.ts`) + import from UE (`ImportModal`).
- `crawlRequest.ts` — POST /api/crawl + the `CrawlKind` union (web side).
- `web/src/agent/AgentChat.tsx` — 4th Sidebar tab: conversational material agent UI (M3+M4+M5).
- `web/src/agent/NodeExplainPopover.tsx` — hover node explain popover; Layer 1 = DB description+pins (zero fetch); Layer 2 = 「深入解說」button → POST /api/agent/explain; hidden in snapshot mode.

## tools/node-t3d-metadata (Windows + macOS)

A UE editor commandlet (`plugin-src/`, C++) wrapped by PowerShell runners. Modes: node-metadata
export, Engine-MF index, WorkMF index, node discovery. The same `.ps1` runners serve both OSes,
platform-detecting the editor binary via `$IsMacOS` (Win64 `UnrealEditor-Cmd.exe` vs Mac
`UnrealEditor-Cmd`); `crawl-runner.ts` spawns `powershell` on Windows and `pwsh` on macOS. The
committed `compiled/` plugin is a prebuilt **Win64** binary and is **mounted externally**
(`-plugin=<.uplugin>`) — nothing is copied into the user's UE project; on macOS you build the
plugin's gitignored `Binaries/Mac` locally via `Package-Plugin.ps1`. See `tools/node-t3d-metadata/README.md`.

## Hard invariants — do not violate

1. **Public-artifact purity.** `agent-pack/nodes-ue*.json`, `*.export.json`,
   `enginemf-index-ue*.json`, and `graphs/stress_*` are public UE-5.7 artifacts. They may contain
   **only clean Epic / public UE 5.7 data** — never a private project's custom nodes or material
   attributes. The work-MF index is the *only* home for project-specific data, and it is gitignored.
2. **No proprietary or identifying data in committed files** — including in code, comments, or
   even "guard" checks that would reveal a private naming scheme.
3. **`workmf-index.json` is server-only.** Never `import.meta.glob` it, never bake it into a bundle
   or the HTML export — that would leak a user's `/Game` asset paths into shipped files.
4. **`.ps1` files stay pure ASCII.** Windows PowerShell 5.1 mis-reads non-BOM UTF-8 (em-dash, ellipsis).
5. **Single sources of truth.** Crawl commands: `crawl-runner.ts` `defaultCommandFor` only. Wire
   types: `ws-protocol.ts` ↔ `web/src/protocol.ts` (mirror). Node-free shared types
   (`crawl-types.ts`, `workmf-types.ts`) exist so the web tsc program never pulls in `node:` typings.
6. **No `x`/`y` positions in `.matgraph.json`.** Layout is dagre's job.

## Common changes (recipes)

- **Add/fix a node in the DB:** edit `agent-pack/nodes-ue5.7.json` (`nodes.<Name>`: inputs/outputs/
  params/category/description). `verified: true` only after hand-checking against UE. Then run
  `node tools/node-t3d-metadata/gen-node-index.js` to regenerate the index (CI's parity audit fails
  on index drift). Run `pnpm test`.
- **Support a new UE version:** it's a *data drop* — generate `nodes-ue<v>.json` + `.export.json`
  via the commandlet and place them in `agent-pack/`. The web auto-discovers versions at build time.
- **Add a crawl kind:** update **all four** — the `switch` in `crawl-runner.ts` `defaultCommandFor`,
  the `CrawlKind` union in `crawl-runner.ts` **and** `web/src/crawlRequest.ts`, and the allowlist
  line in `http-server.ts` `handleCrawl` (`kind !== 'export' && …`). Missing the last → 400.
- **Add a reserved node type** (built-in, not in the DB): handle it in `Graph.tsx` node mapping +
  `export/ueT3D.ts`; the current set is `MaterialOutput`, `FunctionInput`, `FunctionOutput`,
  `MaterialFunctionCall`.

## Gotchas (non-obvious)

- **dagre + lodash node-id trap.** A node id of literally `length` makes dagre's position pass
  throw (lodash treats the result map as array-like). `layout.ts` namespaces every dagre key to
  immunize against any AI-authored id; it also falls back to a grid if dagre throws. Don't un-prefix.
- **Same-origin + loopback guards.** A WS upgrade and the process-spawning `POST /api/crawl` /
  `POST /api/config` are same-origin–checked; the loopback bind stops remote hosts. Read endpoints
  rely on the browser's same-origin policy (no CORS headers).
- **Live-refresh paths differ by data kind.** export/enginemf rewrite *public* agent-pack files →
  `metadataVersion` bumps → `dbContext` re-fetches. workmf rewrites the *server-only* index →
  `workMfVersion` bumps + the store re-sends `open` for the breadcrumb (re-resolve in place).
- **Export crawl self-heals array pins.** The commandlet emits a few array-element input
  properties — `MakeMaterialAttributes.CustomizedUVs_*`, `QualitySwitch` Medium/Epic,
  `FeatureLevelSwitch` SM6 — as their raw pin name instead of UE's `Name(N)` T3D array syntax
  (its override table is incomplete). The maintenance pipeline's "Heal export metadata array pins"
  step (`heal-export-meta.js`, canonical map in `array-pin-properties.js`) re-applies them after
  every crawl, so the web "export" crawl never regresses them; the parity audit now also fails on
  drift (`arrayPins`). The heal is a format-preserving string-splice because the export JSON is
  written by UE's JSON writer (tabs, brace-on-own-line, no trailing newline), which
  `JSON.stringify` does not reproduce — never re-serialize that file wholesale.
- **External plugin, no ABI check.** The crawl loads the committed `compiled/` plugin via
  `-plugin=`; the env probe only checks the DLL *exists*, not that it matches the user's engine
  build. A mismatch surfaces as a crawl-time load error → repackage with `-ForcePackage`.
- **snapshot ≠ live.** The exported single-file HTML has no server: it uses baked data, hides the
  Config tab's crawl controls, and never fetches the work-MF index.

## Read next

- `agent-pack/SPEC.md` — the `.matgraph.json` contract (authoring side).
- `viewer/AGENT_DESIGN.md` — the built-in conversational agent: module map, tool contract,
  endpoints, eval corpus, and the feature snapshot (§12).
- `tools/node-t3d-metadata/README.md` — the commandlet, the crawls, the Config-tab walkthrough.
- `README.md` — the user-facing overview.

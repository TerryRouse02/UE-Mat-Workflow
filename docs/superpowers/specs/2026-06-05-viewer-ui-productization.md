# Viewer UI productization — implement the Designer mockup

**Goal:** Re-skin `viewer/web` to the Designer's productized UI and wire in every existing
feature, adding the backend the design implies — while leaving the node-graph **canvas**
visually as it is today.

**Source of truth:** the Designer's standalone HTML, decoded to
`/tmp/ue-design.html` (CSS) + `/tmp/ue-design-src/01..09.jsx` (components). Functional brief:
`docs/CLAUDE_DESIGNER_BRIEF.md`.

---

## Decisions (locked with the user, 2026-06-05)

- **D1 — Canvas stays as-is.** Keep the current node-graph rendering (ReactFlow + dagre,
  our node/pin/edge coloring and content). The mockup's node graph is busier (more pin
  colors, animated wires); the user prefers ours. The Designer look applies to **shell,
  header, left sidebar (Files/Nodes/Config), Inspector, overlays, toasts, theme tokens** —
  NOT the canvas nodes/edges.
- **D2 — Data-viz palette = current, not the mockup's.** Pin-type and category colors used
  in the Inspector, the canvas legend, and the Nodes-tab signatures follow the **current
  app's** palette so they stay consistent with the (unchanged) canvas. Only the **chrome /
  panel / status / accent** tokens come from the mockup.
- **D3 — Build all four backend-touching features now:** ⌘K command palette, crawl
  freshness ("last crawled"), per-node crawl metadata, stop-crawl.
- **D4 — Drop the `.metabar`.** It is the Designer's prototype state-switcher, not a feature.
- **D5 — Labels standardize to zh-TW**, matching the mockup.

## In scope (wire to existing state)

3-tab left sidebar with a **Config status dot** (run/err from `crawl.status`); header chrome
(logo + UE-version badge, breadcrumb wired to `breadcrumb`/`popBreadcrumb`, ⌘K, connection
pill from `connection`, 導入/導出, settings→Config, more-menu→snapshot export); banners
(unsupported-version, snapshot, reconnecting); Files panel (search, agent groups, striped
**「專案母材質（爬取）」** section with the **empty "尚未爬取…前往爬取" placeholder**, Functions);
Nodes browser (types / MF segments); Config (§1 paths→`saveConfig`, §2 env 6-check gate→
`state.env`, §3 two-tier crawl→`startCrawl`, mapping projMF=`workmf`, projMat=`projectmat`,
nodeExport=`export`, engineMF=`enginemf`); full-panel **run takeover** (live log, success
rstats, error with 自行修復/維護者 fixpill + 完整log — reuse current `diagnoseCrawl`);
Inspector (節點詳情 / 圖健康度, issues→`focusNode`); large-graph confirm modal (replaces
`window.confirm`, uses `shouldConfirmOpen`); toast restyle.

## New backend (server)

- **Crawl freshness.** Persist last-success timestamp per kind to a gitignored, server-only
  file (e.g. `agent-pack/crawl-freshness.json` — public-artifact purity: local-only, never
  shipped). Serve via `GET /api/env` (extend `EnvStatus`) or a small `GET /api/crawl-freshness`.
  Store holds it; `FreshBadge` (never/has/now) + Inspector "上次爬取" read it. "now" =
  `justRan` after a success this session.
- **Stop-crawl.** `POST /api/crawl/cancel` (same-origin + loopback guarded like `/api/crawl`):
  kills the running job's child process; runner emits `crawlDone {status:'error'|'cancelled'}`.
  Add `stopCrawl()` to the store; wire the run-panel "停止爬取" button.
- **Per-node crawl metadata.** Derive provenance at resolve time — for each node, the source
  that resolved it: node-type DB (`export`), project-MF index (`workmf`), engine-MF index
  (`enginemf`), or project-material mirror (`projectmat`) — plus that source's last-crawl
  timestamp (from the freshness file). Surface on the graph payload (or compute client-side
  from node type + db origin). **Freshness:** `missing` = unresolved MF / unknown node type
  (already detected by `graphDiagnostics`); otherwise `fresh`. ("stale" has no reliable
  signal yet → not emitted; revisit if we add per-asset source mtimes.)
- **`指令成本` (instruction cost): omitted** — no data source without UE shader-compile
  analysis. The Inspector crawl-metadata section ships without this field rather than faking it.
- Wire types mirrored: `ws-protocol.ts` ↔ `web/src/protocol.ts`; node-free types stay node-free.

## Deferred / greyed-disabled (read-only app or no data) — with a tooltip

- **插入到畫布** (Nodes tab) — the viewer is read-only; button disabled.
- **查找使用 / `×N` used-by counts** — usage graph not tracked; hidden/disabled. (Could be
  computed later by scanning `MaterialFunctionCall` references across graphs.)
- **漸進開啟 (progressive open)** — not implemented; the big-graph modal keeps **取消 / 仍要開啟**
  only (仍要開啟 = open now).
- **切換引擎** (mismatch banner) — no engine-switch mechanism; banner is informational only.

## Design system

Rewrite `theme.css` to the mockup's **chrome/panel/status/accent** tokens (`--bg-app/-panel/
-panel-2/-canvas/-elev`, `--border/-strong`, `--hairline`, `--text/-dim/-mute`, `--accent`
`#2dd4bf`, `--ok/warn/error/info`, radii; Inter + JetBrains Mono). Port the mockup's CSS for
chrome, panels, files, inspector, config/crawl, modals, cmdk, toast, motion. **Do not** import
the mockup's `PIN_TYPES`/`CATEGORIES` colors — keep the current graph palette.

## Component map (`viewer/web/src`)

| Current | Becomes | Notes |
|---|---|---|
| `App.tsx` | shell: `Chrome` + `Banner` + body grid (`--left` width: files/config/config-running) + overlays | mount CommandPalette, BigGraphConfirm, Toast |
| `Header.tsx` | `Chrome` | logo/ver, breadcrumb, ⌘K, conn pill, 導入/導出, settings, more-menu |
| `Sidebar.tsx` | `LeftSidebar` w/ `.lstabs` | Config tab dot ← `crawl.status` |
| `FileList.tsx` | `FilesPanel` | groups, crawled striped + empty placeholder, big-mark → confirm |
| `NodeLibrary.tsx` | `NodesPanel` | types/MF segments; insert disabled |
| `ConfigPanel.tsx` | `ConfigPanel` (cfg-sec ×3) + `RunPanel` | freshness, stop, snapshot/reconnect states |
| `Inspector.tsx` | `Inspector` (insp-mode) | node detail + crawl-metadata + health |
| `Graph.tsx` | unchanged rendering | only ensure it sits in the new canvas frame; bg token consistency |
| (new) | `CommandPalette.tsx`, `BigGraphConfirm.tsx` | ⌘K + large-graph modal |
| `Toast.tsx` | restyle | same API |
| `theme.css` (+ per-area css) | adopt mockup CSS | keep graph palette |

## Verification

`tsc -p viewer/tsconfig.json` (server) + `viewer/web` `tsc -b && vite build` clean; targeted
vitest green (import/crawl/diagnostics/new units). Live crawl visual states can't run on this
Mac (env gate fails — Windows-only); covered by unit tests + the design's state model; user
does the live smoke on Windows.

## Rollout (independent areas — suitable for one subagent each)

1. Theme tokens + app shell (Chrome/Banner/body grid).
2. Files panel. 3. Nodes panel. 4. Config + crawl run-panel (client).
5. Inspector (+ node crawl-metadata). 6. Overlays (⌘K palette, big-graph modal, toast).
7. Backend: crawl-freshness store + `/api/crawl/cancel` + node provenance + wire types.

Areas 1–6 are client-only and mostly parallelizable; area 7 (backend) lands first or alongside
since 4/5 consume it. Canvas (`Graph.tsx`) is intentionally untouched beyond frame/token fit.

## Risks

Large surface, but keeping the canvas frozen removes the riskiest part. The backend node
provenance is the subtlest piece — ship the minimal honest version (resolved-source + its
timestamp; missing for unresolved) and grow later. Watch the `ws-protocol ↔ protocol` mirror
and the node-free type boundary.

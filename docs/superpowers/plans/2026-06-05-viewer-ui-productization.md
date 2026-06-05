# Viewer UI Productization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin `viewer/web` to the Designer mockup and wire every existing feature, adding
the backend the design implies — while leaving the node-graph **canvas** visually unchanged.

**Architecture:** React SPA (Vite + ReactFlow + dagre) on a native Node http+ws server. The
mockup's markup + full CSS are committed at `docs/design-ref/` (`mockup-with-css.html` = all
CSS; `components/01..09-*.jsx` = the component sources). We port those components into the
real app, swapping mock data for the live store API. The canvas (`Graph.tsx`) keeps its
current node/edge/colour rendering.

**Tech stack:** TypeScript, React 18, ReactFlow, dagre; server = native http + ws; tests =
vitest (web/server) + node:test (tools). Verify with `viewer/node_modules/.bin/{tsc,vitest,vite}`
(pnpm is not on PATH).

## Conventions for this plan

- **Markup/CSS source of truth = `docs/design-ref/`.** A UI task ports the named design
  component, replacing its mock constants (`NODES`, `FILES`, `CRAWL_KINDS`, …) with the live
  wiring specified in that task. CSS classes are copied verbatim from `mockup-with-css.html`
  into the per-area CSS file named in the task. New *logic*/backend code is given in full here.
- **zh-TW labels** throughout (the mockup is already zh-TW).
- **Token aliasing:** Task A adds the design tokens and keeps the old names as aliases, so
  every existing rule keeps working until its area migrates.
- **Per-area CSS files** (`chrome.css`, `files.css`, `nodes.css`, `config.css`,
  `inspector.css`, `overlays.css`) imported by their component — only `theme.css` is shared
  (tokens + `.app`/`.body`/`.panel`/`.btn`/`.banner`). This lets Tasks D–I run in parallel.
- **Verify after every task:** `viewer/node_modules/.bin/tsc -p viewer/tsconfig.json` (server)
  **and** `cd viewer/web && ../node_modules/.bin/tsc -b && ../node_modules/.bin/vite build`
  (web) must be clean; run the relevant `vitest` files. Live crawl/UE states can't run on this
  Mac (env gate is Windows-only) — those are user-verified on Windows.
- **Commit after every task** (feature branch `feat/viewer-workflow-enhancements`; user pushes).

## Dependency order (also the execution order)

```
A (theme tokens + Icon)  ─┐
B (backend: freshness/cancel/provenance + store) ─┤→ C (shell + ALL cross-cutting wiring) →  D,E,F,G,H,I  (parallel)
```

A and B are independent and may run together. **C must land before D–I** (it lifts the shared
state and threads the props they consume). D–I touch mostly their own component + CSS files.

---

## Task A: Theme tokens + shared Icon

**Files:**
- Modify: `viewer/web/src/theme.css` (`:root`, `.app`, `.body`, add `.panel*`, `.btn*`, `.banner`)
- Create: `viewer/web/src/Icon.tsx`
- Modify: `viewer/web/index.html` (font preconnect/link)
- Reference: `docs/design-ref/mockup-with-css.html` (lines 439–533), `docs/design-ref/components/03-icons.jsx`

- [ ] **Step 1 — Rewrite `:root` with design tokens + aliases.** Replace the `:root` block in
  `theme.css` with the design tokens and keep old names as aliases:

```css
:root {
  --font-sans: "Inter", -apple-system, "Segoe UI", Roboto, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", "Roboto Mono", ui-monospace, Menlo, monospace;
  --ok:#4ec46e; --warn:#e0a64e; --error:#e0594e; --info:#4ea0d6;
  --bg-app:#1a1d23; --bg-panel:#21252e; --bg-panel-2:#1c2028; --bg-canvas:#16181d;
  --bg-elev:#272c37; --border:#2d323e; --border-strong:#3a4150; --hairline:#262b34;
  --text:#dde2ea; --text-dim:#99a2b1; --text-mute:#69707d;
  --accent:#2dd4bf; --accent-dim:#1d8c80; --accent-ghost:rgba(45,212,191,.13);
  --node-bg:#262b35; --node-border:#373e4b; --node-head:#2c323d; --node-sel:#2dd4bf;
  --grid:rgba(255,255,255,.045); --scroll:#3a414e; --scroll-h:#4a5260;
  --panel-radius:7px; --chip-radius:5px; --radius:7px; --row:32px; --fs:13px;
  /* aliases: keep old names working until each area migrates */
  --bg0:var(--bg-canvas); --bg1:var(--bg-panel); --bg2:var(--bg-elev);
  --bd:var(--border); --hed:var(--bg-panel);
  --fg:var(--text); --fg-dim:var(--text-dim); --fg-faint:var(--text-mute);
  --err:var(--error);
}
```

- [ ] **Step 2 — Load fonts.** In `viewer/web/index.html` `<head>`, add the Google Fonts
  preconnect + Inter + JetBrains Mono `<link>` tags (copy from `mockup-with-css.html` head, or
  use the `@font-face` block if offline-bundling is preferred — system fallback is acceptable).

- [ ] **Step 3 — Shell base + body grid.** In `theme.css`: set `html,body,#root{height:100%}`;
  `.app{display:flex;flex-direction:column;height:100%;background:var(--bg-app);color:var(--text);font-family:var(--font-sans)}`;
  rewrite `.body` to `display:grid;grid-template-columns:var(--left,272px) 1fr var(--right,320px);flex:1;min-height:0`.
  Add `.panel`, `.panel.left`, `.panel.right`, `.panel-head` (+ `.h/.count/.grow`), `.iconbtn`,
  `.btn`/`.btn.primary`/`.btn.sm`/`.btn.ghost`/`.btn:disabled`, `.banner`/`.banner.warn`/`.banner.info`
  verbatim from `mockup-with-css.html` lines 508–533, 517–521, 525–531. Add
  `.panel.left{transition:width .2s ease}`.

- [ ] **Step 4 — Create `Icon.tsx`.** Port the `ICONS` map + `Icon` function from
  `docs/design-ref/components/03-icons.jsx` into a typed component:
  `export type IconName = ...; export function Icon({name,size=16,className,style}:{name:IconName;size?:number;className?:string;style?:React.CSSProperties}){...}`.
  Self-contained inline SVG (no new dependency). (If `grep -r lucide viewer/web/package.json`
  shows lucide-react is already present, you may use it instead — but the inline port is the default.)

- [ ] **Step 5 — Verify + commit.** `tsc -b && vite build` clean (old classes still resolve via
  aliases; accent visibly turns teal). `git commit -m "feat(viewer): design tokens + shared Icon component"`.

---

## Task B: Backend — crawl freshness, stop-crawl, node provenance

**Files:**
- Create: `viewer/server/crawl-freshness.ts`, `viewer/tests/crawl-freshness.test.ts`
- Modify: `viewer/server/crawl-types.ts` (CrawlFreshness + EnvStatus.freshness)
- Modify: `viewer/server/crawl-runner.ts` (`cancel()`), `viewer/tests/crawl-runner*.test.ts`
- Modify: `viewer/server/http-server.ts` (record freshness; `/api/crawl/cancel`; serve freshness; provenance in `buildGraphMessage`)
- Modify: `viewer/server/mf-resolver.ts` (+ provenance), `viewer/tests/mf-resolver*.test.ts`
- Modify: `viewer/server/ws-protocol.ts` + `viewer/web/src/protocol.ts` (NodeSource/NodeProvenance + GraphPayload.nodeProvenance — **mirror**)
- Modify: `viewer/web/src/crawlRequest.ts` (`cancelCrawlRequest`), `viewer/web/src/store.tsx` (`stopCrawl`, `resetCrawl`, refresh-on-success)
- Modify: `.gitignore` (add `agent-pack/crawl-freshness.json`)

- [ ] **Step 1 — Gitignore first.** Add `agent-pack/crawl-freshness.json` next to the
  `agent-pack/workmf-index.json` line in `.gitignore`. (Do this before any code can write it.)

- [ ] **Step 2 — Types (node-free).** In `crawl-types.ts` add:
```ts
export interface CrawlFreshness { export?: string | null; enginemf?: string | null; workmf?: string | null; projectmat?: string | null; }
```
  and add `freshness?: CrawlFreshness;` to `EnvStatus`.

- [ ] **Step 3 — Failing test for freshness store.** `viewer/tests/crawl-freshness.test.ts`:
  in a tmp repo, `recordFreshness(root,'workmf')` then `loadFreshness(root)` returns an ISO
  string for `workmf` and `undefined`/absent for others; a second `recordFreshness(root,'export')`
  preserves `workmf`. `loadFreshness` on a missing file returns `{}`. Run → fails (module missing).

- [ ] **Step 4 — Implement `crawl-freshness.ts`:**
```ts
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { CrawlFreshness } from './crawl-types.js';
export const freshnessPath = (repoRoot: string) => resolve(repoRoot, 'agent-pack', 'crawl-freshness.json');
export async function loadFreshness(repoRoot: string): Promise<CrawlFreshness> {
  try { return JSON.parse(await readFile(freshnessPath(repoRoot), 'utf-8')) as CrawlFreshness; }
  catch { return {}; }
}
export async function recordFreshness(repoRoot: string, kind: keyof CrawlFreshness, nowIso: string): Promise<void> {
  const cur = await loadFreshness(repoRoot);
  cur[kind] = nowIso;
  const p = freshnessPath(repoRoot);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(cur, null, 2) + '\n', 'utf-8');
}
```
  (Pass `nowIso` in so the test is deterministic; the caller supplies `new Date().toISOString()`.)
  Run test → passes.

- [ ] **Step 5 — Runner `cancel()` (TDD).** Failing test in the existing crawl-runner test:
  with a fake long-running `spawnImpl`, `start()` then `cancel()` returns `true`, the child's
  `kill` is called, and a `done` event with `status:'error'` is emitted; `cancel()` when idle
  returns `false`. Then implement: add `cancel(): boolean` to the `CrawlRunner` interface; keep
  `let currentChild: ChildProcess | null = null` in the closure, assign it after `spawnImpl`,
  null it in `finish()`; `cancel()` = `if (status.status!=='running'||!currentChild) return false; try { currentChild.kill(); } catch {} return true;`.
  Run → passes.

- [ ] **Step 6 — Server: record freshness + cancel route.** In `http-server.ts`: import
  `loadFreshness`/`recordFreshness`. In the `runner.start` emit callback, after a `done` with
  `status==='success'`, add `void recordFreshness(opts.repoRoot, kind as keyof CrawlFreshness, new Date().toISOString())`.
  Add route (before static fallback): `POST /api/crawl/cancel` → `sameOrigin` guard (same as
  `/api/crawl`), `const ok = runner.cancel(); sendJson(res, ok?200:409, ok?{cancelled:true}:{error:'no crawl running'})`.
  In `GET /api/env`: `const [env, freshness] = await Promise.all([probeEnv(opts.repoRoot), loadFreshness(opts.repoRoot)]); sendJson(res,200,{...env,freshness})`.

- [ ] **Step 7 — Provenance types (mirror).** In `ws-protocol.ts`:
  `export type NodeSource='export'|'workmf'|'enginemf'|'projectmat'|'unresolved'; export interface NodeProvenance{source:NodeSource;freshnessTs:string|null;}`
  and add `nodeProvenance?: Record<string, NodeProvenance>` to `GraphPayload`. Copy the identical
  three additions into `viewer/web/src/protocol.ts` (CLAUDE.md invariant 5 — keep mirrored).

- [ ] **Step 8 — Resolver tags source (TDD).** In an `mf-resolver` test, assert that an MFC node
  resolved via the engine index gets `nodeProvenance[id].source==='enginemf'`, via workMf →
  `'workmf'`, unresolved → `'unresolved'`. Implement: add `freshnessMap?: CrawlFreshness` to the
  resolve options; build a local `nodeProvenance` and set it in each branch
  (`enginemf`/`workmf`/`unresolved`/`projectmat` for sibling files) with
  `freshnessTs: opts.freshnessMap?.<key> ?? null`; add `nodeProvenance` to the returned
  `ResolvedGraph`. Run → passes.

- [ ] **Step 9 — Server attaches provenance.** In `buildGraphMessage()`: `const freshness = await loadFreshness(opts.repoRoot)`;
  pass `freshnessMap: freshness` to `resolveMaterialFunctions`; second pass —
  `for (const n of resolved.graph.nodes) if (n.type!=='MaterialFunctionCall' && !(n.id in resolved.nodeProvenance)) resolved.nodeProvenance[n.id]={source:'export',freshnessTs:freshness.export??null};`
  Include `nodeProvenance: resolved.nodeProvenance` in the emitted `GraphPayload`.

- [ ] **Step 10 — Web store: stop + reset + refresh-on-success.** In `crawlRequest.ts` add
  `cancelCrawlRequest(fetchImpl=fetch)` → `POST /api/crawl/cancel`. In `store.tsx`: add action
  `{type:'crawlReset'}` → reducer sets `crawl: idleCrawl`; add `stopCrawl()` (calls
  `cancelCrawlRequest()`, dispatch a local `crawlLog` "使用者已要求停止") and `resetCrawl()`
  (dispatch `crawlReset`) to the `Ctx` + value memo; in the WS `crawlDone` handling, when
  `status==='success'` also call `refreshEnv()` so `state.env.freshness` updates.

- [ ] **Step 11 — Verify + commit.** Server `tsc` clean; web `tsc -b && vite build` clean
  (protocol mirror compiles); run `vitest run tests/crawl-freshness.test.ts tests/crawl-runner*.test.ts tests/mf-resolver*.test.ts tests/crawl-api.test.ts`.
  `git commit -m "feat(viewer): crawl freshness store, stop-crawl endpoint, node provenance"`.

---

## Task C: App shell — Chrome, Banner, body grid, and ALL cross-cutting wiring

This task establishes the shared structure D–I depend on. Do it fully before them.

**Files:**
- Create: `viewer/web/src/Chrome.tsx`, `viewer/web/src/Banner.tsx`, `viewer/web/src/chrome.css`
- Modify: `viewer/web/src/App.tsx` (lift state, mount shell + overlay placeholders, thread props)
- Modify: `viewer/web/src/Sidebar.tsx` (accept `tab/setTab` + pass `onGotoConfig`/`onLargeGraph` to FileList)
- Delete: `viewer/web/src/Header.tsx`, `viewer/web/src/header.css`
- Reference: `docs/design-ref/components/09-shell.jsx`

- [ ] **Step 1 — Lift state into `App.Body()`.** Add: `tab/setTab` (`'files'|'nodes'|'config'`,
  default `'files'`); `paletteOpen`; `confirmFile: FileEntry|null`; `importOpen`; move `doExport`
  (the `graphToUET3D` + clipboard logic from `Header.tsx`) into `Body`. Keep existing
  `selectedNodeId/toasts/focusReq` etc.

- [ ] **Step 2 — Body grid + `--left`.** Wrap regions in `<div className="body" style={{'--left': leftW+'px'} as React.CSSProperties}>`
  where `leftW = tab==='config' && state.crawl.status==='running' ? 520 : tab==='config' ? 332 : 290`.
  Left = `<div className="panel left"><Sidebar tab={tab} setTab={setTab} onGotoConfig={()=>setTab('config')} onLargeGraph={setConfirmFile} /></div>`,
  center = canvas `<main className="canvas-wrap">…</main>` (unchanged inner), right = `<Inspector … />`.

- [ ] **Step 3 — `Chrome.tsx`.** Port `Chrome` from `09-shell.jsx`. Wire: `conn=state.connection`
  (pill: `live`→"watching · 已同步" `.live`; `reconnecting`→"重新連線中…" `.offline`; `snapshot`→"離線快照" `.offline`);
  breadcrumb = `state.breadcrumb.map((p,i)=>…)` with `niceName(p)`, non-last segment `onClick={()=>popBreadcrumb(i)}`;
  `searchbtn onClick={onPalette}`; import/export buttons rendered only when `conn==='live'`
  (export also `disabled` when `!graph || !supported`); `settings iconbtn onClick={onSettings}`
  (=`()=>setTab('config')`); more-menu snapshot item **greyed/disabled** with tooltip
  "需要 CLI：ue-mat-viewer export <name>". Import `chrome.css` (port `.chrome*`/`.menu*`/`.searchbtn`/`.conn*` from `mockup-with-css.html` 481–503).

- [ ] **Step 4 — `Banner.tsx`.** Port `Banner` (09): `engineMismatch` (derive from
  dbContext `supported===false`) → `.banner.warn` with the "switch engine" button **disabled**
  (no mechanism); `snapshot` → `.banner.info`; `reconnecting` → `.banner.info` with spin icon.
  Local `dismissed` state in Body. Remove the old inline `.canvas-banner` from App + theme.css.

- [ ] **Step 5 — Compose + delete Header.** In `Body` render `<Chrome …/>` then `<Banner …/>`
  above `<div className="body">`. Delete `Header.tsx` + `header.css` and their imports.

- [ ] **Step 6 — Sidebar accepts tab + threads props.** `Sidebar({tab,setTab,onGotoConfig,onLargeGraph})`:
  render the `.lstabs/.lstab` tab bar (port from `05-files-inspector.jsx` LeftSidebar) with a
  Config status dot `{configCue && <span className={'tdot '+configCue}/>}` where
  `configCue = state.crawl.status==='running'?'run':state.crawl.status==='error'?'err':null`;
  pass `onGotoConfig`/`onLargeGraph` into `<FileList …>`. Add `.lstabs/.lstab/.tdot` CSS to `chrome.css`.

- [ ] **Step 7 — Overlay mount placeholders.** In `Body`, mount (real components arrive in H/I):
  `{confirmFile && <BigGraphConfirm file={confirmFile} onCancel={()=>setConfirmFile(null)} onConfirm={()=>{open(confirmFile.path);setConfirmFile(null);}} />}`
  and `{paletteOpen && <CommandPalette … onClose={()=>setPaletteOpen(false)} onJump={focusNode} onCmd={handleCmd} … />}`.
  Add `handleCmd(id)` switch: `config`→`setTab('config')`; `crawlMat`→`startCrawl('projectmat', mfRoot)`;
  `t3dIn`→`setImportOpen(true)`; `t3dOut`→`doExport()`; `snapshot`→info toast "快照匯出需 CLI".
  Add the ⌘K/Escape keydown effect (toggle `paletteOpen`, Escape clears `confirmFile`/`paletteOpen`).
  Until H/I land, stub `BigGraphConfirm`/`CommandPalette` as `() => null` exports so the build compiles.

- [ ] **Step 8 — Verify + commit.** `tsc -b && vite build` clean; app renders with new chrome,
  3-column grid, sidebar tabs, breadcrumb, connection pill. `git commit -m "feat(viewer): app shell (chrome/banner/grid) + lifted cross-cutting state"`.

---

## Task D: Files panel

**Files:** Modify `viewer/web/src/FileList.tsx`; create `viewer/web/src/files.css`; reference `docs/design-ref/components/05-files-inspector.jsx` (FilesPanel/FileRow/Group).

- [ ] **Step 1 — Wrapper + search.** `div.sb-files`→`div.files`; search → `.files-search` with
  `<Icon name="search"/>` + input placeholder "篩選材質…". Create `files.css`, port `.files/.files-search/.grp/.grp-head/.sec-label/.sec-crawled/.frow/.sdot/.bigmark/.empty-crawl` (mockup 536–560, 880–883).
- [ ] **Step 2 — Three always-visible sections (drop subtabs).** Remove the material/function
  `SubTab` toggle. Render: "代理產出 · Agent-authored" `.sec-label` + `<Group>` per project (port
  `Group` with caret); the striped crawled section; "Material Functions" flat list. `Group` replaces `ProjectFolder`.
- [ ] **Step 3 — `FileRow` → `.frow`.** `div.frow` + `sel`/`ro` (`origin==='crawled'`) classes;
  `<Icon name={type==='MaterialFunction'?'func':'material'}/>`; `.nm` baseName; `.meta` =
  `bigmark "300+"` when `shouldConfirmOpen(nodeCount)`, `.nc` count, `.sdot` (`ok`/`warn`). Keep
  keyboard access: render as `<div role="button" tabIndex={0} onKeyDown=Enter/Space>`. `usedBy` **omitted** (no data).
- [ ] **Step 4 — Crawled section + empty placeholder.** Always render; header `.sec-crawled`>`.sec-label`
  (accent) "專案母材質（爬取）" + "爬取 · 唯讀" badge. If `crawledProjects.length===0` render
  `.empty-crawl` (eye icon, "尚未爬取專案母材質", description, `<button className="btn sm primary" onClick={onGotoConfig}>前往爬取</button>`); else map `Group`s.
- [ ] **Step 5 — Large-graph gate.** In `FileRow` click: if `shouldConfirmOpen(entry.nodeCount)`
  call `onLargeGraph(entry)` (from props, threaded in Task C) instead of `window.confirm`; else `open(entry.path)`.
- [ ] **Step 6 — Verify + commit.** `tsc -b && vite build` clean. `git commit -m "feat(viewer): files panel re-skin (groups, crawled section, empty state)"`.

---

## Task E: Nodes panel

**Files:** Modify `viewer/web/src/NodeLibrary.tsx`; create `viewer/web/src/nodes.css`, `viewer/web/src/nodeLibraryConstants.ts`; reference `docs/design-ref/components/07-nodes.jsx` + `01-mock-data.jsx` (PIN_TYPES/CATEGORIES).

- [ ] **Step 1 — Constants.** `nodeLibraryConstants.ts`: copy `PIN_TYPES` + `CATEGORIES` from
  `01-mock-data.jsx`. **Note (per D2): the canvas keeps current colours — these design colours
  are used only for the Nodes-tab signature dots/labels.** Add `mapPinType(type:string):keyof typeof PIN_TYPES`
  normalising DB strings (`Float1/2/3/4`, `Float3`, `Texture2D`, `MaterialAttributes`, …) → keys, fallback `'exec'`.
- [ ] **Step 2 — Segment switcher.** `div.ntab` root; `.files-search`; `.nt-seg` two buttons
  ("節點型別" {db count} / "Material Function" {engineMf+workMf count}); the static "由爬取刷新…" `.note`.
  Local `seg/'types'|'mf'`, `q`, `open`.
- [ ] **Step 3 — Rows.** `NodeTypeRow` + `SigCol` (port from 07). `types` branch: map `db.nodes`
  via `nodeDefToNTRowItem` (src `'engine'`; `used` shown as `×—` — no data); keep `showProvisional` toggle.
  `mf` branch: merge `engineMf` (`'engine'`) + `workMf` (`'project'`, `missing` flag) via
  `mfEntryToNTRowItem`. `插入到畫布` button **disabled** (read-only). Empty → `.empty`.
- [ ] **Step 4 — CSS + label.** Port `.ntab/.nt-seg/.ntrow/.ndot2/.nname/.nsrc/.nused/.ntdetail/.sig/.sigrow/.sigcol` (mockup 859–877) into `nodes.css`. Remove dead `.lib-*` rules from `sidebar.css`. Sidebar "Nodes" tab label → "節點".
- [ ] **Step 5 — Verify + commit.** `tsc -b && vite build` clean. `git commit -m "feat(viewer): nodes panel re-skin (segments + signature rows)"`.

---

## Task F: Config tab + crawl run-panel

**Files:** Modify `viewer/web/src/ConfigPanel.tsx`; create `viewer/web/src/config.css`; reference `docs/design-ref/components/06-config-crawl.jsx`.

- [ ] **Step 1 — Helpers + meta.** Add to ConfigPanel: `relTime(iso)`/`fmtTime(iso)` (use a fixed
  "now" via `Date.now()` at render — acceptable); `parseLogLine(line,i):{t,lvl,msg}` (lvl by
  heuristic: error/fail→error, warn→warn, LogInit/LogAsset→dim, else info; `t=i*0.1` synthetic — hide
  `.lt` column or show synthetic); `CRAWL_KIND_META: Record<CrawlKind,{label,en,desc,refresh}>` with
  the four real keys (workmf/projectmat/export/enginemf) and the zh-TW strings from the spec;
  `EN_LABELS` for the env-row English sub-labels.
- [ ] **Step 2 — Sections (live+idle).** Extract `PathsSection` (§1, `.field/.inp`, save→`saveConfig`),
  `EnvSection` (§2, `.envbanner ready/notready` + `.envrow2` from `state.env.checks`, refresh→`refreshEnv`),
  `CrawlOpsSection` (§3: mfRoot `.field` with `pfx="root"`; `.tier-label` "主要 · 專案（常用）" +
  `CrawlButton` for `workmf`/`projectmat`; `.advrow` toggle → `CrawlButton adv` for `export`/`enginemf`).
- [ ] **Step 3 — `CrawlButton` + `FreshBadge`.** `CrawlButton` uses `CRAWL_KIND_META[k]`,
  `disabled={!state.env?.ready}`, `onClick={()=>startCrawl(k, mfRoot)}`. `FreshBadge ts={state.env?.freshness?.[k] ?? null} justRan={justRan===k}` → `never`/`has`/`now`.
- [ ] **Step 4 — `RunPanel` takeover.** When `state.crawl.status!=='idle'` render `<div className="cfg"><RunPanel/></div>`:
  run-head (spin/ok/err icon + `CRAWL_KIND_META[kind].label` + sub + elapsed timer), `.progress` bar
  (width from `logs.length`/expected≈20), `RunLog` (map `crawl.logs` via `parseLogLine`); while running
  a **wired** "停止爬取" button → `stopCrawl()`; on success `.run-result.ok` (omit `.rstats` counts — no
  server data — show only the projMat "→ 已填入…" note); on error `.run-result.err` using existing
  `diagnoseCrawl(crawl.logs)` for cause/fix and `who→fixpill self|maint`, `.logdetails` full log; "重試"→`startCrawl(kind,mfRoot)`, "返回爬取面板"→`resetCrawl()`.
- [ ] **Step 5 — snapshot/reconnecting.** snapshot → `.cfg-notice` "此匯出快照無法爬取" + lone mfRoot
  `.field`; reconnecting → `.reconnect-spin`.
- [ ] **Step 6 — CSS.** Port all `.cfg/.cfg-sec/.field/.envbanner/.envrow2/.crawlbtn/.freshbadge/.advrow/.runwrap/.runlog/.run-result/.logdetails/.cfg-notice/.reconnect-spin` (mockup 697–726, 753–857) into `config.css`. Remove dead `.cfg-*` rules from `sidebar.css`.
- [ ] **Step 7 — Verify + commit.** `tsc -b && vite build` clean; `vitest run` any ConfigPanel/crawl tests. `git commit -m "feat(viewer): config tab + crawl run-panel (freshness + stop)"`.

---

## Task G: Inspector

**Files:** Modify `viewer/web/src/Inspector.tsx`, `viewer/web/src/inspector.css`; modify `App.tsx` (pass `nodeProvenance` + `onRecrawlNode`); reference `docs/design-ref/components/05-files-inspector.jsx`.

- [ ] **Step 1 — Shell + mode tabs.** Outer `div.panel.right` + `.panel-head` ("檢視器 Inspector"
  + frame iconbtn when a node is selected). `.insp-mode` tabs ("節點詳情"/"圖健康度"); local
  `inspMode` that resets to `'node'` when `selectedNodeId` goes null→set (useEffect).
- [ ] **Step 2 — `NodeInspector`.** Port: `.node-title` (swatch = `CATEGORIES[def.category]` colour
  using **current** palette mapping, not the mockup's), `.kv` rows (類別/節點ID/狀態), `PinList`
  (`.pinlist/.pinrow` with `.pc` colour = current pin palette, `.pn`, `.pt` type pill), 參數 (`.kv`
  + `.codeblock`).
- [ ] **Step 3 — Crawl-metadata section.** New `.isec`: read
  `meta = state.graphs[current]?.nodeProvenance?.[node.id]`; show 來源資料集 = label of
  `meta.source` (export→"節點導出", workmf→"專案 MF", enginemf→"引擎 MF", projectmat→"專案母材質", unresolved→"—"),
  上次爬取 = `fmtTime(meta.freshnessTs)` + `relTime`, freshness chip = `missing` when
  `source==='unresolved'` else `fresh`. **Omit 指令成本.** "重爬來源" button (when not fresh) →
  `onRecrawlNode(meta.source)` (App maps source→`startCrawl(workmf|projectmat|…)`).
- [ ] **Step 4 — `HealthInspector`.** `.health-badge` ring (errCount?"!":"✓"), "需要注意/有警告/一切正常"
  + "{err} 個錯誤 · {warn} 個警告 · 已掃描 {nodes.length} 個節點"; issue list `.issue` rows
  (`.ibar/.it/.id/.in` + `.sevpill`), click → `onFocusNode(iss.nodeId)`. Map severity `warning`→`warn`,
  health level `bad`→`error`.
- [ ] **Step 5 — Errors branch + CSS.** Keep errors-first branch (panel-head + `.health-badge.error` + issues).
  Rewrite `inspector.css` with `.insp/.insp-mode/.isec/.lbl/.node-title/.kv/.pinlist/.pinrow/.codeblock/.fresh/.metagrid/.health-badge/.issue/.sevpill` (mockup 628–674); scope generic names (`.panel.right .isec` etc.) to avoid collisions. Remove dead `.insp-*` rules.
- [ ] **Step 6 — App wiring.** App passes `onRecrawlNode={(src)=>startCrawl(mapSourceToKind(src), mfRoot)}` to Inspector. Verify + `git commit -m "feat(viewer): inspector re-skin (modes + node provenance metadata)"`.

---

## Task H: Canvas frame + BigGraphConfirm

**Files:** Modify `viewer/web/src/Graph.tsx` (frame only), `theme.css` (canvas tokens); create `viewer/web/src/BigGraphConfirm.tsx`, `viewer/web/src/overlays.css` (shared with I); reference `docs/design-ref/components/08-overlays.jsx`.

- [ ] **Step 1 — Canvas frame only.** `.canvas-wrap`: add `background:var(--bg-canvas);overflow:hidden`
  (keep flex column). In `Graph.tsx` remove the inline `style={{background:'var(--bg0)'}}` so the
  themed frame shows through; if ReactFlow paints an opaque pane, add `.react-flow{background:transparent}`.
  **Do not touch node/edge/colour rendering** (D1). Keep `canvas-topbar` where it is.
- [ ] **Step 2 — `BigGraphConfirm.tsx`.** Port from 08 but **two buttons only** (取消 / 仍要開啟 primary —
  **drop 漸進開啟**). Props `{file:{path:string;name:string;nodeCount:number}; onCancel; onConfirm}`;
  body shows nodeCount + est. links (`~nodeCount*1.6`); omit the fabricated "38 MB" (or compute a
  rough heuristic and label it 估計). Replace the Task-C stub export.
- [ ] **Step 3 — CSS.** Create `overlays.css` with `.scrim/.modal/.modal-head/.modal-body/.modal-foot/.stat` (mockup 677–683) + modal `fadeUp` animation (963). Import in App.
- [ ] **Step 4 — Verify + commit.** `tsc -b && vite build` clean; opening a >300-node fixture shows the modal (not `window.confirm`). `git commit -m "feat(viewer): canvas frame token + BigGraphConfirm modal"`.

---

## Task I: Command palette + toast restyle

**Files:** Create `viewer/web/src/CommandPalette.tsx`; modify `viewer/web/src/Toast.tsx`, `viewer/web/src/toast.css`; append to `overlays.css`; reference `docs/design-ref/components/08-overlays.jsx`.

- [ ] **Step 1 — `CommandPalette.tsx`.** Port from 08. Props `{onClose,onJump,onCmd,nodes:NodeJson[],db:NodeDB,connection,envReady}`.
  Node list = `nodes.map(n=>({id:n.id,title:n.type,cat:db.nodes[n.type]?.category??'Unknown'}))` (jump
  target = `n.id`); commands `config/crawlMat/t3dIn/t3dOut/snapshot` with greying: `crawlMat`
  disabled unless `connection==='live' && envReady`; `t3dIn` disabled when `connection==='snapshot'`.
  Keyboard Arrow/Enter/Escape. Replace the Task-C stub export.
- [ ] **Step 2 — Palette CSS.** Append `.cmdk/.cmdk-input/.cmdk-list/.cmdk-item/.cmdk-group` (mockup 685–695) + `fadeUp` to `overlays.css`.
- [ ] **Step 3 — Toast restyle.** Keep `ToastStack`/`ToastItem` API. Rename wrapper `.toast-stack`→`.toast-wrap`;
  restyle item to `.toast.ok/.err` (`.ti/.tt/.td/.tx`, optional `.tact` action link); variant map
  success→ok, error/warning→err, info/loading→neutral accent border. Rewrite `toast.css` from mockup 886–894 (+ `toastin`/`fadeUp`).
- [ ] **Step 4 — Verify + commit.** `tsc -b && vite build` clean; ⌘K opens palette, jump centres a
  node, commands fire. `git commit -m "feat(viewer): ⌘K command palette + toast restyle"`.

---

## Final verification

- [ ] Server `tsc -p viewer/tsconfig.json` = 0 errors.
- [ ] Web `cd viewer/web && ../node_modules/.bin/tsc -b && ../node_modules/.bin/vite build` clean.
- [ ] `viewer/node_modules/.bin/vitest run` green (note: `crawl-api` may need isolated rerun).
- [ ] Manual pass against the design states (user, incl. live crawl on Windows): idle/env-fail/running/success/error config; files before/after crawl; inspector node/health; ⌘K; big-graph modal; snapshot/reconnecting banners; canvas unchanged.

## Self-review notes (author check)

- **Spec coverage:** every spec In-scope item maps to a task (shell→C, files→D, nodes→E,
  config/crawl→F, inspector→G, canvas+confirm→H, overlays/toast→I); all four backend features in
  B; greyed items (insert/used-by/progressive/switch-engine/指令成本/snapshot-export) marked disabled
  in D/E/G/H/C. **Canvas frozen (D1)** honoured — only frame/token in H.
- **Type consistency:** `CrawlKind` reused everywhere (workmf/projectmat/export/enginemf);
  `NodeProvenance`/`CrawlFreshness` mirrored ws-protocol↔protocol; `ToastItem` API unchanged.
- **No fabrication:** rstats counts omitted (no server data), 指令成本 omitted, used-by omitted —
  all flagged rather than faked.

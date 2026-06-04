# Design brief for Claude Designer — "UE Material Workflow" viewer

> Hand this whole file to Claude Designer for a productization design pass. When the
> mockups come back, give them to the implementer to build. Functional scope reference:
> `docs/superpowers/specs/2026-06-04-viewer-workflow-enhancements-design.md`.
>
> **Read this first.** This tool has TWO hearts, not one. The node **canvas** is the
> visual hero. The **Config / Crawl panel** is the operational heart — the thing that
> makes this more than a JSON viewer: it reaches into the user's live Unreal project and
> pulls real data out. Earlier versions of this brief under-described the crawl and it got
> drawn as an afterthought. Do not repeat that. The crawl panel is a first-class,
> multi-state operational surface and is the single most state-rich screen in the app.

---

**Brief: productization pass for "UE Material Workflow" — a local material-graph viewer
with a live Unreal-project crawl loop**

**Context.** A localhost web app that is the human-facing surface of an AI↔human workflow
for Unreal Engine 5.7 material node graphs. An AI writes strict JSON; this app renders it
as realistic UE material nodes on a canvas. It imports/exports node selections to/from the
UE Material Editor via the clipboard (T3D), can export a self-contained offline HTML
snapshot, and — **centrally** — runs local **crawls**: it launches the user's own Unreal
Editor in the background to harvest live metadata from their project (their material
functions, their actual `/Game` materials) and from the engine, then refreshes the app
with it. **Audience:** technical artists on large, multi-person UE projects who *inspect
and consume* materials in the browser and *refresh that data themselves* via crawls
(authoring happens in UE itself).

**Goal.** Elevate it from a dev-tool look into a polished, confident **pro tool** — dark,
technical, dense. The node **canvas is the visual hero**; the **Config / Crawl panel is
the operational heart** — design *both* at full fidelity. The sidebar is secondary in
screen real estate but **not** secondary in design care: the crawl panel in particular has
the most distinct states in the app and must be shown at full detail in dedicated mockups,
never as a collapsed corner element. Avoid generic SaaS/marketing aesthetics. Desktop-first
(localhost), no mobile.

---

## Layout — the app shell

A single desktop window, three columns:

- **Center — Canvas (visual hero).**
- **Left — Sidebar with three tabs: `Files` | `Nodes` | `Config`.** One tab visible at a
  time; each is a full-height, scrollable panel. **The crawl lives in the `Config` tab** —
  it is a full panel with stacked sections, *not* a dropdown, popover, or settings row.
- **Right — Inspector.**

Design the tab switcher itself (Files / Nodes / Config) — the `Config` tab needs an
affordance that can carry a subtle status cue (e.g. a dot when a crawl is running or just
failed, since the user may be on another tab when it finishes).

---

## Region detail

### Canvas (hero, center)
A refined node-graph editor — UE material nodes with typed pins, edges colored by pin type,
and **comment boxes including nested ones** (a small box serving one node can sit inside a
larger box grouping many). Must stay legible at **600+ nodes**; pan/zoom/minimap/controls.

### Left › `Files` tab
The user's materials grouped by project, with **two visually distinct classes**:
- **(a) Agent-authored materials** — the AI's output.
- **(b) Crawled project materials** — a read-only mirror of the user's live UE `/Game`
  project, shown in its own collapsible section titled **「專案母材質（爬取）」**
  ("Project Materials (crawled)") with a **「爬取」** ("crawled") badge. **This section is
  the OUTPUT of the crawl loop** (see Config tab): it is empty until the user runs a
  "Re-crawl Project Materials" crawl, then fills with one folder per material.
Plus a Functions list. Each row: name, type icon (◆ for Material), health/status dot
(green ok / yellow warn), node count. Large graphs (>300 nodes) need an at-a-glance "big"
marker — opening one triggers a confirm dialog.

### Left › `Nodes` tab
A browser of available node types and material-function signatures (engine MFs + the user's
project MFs). Mention only; not a focus of this pass. Note that crawls **refresh this tab's
data** (project-MF, engine-MF, and node-type databases all come from crawls).

### Right › Inspector (two modes)
1. **Node detail** — category, input/output pins with type swatches, parameters incl. code
   blocks.
2. **Nothing selected → graph health / "what's wrong" panel** — a status badge plus a
   clickable issue list (missing/duplicate outputs, unknown nodes, bad pins, unresolved
   functions).

---

## Config tab — the crawl operations panel  ⟵ design this at full fidelity

This is a primary operational surface. A full-height scrollable panel made of stacked
sections, in this order:

**1. Project paths (static setup).** Inputs for the `.uproject` path and the UE Engine
root, plus a "Save config" button. Rarely changed.

**2. Environment checklist (a GATE, not a footnote).** Six checks, each a row with a ✓/✗
icon and a one-line detail: Windows platform · `local.config.json` present · UE engine
(`UnrealEditor-Cmd.exe`) found · `.uproject` exists · plugin DLL compiled · no shadow plugin
copy. A banner summarizes: **「✓ 環境就緒，可以爬取」** (ready) or **「尚未就緒——完成下列項目即可爬取」**
(not ready). **All crawl buttons below are DISABLED until every check passes** — the
checklist is a precondition control, visually prominent, directly above the buttons. (On a
Mac/non-UE machine the checks fail and crawling is correctly impossible — design the
disabled state to read as "set up your environment," not "broken.")

**3. Crawl operations (the dominant section).** Four crawl actions in **two tiers**:

- **Primary tier — project, frequent (prominent, always visible):**
  - **「重爬專案 Material Function」** — "Re-crawl Project Material Functions": harvests the
    pin signatures of the user's own `/Game` material functions; refreshes the `Nodes` tab
    and live-re-resolves any open graph.
  - **「重爬專案母材質」** — "Re-crawl Project Materials": exports every `/Game` material out
    of UE and imports them as openable graphs → **populates the `Files` tab's
    「專案母材質（爬取）」 section**.
- **Advanced / maintenance tier — official engine data, rarely needed (collapsed by
  default, de-emphasized):** a disclosure row labeled **「▶ 進階／維護（官方原生，一般用不到）」**
  that expands to two muted, smaller buttons:
  - **「重爬節點導出」** — "Re-crawl Node Export": rebuilds the node-type database.
  - **「重爬引擎 Material Function」** — "Re-crawl Engine Material Functions": rebuilds the
    `/Engine/` MF index.
  Visual treatment: primary = two prominent action buttons; advanced = inside a chevron
  disclosure, smaller type, muted color, collapsed by default.

  Both tiers also take a single **"MF content root"** text input (default `/Game`) that
  scopes the project crawls.

- **Per-button freshness (design this in).** Each crawl button carries its own adjacent
  "last crawled / freshness" badge — an independent per-kind timestamp, or **"Never."** Four
  buttons → four independent badges (not one global timestamp).

**4. Live run + result (a full-panel takeover when a crawl runs).** Only **one crawl runs at
a time** (single-job lock — every button disabled during a run). While running, this region
becomes the dominant visual element of the panel:
- Which crawl is active, labeled (**「⏳ … 執行中…（編輯器啟動需數分鐘）」** — "running… editor
  startup takes minutes").
- A **scrolling live log stream** (the largest element — UE editor boot is slow and chatty).
- Elapsed time; and design in a **stop/cancel** affordance.
- It resolves to either a **success banner** (**「✓ … 完成，已即時刷新。」** "done, refreshed
  live"; the just-run button's freshness badge updates to now) **or** an **error report**
  (**「✗ … 失敗（exit N）」** with a plain-language cause / suggested fix / "you can fix this
  yourself" vs "needs the tooling maintainer," plus a collapsible full-log `details`).
- A completion **toast** also fires app-wide, because the user may have switched tabs.

---

## States to cover (each is a required mockup frame unless noted)

**Crawl panel (Config tab):**
1. Idle, env all-passing — four buttons enabled (two primary + the collapsed advanced
   disclosure), each with its freshness badge ("Never" or a timestamp).
2. Env check failing — one or more ✗ rows; all crawl buttons disabled; a cue on a disabled
   button pointing at the failed check.
3. Primary crawl running — full-panel log-stream takeover (active label, scrolling log,
   elapsed time, stop control); other buttons disabled.
4. Crawl success — success banner below the log; the run button's freshness badge updated.
5. Crawl error — error report with diagnosis + collapsible full log.
6. Advanced tier expanded — disclosure open, the two de-emphasized advanced buttons shown
   beside the primary tier.

**Files tab (the crawl's output, two states):**
7. Before any project-materials crawl — the 「專案母材質（爬取）」 section empty / "not yet
   crawled" placeholder.
8. After a project-materials crawl — the section populated, visually distinct from
   Agent-authored materials (badge, icon, row style).

**Cross-cutting:**
9. Offline snapshot (`connection === 'snapshot'`) — crawl controls and env checklist hidden,
   replaced by a "crawl unavailable in this exported snapshot" notice (the MF-root input may
   remain, for export use).
10. Reconnecting — "connecting to local viewer server…", crawl section hidden.
11. Large-graph "open anyway?" confirm (opening a >300-node graph).
12. Inspector in both modes (node detail / graph-health).
13. A file that failed to load (error panel); an unsupported-UE-version banner.

---

## Aesthetic
Dark, precise, pipeline-tool feel; strong typographic hierarchy; restrained accents for
status (ok/warn/error) and for primary vs advanced/maintenance actions; high information
density without clutter; canvas visually dominant — but the Config/crawl panel designed to
the same fidelity, legible enough to carry a scrolling log, two-tier button groups, and
per-button freshness badges within a sidebar-width column.

## Deliver
High-fidelity mockups covering the frames enumerated in **States to cover** above — in
particular, treat the **crawl panel as ~6 distinct frames, not one** (idle / env-failed /
running / success / error / advanced-expanded), plus the **two Files-panel states** (before
& after a project-materials crawl) that the crawl produces. Also deliver the main window
(canvas + 3 columns) and the Inspector in both modes. Plus a short layout/IA rationale and a
minimal color/type token set so it can be implemented faithfully.

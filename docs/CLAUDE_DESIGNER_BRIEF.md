# Design brief for Claude Designer — "UE Material Workflow" viewer

> Hand this whole file to Claude Designer to get a productization design pass. When the
> mockups come back, give them to the implementer to build. Functional scope reference:
> `docs/superpowers/specs/2026-06-04-viewer-workflow-enhancements-design.md`.

---

**Brief: productization pass for "UE Material Workflow" — a local material-graph viewer**

**Context.** A localhost web app that is the human-facing surface of an AI↔human workflow for
Unreal Engine 5.7 material node graphs. An AI writes strict JSON; this app renders it as
realistic UE material nodes on a canvas. It imports/exports node selections to/from the UE
Material Editor via the clipboard (T3D), runs local crawls to refresh UE metadata, and can
export a self-contained offline HTML snapshot. **Audience:** technical artists on large,
multi-person UE projects who currently *inspect and consume* materials in the browser
(authoring happens in UE itself).

**Goal.** Elevate it from a dev-tool look into a polished, confident **pro tool** — dark,
technical, dense, with the **node canvas as the hero**. Add clarity and hierarchy without
dumbing it down. Avoid generic SaaS/marketing aesthetics. Desktop-first (localhost), no mobile.

**Single-window app, four regions:**

- **Canvas (hero, center):** a refined node-graph editor — UE material nodes with typed pins,
  edges colored by pin type, and **comment boxes including nested ones** (a small box serving
  one node can sit inside a larger box grouping many). Must stay legible at **600+ nodes**;
  pan/zoom/minimap/controls.
- **Left — Files:** the user's materials grouped by project, with **two visually distinct
  classes**: (a) *Agent-authored* materials and (b) *Crawled project materials* (a read-only
  mirror of the UE project's `/Game`, shown in its own "Project Materials (crawled)" section
  with a badge). Plus a Functions list. Each row: name, type icon, health/status dot, node
  count; large graphs need an at-a-glance "big" marker (opening them triggers a confirm).
- **Right — Inspector (two modes):** (1) node detail — category, input/output pins with type
  swatches, parameters incl. code blocks; (2) when nothing is selected, a **graph health /
  "what's wrong" panel** — a status badge plus a clickable issue list (missing/duplicate
  outputs, unknown nodes, bad pins, unresolved functions).
- **Config / Crawl surface:** refresh UE metadata via local crawls, in **two tiers** —
  **Primary (project, frequent):** "Re-crawl Project Material Functions", "Re-crawl Project
  Materials"; **Advanced / maintenance (official native, rarely needed):** "Re-crawl Node
  Export", "Re-crawl Engine Material Functions" (visually subordinate / collapsible). Include
  an **environment checklist** (the crawl is gated on local UE setup), a per-dataset **"last
  crawled / freshness"** indicator, and a **live progress + log stream** ending in a
  success/error report.

**States to cover:** live vs offline-snapshot (snapshot hides crawl controls); a crawl running
(progress + logs); a large-graph "open anyway?" confirm; a file that failed to load (error
panel); an unsupported-UE-version banner.

**Aesthetic.** Dark, precise, pipeline-tool feel; strong typographic hierarchy; restrained
accents for status (ok/warn/error) and for primary/crawl actions; high information density
without clutter; canvas visually dominant.

**Deliver.** High-fidelity mockups of — the main window (canvas + 3 panels), the Config/crawl
surface (both tiers + a running-crawl state), the Files panel showing both material classes,
and the Inspector in both modes — covering the key states above. Plus a short layout/IA
rationale and a minimal color/type token set so it can be implemented faithfully.

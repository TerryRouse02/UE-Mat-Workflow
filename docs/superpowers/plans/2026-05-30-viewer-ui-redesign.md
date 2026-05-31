# Viewer UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the `viewer/web` React UI to match the reference prototype's 3-pane layout, dark theme, and interaction polish, while keeping ReactFlow + dagre + ws hot-reload and preserving every existing feature.

**Architecture:** Token-first, component-by-component. A CSS design-token layer (`theme.css`) replaces scattered inline colors; the App shell is restructured into Header / 3-pane Body / ToastStack; the canvas keeps ReactFlow (custom node reskin + typed edges); a new read-only Inspector and ToastStack are added. Pure helpers (color mapping, sync-time formatting, MF detection, node sizing) are TDD'd via the existing server vitest; components/CSS are verified by `pnpm build` (typecheck) + explicit manual observation against the parity checklist.

**Tech Stack:** React 18, ReactFlow 11, dagre, Vite 5, TypeScript 5; vitest 2 (server package, `viewer/tests/`). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-05-30-viewer-ui-redesign-design.md` (read it; the Functionality parity checklist there is the regression gate).

---

## Conventions for this plan

- **Working dir** for all commands: `viewer/` (the monorepo viewer package). `pnpm --filter web ...` targets the web app; root `pnpm test` runs server vitest.
- **Build/typecheck:** `pnpm --filter web build` (runs `tsc -b && vite build`). A green build = TypeScript passes + Vite bundles.
- **Dev/observe:** `pnpm --filter web dev` then open the printed localhost URL. Have at least one project under `graphs/` (the repo ships example folders).
- **Unit tests:** new `*.test.ts` files go in `viewer/tests/` and import pure helpers from `../web/src/...` (helpers must NOT import React/CSS, or vitest can't load them). Run with `pnpm test` (from `viewer/`).
- **Commit** after each task with the message shown.
- **Visual CSS values** are adapted from the documented design tokens (below) and the node-anatomy in the spec. Exact pixel polish is matched against the reference file at `~/Downloads/UE-MAT Workflow Viewer.html` (kept as the visual source of truth). The plan gives complete token values and structural CSS; per-component cosmetic rules follow the same tokens.

### Design tokens (authoritative values)

```
Surfaces (Graphite):  --bg0 #15171a   --bg1 #1b1e22   --bg2 #23272d
Borders / header:     --bd  #31373f   --hed #181b1f
Accent:               --accent #a06bff
Text:                 --fg #e6e8eb   --fg-dim #9aa3ad   --fg-faint #6b7480
Radius / metrics:     --radius 7px   --row 32px   --fs 13px
Pin-type colors:      Float/Float1(scalar) #7ec96f   Float2 #5cc4c4   Float3 #e0b34d
                      Float4 #b48cf0   texture #5b9bf0   bool #e0728a
                      MaterialAttributes #e8ebef   (unknown → #8a93a0)
Category colors:      Constants #6b7886  Math #5b9bf0  Texture #4fb0a0
                      Coordinates #c98a52  Functions #a06bff  Parameters #d98ec0
                      Utility #8a93a0  Output #e8ebef  (default → #6b7886)
```

---

## File Structure

**Create:**
- `viewer/web/src/theme.css` — design-token layer (`:root`/`.app` CSS variables + base resets).
- `viewer/web/src/theme/colors.ts` — pure `pinColor()` / `catColor()` mappings.
- `viewer/web/src/syncStatus.ts` — pure `formatSyncAgo()`.
- `viewer/web/src/graphInfo.ts` — pure `hasMaterialFunctionCall()`.
- `viewer/web/src/Header.tsx` + `header.css` — brand, breadcrumb, watch pill, Export, MF-root popover, disabled Import.
- `viewer/web/src/Inspector.tsx` + `inspector.css` — read-only node/material panel.
- `viewer/web/src/Toast.tsx` + `toast.css` — `ToastStack`, `useToasts` hook.
- `viewer/tests/pinColor.test.ts`, `viewer/tests/syncStatus.test.ts`, `viewer/tests/graphInfo.test.ts`, `viewer/tests/layout-sizing.test.ts`.

**Modify:**
- `viewer/web/index.html` — `<title>`.
- `viewer/web/src/main.tsx` — import `theme.css`.
- `viewer/web/src/App.tsx` — shell regions; hold `selectedNodeId` + toasts; render Header/Inspector/ToastStack.
- `viewer/web/src/store.tsx` — add `connection` + `lastUpdate`; wire ws open/close.
- `viewer/web/src/ws-client.ts` — expose `onOpen`/`onClose` callbacks.
- `viewer/web/src/Graph.tsx` — typed edges, selection dimming, dotted grid, keep MiniMap, zoom controls, `fitView` on graph change, `onNodeClick` → App; move Export logic out to Header.
- `viewer/web/src/nodes/MaterialNode.tsx` — new anatomy; **remove on-node params** (params now flow to Inspector only).
- `viewer/web/src/nodes/styles.css` — node reskin + typed pins/edges.
- `viewer/web/src/layout.ts` — drop param contribution from node sizing.
- `viewer/web/src/FileList.tsx` + `viewer/web/src/sidebar.css` — search, Materials/Functions sub-tabs, status/counts where loaded, reskin.
- `viewer/web/src/NodeLibrary.tsx` — category chips + reskin (keep Params, Pin rule, search-auto-expand, empty state).

---

## Task 1: Theme token layer

**Files:**
- Create: `viewer/web/src/theme.css`
- Modify: `viewer/web/src/main.tsx`, `viewer/web/index.html`

- [ ] **Step 1: Create `viewer/web/src/theme.css`**

```css
:root {
  --bg0: #15171a; --bg1: #1b1e22; --bg2: #23272d;
  --bd: #31373f; --hed: #181b1f;
  --accent: #a06bff;
  --fg: #e6e8eb; --fg-dim: #9aa3ad; --fg-faint: #6b7480;
  --radius: 7px; --row: 32px; --fs: 13px;
  --warn: #e0b34d; --err: #e0728a; --ok: #7ec96f;
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; }
body { margin: 0; background: var(--bg0); color: var(--fg);
  font: var(--fs)/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif; }
.app { display: flex; flex-direction: column; height: 100vh; background: var(--bg0); }
.mono { font-family: ui-monospace, Menlo, Monaco, Consolas, monospace; }
```

- [ ] **Step 2: Import the theme in `viewer/web/src/main.tsx`**

```tsx
import './theme.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
```

- [ ] **Step 3: Update the title in `viewer/web/index.html`**

Change `<title>UE Material Viewer</title>` to:

```html
<title>UE·MAT Workflow — Material Viewer</title>
```

- [ ] **Step 4: Build to verify nothing breaks**

Run: `pnpm --filter web build`
Expected: build succeeds (no TS/Vite errors).

- [ ] **Step 5: Commit**

```bash
git add viewer/web/src/theme.css viewer/web/src/main.tsx viewer/web/index.html
git commit -m "feat(viewer): add design-token theme layer"
```

---

## Task 2: `pinColor` / `catColor` pure helpers (TDD)

**Files:**
- Create: `viewer/web/src/theme/colors.ts`
- Test: `viewer/tests/pinColor.test.ts`

- [ ] **Step 1: Write the failing test** — `viewer/tests/pinColor.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { pinColor, catColor } from '../web/src/theme/colors';

describe('pinColor', () => {
  it('maps float family to scalar green', () => {
    expect(pinColor('Float')).toBe('#7ec96f');
    expect(pinColor('Float1')).toBe('#7ec96f');
  });
  it('maps vector widths', () => {
    expect(pinColor('Float2')).toBe('#5cc4c4');
    expect(pinColor('Float3')).toBe('#e0b34d');
    expect(pinColor('Float4')).toBe('#b48cf0');
  });
  it('maps texture, bool, attributes (case-insensitive)', () => {
    expect(pinColor('texture')).toBe('#5b9bf0');
    expect(pinColor('Texture')).toBe('#5b9bf0');
    expect(pinColor('bool')).toBe('#e0728a');
    expect(pinColor('MaterialAttributes')).toBe('#e8ebef');
  });
  it('falls back to neutral grey for unknown types', () => {
    expect(pinColor('Wat')).toBe('#8a93a0');
    expect(pinColor(undefined)).toBe('#8a93a0');
  });
});

describe('catColor', () => {
  it('maps known categories', () => {
    expect(catColor('Math')).toBe('#5b9bf0');
    expect(catColor('Functions')).toBe('#a06bff');
  });
  it('defaults unknown categories', () => {
    expect(catColor('Nope')).toBe('#6b7886');
    expect(catColor(undefined)).toBe('#6b7886');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test pinColor`
Expected: FAIL — cannot resolve `../web/src/theme/colors`.

- [ ] **Step 3: Implement `viewer/web/src/theme/colors.ts`**

```ts
const PIN: Record<string, string> = {
  float: '#7ec96f', float1: '#7ec96f', scalar: '#7ec96f',
  float2: '#5cc4c4', vec2: '#5cc4c4',
  float3: '#e0b34d', vec3: '#e0b34d',
  float4: '#b48cf0', vec4: '#b48cf0',
  texture: '#5b9bf0', bool: '#e0728a',
  materialattributes: '#e8ebef', attrs: '#e8ebef',
};
const PIN_DEFAULT = '#8a93a0';

export function pinColor(type: string | undefined): string {
  if (!type) return PIN_DEFAULT;
  return PIN[type.toLowerCase()] ?? PIN_DEFAULT;
}

const CAT: Record<string, string> = {
  Constants: '#6b7886', Math: '#5b9bf0', Texture: '#4fb0a0',
  Coordinates: '#c98a52', Functions: '#a06bff', Parameters: '#d98ec0',
  Utility: '#8a93a0', Output: '#e8ebef',
};
const CAT_DEFAULT = '#6b7886';

export function catColor(cat: string | undefined): string {
  if (!cat) return CAT_DEFAULT;
  return CAT[cat] ?? CAT_DEFAULT;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test pinColor`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add viewer/web/src/theme/colors.ts viewer/tests/pinColor.test.ts
git commit -m "feat(viewer): pin/category color helpers"
```

---

## Task 3: `formatSyncAgo` pure helper (TDD)

**Files:**
- Create: `viewer/web/src/syncStatus.ts`
- Test: `viewer/tests/syncStatus.test.ts`

- [ ] **Step 1: Write the failing test** — `viewer/tests/syncStatus.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { formatSyncAgo } from '../web/src/syncStatus';

describe('formatSyncAgo', () => {
  it('shows "just now" under 2s', () => {
    expect(formatSyncAgo(1000)).toBe('just now');
  });
  it('shows seconds', () => {
    expect(formatSyncAgo(5000)).toBe('5s ago');
  });
  it('shows minutes', () => {
    expect(formatSyncAgo(125000)).toBe('2m ago');
  });
  it('shows hours', () => {
    expect(formatSyncAgo(3 * 3600 * 1000)).toBe('3h ago');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test syncStatus`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement `viewer/web/src/syncStatus.ts`**

```ts
// Pure: takes elapsed milliseconds, returns a human label.
export function formatSyncAgo(deltaMs: number): string {
  const s = Math.floor(deltaMs / 1000);
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test syncStatus`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add viewer/web/src/syncStatus.ts viewer/tests/syncStatus.test.ts
git commit -m "feat(viewer): sync-age formatter"
```

---

## Task 4: `hasMaterialFunctionCall` pure helper (TDD)

**Files:**
- Create: `viewer/web/src/graphInfo.ts`
- Test: `viewer/tests/graphInfo.test.ts`

- [ ] **Step 1: Write the failing test** — `viewer/tests/graphInfo.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { hasMaterialFunctionCall } from '../web/src/graphInfo';
import type { MatGraph } from '../web/src/protocol';

const base: MatGraph = {
  schemaVersion: '1', ueVersion: '5.7', type: 'Material', name: 'M',
  nodes: [], connections: [],
};

describe('hasMaterialFunctionCall', () => {
  it('false when no MFCall nodes', () => {
    expect(hasMaterialFunctionCall({ ...base, nodes: [{ id: 'a', type: 'Multiply' }] })).toBe(false);
  });
  it('true when a MaterialFunctionCall node exists', () => {
    expect(hasMaterialFunctionCall({ ...base, nodes: [{ id: 'a', type: 'MaterialFunctionCall' }] })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test graphInfo`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement `viewer/web/src/graphInfo.ts`**

```ts
import type { MatGraph } from './protocol';

export function hasMaterialFunctionCall(graph: MatGraph | undefined): boolean {
  if (!graph) return false;
  return graph.nodes.some(n => n.type === 'MaterialFunctionCall');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test graphInfo`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add viewer/web/src/graphInfo.ts viewer/tests/graphInfo.test.ts
git commit -m "feat(viewer): detect MaterialFunctionCall presence"
```

---

## Task 5: Store sync state + ws-client callbacks

**Files:**
- Modify: `viewer/web/src/ws-client.ts`, `viewer/web/src/store.tsx`

- [ ] **Step 1: Extend `connect` in `viewer/web/src/ws-client.ts`**

Add optional lifecycle callbacks. Replace the `connect` signature/body:

```ts
import type { ServerMessage, ClientMessage } from './protocol';

export interface WSClient { send(msg: ClientMessage): void; close(): void; }
export interface WSHandlers {
  onMessage(m: ServerMessage): void;
  onOpen?(): void;
  onClose?(): void;
}

export function connect(handlers: WSHandlers): WSClient {
  const url = `ws://${location.host}`;
  let ws = new WebSocket(url);

  function attach() {
    ws.onopen = () => handlers.onOpen?.();
    ws.onmessage = (e) => { try { handlers.onMessage(JSON.parse(e.data)); } catch (err) { console.error('bad ws msg', err); } };
    ws.onclose = () => { handlers.onClose?.(); setTimeout(() => { ws = new WebSocket(url); attach(); }, 500); };
  }
  attach();

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

- [ ] **Step 2: Add sync state to `viewer/web/src/store.tsx`**

In `interface State`, add:

```ts
  connection: 'live' | 'reconnecting' | 'snapshot';
  lastUpdate: number | null;
```

In `const initial`, add `connection: 'reconnecting', lastUpdate: null,`.

Add to the `Action` union:

```ts
  | { type: 'wsOpen' }
  | { type: 'wsClosed' };
```

In `reducer`, add cases and stamp `lastUpdate` on data messages:

```ts
    case 'wsOpen':   return { ...s, connection: 'live' };
    case 'wsClosed': return { ...s, connection: 'reconnecting' };
    case 'hello':
    case 'fileList':
      return { ...s, files: a.files, lastUpdate: Date.now() };
    case 'graph':
      return { ...s, graphs: { ...s.graphs, [a.path]: a.payload }, errors: { ...s.errors, [a.path]: [] }, lastUpdate: Date.now() };
```

(Keep the existing `graphError`, `open`, `enterMF`, `popBreadcrumb` cases unchanged.)

- [ ] **Step 3: Wire callbacks + export mode in `StoreProvider`**

In the export-data branch (`if (exportData) { ... }`), after dispatching the data, set snapshot mode — add before its `return;`:

```ts
      dispatch({ type: 'open', path: exportData.entry });
      dispatch({ type: 'wsClosed' }); // no ws in export mode
      // Mark as snapshot (handled in the connect-less branch): set directly
      return;
```

Then in the live branch, pass the handlers object:

```ts
    const ws = connect({
      onOpen: () => dispatch({ type: 'wsOpen' }),
      onClose: () => dispatch({ type: 'wsClosed' }),
      onMessage: (m: ServerMessage) => {
        if (m.kind === 'hello') dispatch({ type: 'hello', files: m.files });
        else if (m.kind === 'fileList') dispatch({ type: 'fileList', files: m.files });
        else if (m.kind === 'graph') dispatch({ type: 'graph', path: m.path, payload: m.payload });
        else if (m.kind === 'graphError') dispatch({ type: 'graphError', path: m.path, errors: m.errors });
      },
    });
```

For snapshot detection, set `connection: 'snapshot'` in the export branch by adding an action. Add `| { type: 'snapshot' }` to `Action`, `case 'snapshot': return { ...s, connection: 'snapshot' };` to the reducer, and replace the `dispatch({ type: 'wsClosed' })` above with `dispatch({ type: 'snapshot' });`.

- [ ] **Step 4: Build to verify**

Run: `pnpm --filter web build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add viewer/web/src/ws-client.ts viewer/web/src/store.tsx
git commit -m "feat(viewer): track ws connection + last-update in store"
```

---

## Task 6: App shell regions

**Files:**
- Modify: `viewer/web/src/App.tsx`

This restructures the shell and lifts `selectedNodeId` + toast state to `App`. Header/Inspector/ToastStack are imported now but implemented in later tasks — to keep the build green, create minimal stubs first (Step 1), then flesh them out in their own tasks.

- [ ] **Step 1: Create minimal stubs so imports resolve**

Create `viewer/web/src/Header.tsx`:

```tsx
export function Header() { return <header className="hdr" />; }
```

Create `viewer/web/src/Inspector.tsx`:

```tsx
export function Inspector(_: { selectedNodeId: string | null }) { return <aside className="inspector-wrap" />; }
```

Create `viewer/web/src/Toast.tsx`:

```tsx
export interface ToastItem { id: number; variant: 'loading' | 'success' | 'warning' | 'error' | 'info'; title: string; message?: string; detail?: string[]; }
export function ToastStack(_: { toasts: ToastItem[]; onClose: (id: number) => void }) { return null; }
```

- [ ] **Step 2: Rewrite `viewer/web/src/App.tsx` shell**

```tsx
import { useEffect, useState } from 'react';
import { StoreProvider, useStore } from './store';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import { Graph } from './Graph';
import { Inspector } from './Inspector';
import { ToastStack, type ToastItem } from './Toast';
import { DB } from './db';

function Body() {
  const { state, open, enterMF } = useStore();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    if (!state.currentPath && state.files.length > 0) open(state.files[0].path);
  }, [state.files, state.currentPath, open]);

  const current = state.breadcrumb[state.breadcrumb.length - 1];
  const payload = current ? state.graphs[current] : undefined;

  const closeToast = (id: number) => setToasts(ts => ts.filter(t => t.id !== id));

  return (
    <div className="app">
      <Header
        graph={payload?.graph}
        nodes={/* live positions injected by Graph via callback in Task 9 */ undefined}
        pushToast={(t) => setToasts(ts => [...ts, t])}
      />
      <div className="body">
        <aside className="sidebar-wrap"><Sidebar /></aside>
        <main className="canvas-wrap">
          {payload
            ? <Graph payload={payload} basePath={current!} db={DB} onEnterMF={enterMF} onSelectNode={setSelectedNodeId} />
            : <div className="canvas-empty">Select a graph from the left.</div>}
        </main>
        <Inspector graph={payload?.graph} selectedNodeId={selectedNodeId} />
      </div>
      <ToastStack toasts={toasts} onClose={closeToast} />
    </div>
  );
}

export function App() { return <StoreProvider><Body /></StoreProvider>; }
```

NOTE: `Header` and `Graph` props (`graph`, `pushToast`, `onSelectNode`, live node positions for export) are finalized in Tasks 7 and 9. For this task, give `Header`/`Inspector`/`Graph` permissive prop types in their stubs so the build passes; tighten them in their own tasks.

- [ ] **Step 3: Update stub signatures to accept the new props**

`Header.tsx` stub → `export function Header(_: any) { return <header className="hdr" />; }`
`Inspector.tsx` stub → `export function Inspector(_: any) { return <aside className="inspector-wrap" />; }`
Add `onSelectNode?: (id: string | null) => void;` to `GraphProps` in `Graph.tsx` (unused for now).

- [ ] **Step 4: Add shell layout CSS to `theme.css`**

```css
.body { flex: 1; display: flex; min-height: 0; }
.sidebar-wrap { width: 264px; flex: none; border-right: 1px solid var(--bd); background: var(--bg1); }
.canvas-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; position: relative; }
.inspector-wrap { width: 300px; flex: none; border-left: 1px solid var(--bd); background: var(--bg1); overflow-y: auto; }
.canvas-empty { color: var(--fg-faint); padding: 20px; }
```

- [ ] **Step 5: Build + observe**

Run: `pnpm --filter web build` → succeeds.
Run: `pnpm --filter web dev`, open the app. Expected: header strip on top, sidebar left, canvas middle (graph renders), empty inspector column on the right. No console errors.

- [ ] **Step 6: Commit**

```bash
git add viewer/web/src/App.tsx viewer/web/src/Header.tsx viewer/web/src/Inspector.tsx viewer/web/src/Toast.tsx viewer/web/src/theme.css viewer/web/src/Graph.tsx
git commit -m "feat(viewer): restructure app shell into header/3-pane/toast regions"
```

---

## Task 7: Header — brand, breadcrumb, watch pill, Export, MF-root popover, Import

**Files:**
- Create: `viewer/web/src/header.css`
- Modify: `viewer/web/src/Header.tsx`, `viewer/web/src/Graph.tsx`, `viewer/web/src/App.tsx`

The Export logic currently lives in `Graph.tsx` (`handleExport`, `mfRoot`, the Panel + toast). Move clipboard export to the Header. Graph must expose live node positions for export — add a callback.

- [ ] **Step 1: Have `Graph` report live node positions up to App**

In `Graph.tsx`, add `onPositions?: (p: Record<string, {x:number;y:number}>) => void` to `GraphProps`. After `const allNodes = [...]`, add an effect:

```tsx
  useEffect(() => {
    if (!onPositions) return;
    const p: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) p[n.id] = { x: n.position.x, y: n.position.y };
    onPositions(p);
  }, [nodes, onPositions]);
```

Remove from `Graph.tsx`: the `mfRoot` state, `toast` state, `handleExport`, and the entire `<Panel position="top-right">…</Panel>` block (export UI moves to Header). Keep `<Background>`, `<Controls>`, `<MiniMap>` (restyled in Task 9). Keep `graphToUET3D`/`EXPORT_META` imports only if still used elsewhere; otherwise remove the now-unused imports (`graphToUET3D`, `EXPORT_META`) from Graph to avoid orphans.

- [ ] **Step 2: Lift export inputs in `App.tsx`**

In `Body`, hold positions and pass to Header + Graph:

```tsx
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  // ...
  <Header graph={payload?.graph} derivedPins={payload?.derivedPins} positions={positions} pushToast={(t) => setToasts(ts => [...ts, { id: Date.now() + Math.random(), ...t }])} />
  // ...
  <Graph ... onSelectNode={setSelectedNodeId} onPositions={setPositions} />
```

Change `pushToast` to accept an object without `id` (`Omit<ToastItem,'id'>`); assign the id in App. Update `ToastItem` usage accordingly.

- [ ] **Step 3: Implement `viewer/web/src/Header.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useStore } from './store';
import { formatSyncAgo } from './syncStatus';
import { hasMaterialFunctionCall } from './graphInfo';
import { graphToUET3D } from './export/ueT3D';
import { EXPORT_META } from './export/export-meta';
import type { MatGraph, DerivedPins } from './protocol';
import type { ToastItem } from './Toast';
import './header.css';

interface HeaderProps {
  graph?: MatGraph;
  derivedPins?: Record<string, DerivedPins>;
  positions: Record<string, { x: number; y: number }>;
  pushToast: (t: Omit<ToastItem, 'id'>) => void;
}

function WatchPill() {
  const { state } = useStore();
  const [, force] = useState(0);
  useEffect(() => { const id = setInterval(() => force(n => n + 1), 1000); return () => clearInterval(id); }, []);
  if (state.connection === 'snapshot') return <span className="watch-pill snap"><span className="watch-dot" /> snapshot</span>;
  if (state.connection === 'reconnecting') return <span className="watch-pill warn"><span className="watch-dot" /> reconnecting…</span>;
  const ago = state.lastUpdate ? formatSyncAgo(Date.now() - state.lastUpdate) : '';
  return <span className="watch-pill"><span className="watch-dot live" /> watching · synced {ago}</span>;
}

export function Header({ graph, derivedPins, positions, pushToast }: HeaderProps) {
  const { state, popBreadcrumb } = useStore();
  const [mfRoot, setMfRoot] = useState(() => localStorage.getItem('ue-mf-root') || '/Game/');
  const [popoverOpen, setPopoverOpen] = useState(false);
  const usesMF = hasMaterialFunctionCall(graph);

  const doExport = async () => {
    if (!graph || !derivedPins) return;
    const { text, warnings } = graphToUET3D(graph, positions, EXPORT_META, derivedPins, { mfContentRoot: mfRoot });
    const count = text ? (text.match(/^Begin Object Class=\/Script\/UnrealEd\.MaterialGraphNode/gm)?.length ?? 0) : 0;
    try {
      await navigator.clipboard.writeText(text);
      const message = graph.type === 'MaterialFunction'
        ? `Copied ${count} nodes. Create a Material Function "${graph.name}" under ${mfRoot} and paste here.`
        : `Copied ${count} nodes — paste into UE's Material Editor.`;
      pushToast({ variant: warnings.length ? 'warning' : 'success', title: 'Exported to UE', message, detail: warnings });
    } catch {
      pushToast({ variant: 'error', title: 'Clipboard blocked', message: 'Copy manually from the console.', detail: warnings });
      console.log(text);
    }
  };

  const niceName = (p: string) => p.replace(/^functions\//, '').replace('.matgraph.json', '');

  return (
    <header className="hdr">
      <div className="hdr-left">
        <div className="brand"><span className="brand-mark">▦</span><span className="brand-name">UE·MAT</span><span className="brand-sub">workflow</span></div>
        <div className="crumb">
          {state.breadcrumb.map((p, i) => (
            <span key={i} className="crumb-seg">
              {i > 0 && <span className="crumb-sep">▸</span>}
              <button className={i === state.breadcrumb.length - 1 ? 'crumb-cur' : 'crumb-link'} onClick={() => popBreadcrumb(i)}>{niceName(p)}</button>
            </span>
          ))}
        </div>
      </div>
      <div className="hdr-right">
        <WatchPill />
        <div className="export-group">
          <button className="btn-export" onClick={doExport} disabled={!graph}>導出到 UE</button>
          <button className={`btn-mfroot ${usesMF ? 'hint' : ''}`} title="MF content root" onClick={() => setPopoverOpen(o => !o)}>⚙</button>
          {popoverOpen && (
            <div className="mfroot-popover">
              <label>MF content root <span className="hint-txt">where your MaterialFunctions live in UE</span></label>
              <input value={mfRoot} onChange={e => { setMfRoot(e.target.value); localStorage.setItem('ue-mf-root', e.target.value); }} />
            </div>
          )}
        </div>
        <button className="btn-import" disabled title="coming soon">導入</button>
      </div>
    </header>
  );
}
```

- [ ] **Step 4: Create `viewer/web/src/header.css`**

```css
.hdr { display: flex; align-items: center; justify-content: space-between; gap: 16px;
  height: 48px; padding: 0 14px; background: var(--hed); border-bottom: 1px solid var(--bd); }
.hdr-left { display: flex; align-items: center; gap: 16px; min-width: 0; }
.brand { display: flex; align-items: baseline; gap: 6px; }
.brand-mark { color: var(--accent); }
.brand-name { font-weight: 700; letter-spacing: .02em; }
.brand-sub { color: var(--fg-faint); font-size: 11px; }
.crumb { display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; }
.crumb-sep { color: var(--fg-faint); margin: 0 2px; }
.crumb-link, .crumb-cur { background: none; border: 0; color: var(--fg-dim); cursor: pointer; font: inherit; padding: 2px 4px; }
.crumb-link:hover { color: var(--fg); }
.crumb-cur { color: var(--fg); cursor: default; }
.hdr-right { display: flex; align-items: center; gap: 10px; }
.watch-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--fg-dim);
  background: var(--bg2); border: 1px solid var(--bd); border-radius: 999px; padding: 4px 10px; }
.watch-pill.warn { color: var(--warn); }
.watch-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fg-faint); }
.watch-dot.live { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.export-group { position: relative; display: flex; }
.btn-export { background: var(--accent); color: #fff; border: 0; border-radius: var(--radius) 0 0 var(--radius);
  padding: 6px 12px; font: inherit; font-weight: 600; cursor: pointer; }
.btn-export:disabled { opacity: .5; cursor: not-allowed; }
.btn-mfroot { background: var(--bg2); color: var(--fg-dim); border: 0; border-left: 1px solid var(--bd);
  border-radius: 0 var(--radius) var(--radius) 0; padding: 6px 9px; cursor: pointer; }
.btn-mfroot.hint { color: var(--warn); box-shadow: 0 0 0 1px var(--warn) inset; }
.mfroot-popover { position: absolute; top: 38px; right: 0; z-index: 50; width: 240px; display: flex; flex-direction: column; gap: 6px;
  background: var(--bg2); border: 1px solid var(--bd); border-radius: var(--radius); padding: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
.mfroot-popover label { font-size: 11px; color: var(--fg-dim); }
.hint-txt { display: block; color: var(--fg-faint); font-size: 10px; }
.mfroot-popover input { background: var(--bg0); color: var(--fg); border: 1px solid var(--bd); border-radius: 5px; padding: 5px 7px; font: inherit; }
.btn-import { background: var(--bg2); color: var(--fg-faint); border: 1px solid var(--bd); border-radius: var(--radius); padding: 6px 12px; cursor: not-allowed; }
```

- [ ] **Step 5: Build + observe**

Run: `pnpm --filter web build` → succeeds (confirm no orphan imports remain in `Graph.tsx`).
Run: `pnpm --filter web dev`. Expected: header shows brand + breadcrumb (click a crumb navigates back), watch pill shows "watching · synced Ns ago" (and "reconnecting…" if you stop the server); clicking ⚙ opens the MF-root popover; when the current material has an `f()` node the ⚙ shows the warn hint; `導出到 UE` copies T3D (paste-check in a scratch buffer); `導入` is disabled.

- [ ] **Step 6: Commit**

```bash
git add viewer/web/src/Header.tsx viewer/web/src/header.css viewer/web/src/Graph.tsx viewer/web/src/App.tsx
git commit -m "feat(viewer): header with breadcrumb, watch pill, export + MF-root popover"
```

---

## Task 8: Node sizing without params (TDD) + MaterialNode reskin

**Files:**
- Modify: `viewer/web/src/layout.ts`, `viewer/web/src/nodes/MaterialNode.tsx`, `viewer/web/src/nodes/styles.css`
- Test: `viewer/tests/layout-sizing.test.ts`

Params move to the Inspector (Task 11), so node height/width must stop reserving space for params.

- [ ] **Step 1: Write the failing test** — `viewer/tests/layout-sizing.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { computeNodeHeight, computeNodeWidth } from '../web/src/layout';

const withCode = { label: 'Custom', inputs: [{ name: 'In', type: 'Float' }], outputs: [{ name: 'Out', type: 'Float' }],
  params: { Code: 'return saturate(x);\n'.repeat(10) } };
const noParams = { label: 'Custom', inputs: [{ name: 'In', type: 'Float' }], outputs: [{ name: 'Out', type: 'Float' }], params: {} };

describe('node sizing ignores params', () => {
  it('height is identical with or without params', () => {
    expect(computeNodeHeight(withCode)).toBe(computeNodeHeight(noParams));
  });
  it('width is identical with or without params', () => {
    expect(computeNodeWidth(withCode)).toBe(computeNodeWidth(noParams));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test layout-sizing`
Expected: FAIL — current sizing adds param height/width.

- [ ] **Step 3: Update `viewer/web/src/layout.ts`**

In `computeNodeHeight`, delete the `params`/`paramEntries`/`paramHeight` block and remove `paramHeight` from the return; new body:

```ts
export function computeNodeHeight(data: any): number {
  const inputs = (data && data.inputs) || [];
  const outputs = (data && data.outputs) || [];
  const maxPins = Math.max(inputs.length, outputs.length);
  const pinHeight = maxPins * 18;
  const warningHeight = data && data.warning ? 20 : 0;
  return 30 + Math.max(20, pinHeight) + warningHeight + 12;
}
```

In `computeNodeWidth`, delete the `params`/`paramEntries` block (the `maxRowWidth = Math.max(..., 320/220)` lines). Leave title + pin-row width logic intact. Remove the now-unused `isCodeLikeValue`, `codeBlockHeight`, `inlineParamHeight`, and `PARAM_VALUE_CHARS_PER_LINE` helpers (orphaned by this change).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test layout-sizing`
Expected: PASS. Also run `pnpm test` — all existing tests still green.

- [ ] **Step 5: Reskin `viewer/web/src/nodes/MaterialNode.tsx` (param-free anatomy)**

Replace the component body. Drop the params block and the `CodeBlock`/`isCodeLike` (those move to Inspector in Task 11). Add category dot + subtitle support and typed pin dots:

```tsx
import { Handle, Position } from 'reactflow';
import { pinColor } from '../theme/colors';
import { catColor } from '../theme/colors';
import './styles.css';

export interface MaterialNodeData {
  label: string;
  id: string;
  subtitle?: string;
  category?: string;
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
  params?: Record<string, unknown>;
  warning?: string;
  isReserved?: boolean;
  isMF?: boolean;
}

export function MaterialNode({ data }: { data: MaterialNodeData }) {
  const cls = ['gnode'];
  if (data.warning) cls.push('gnode-warn');
  if (data.isReserved) cls.push('gnode-reserved');
  return (
    <div className={cls.join(' ')}>
      <div className="gnode-head">
        <span className="gnode-catdot" style={{ background: catColor(data.category) }} />
        <div className="gnode-titles">
          <div className="gnode-title">{data.label}</div>
          {data.subtitle && <div className="gnode-sub">{data.subtitle}</div>}
        </div>
        {data.warning && <span className="gnode-badge warn" title={data.warning}>!</span>}
        {data.isMF && <span className="gnode-badge mf" title="MaterialFunction call">ƒ</span>}
      </div>
      <div className="gnode-body">
        <div className="gnode-col gnode-in">
          {data.inputs.map(p => (
            <div key={p.name} className="gpin">
              <Handle id={p.name} type="target" position={Position.Left} />
              <span className="gpin-dot" style={{ background: pinColor(p.type) }} />
              <span className="gpin-name">{p.name}</span>
            </div>
          ))}
        </div>
        <div className="gnode-col gnode-out">
          {data.outputs.map(p => (
            <div key={p.name} className="gpin gpin-r">
              <span className="gpin-name">{p.name || '(out)'}</span>
              <span className="gpin-dot" style={{ background: pinColor(p.type) }} />
              <Handle id={p.name} type="source" position={Position.Right} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

NOTE: the wrapper node components keep working — `MaterialFunctionCallNode` already sets `isReserved`; update it to also pass `isMF: true` and a `subtitle` (the MF name) instead of the `f() ` label prefix. Edit `MaterialFunctionCallNode.tsx`: set `label: 'MaterialFunctionCall', subtitle: data.label, isMF: true` in the `md` object. `MaterialOutputNode`/`FunctionIONode` need no change (they pass through `MaterialNodeData`).

- [ ] **Step 5b: Populate `category` on generic nodes in `Graph.tsx`**

The category dot reads `data.category`, so the generic-node builder must supply it. In `Graph.tsx`, in the final `return { id: n.id, type: 'generic', ... data: { ... } }` for DB-backed nodes, add `category: def?.category` to the `data` object (next to `label`). MaterialFunctionCall nodes set their own category via the wrapper; reserved nodes (Output/IO) may leave it undefined (defaults to the neutral category color). Build to confirm types: `pnpm --filter web build`.

- [ ] **Step 6: Reskin nodes in `viewer/web/src/nodes/styles.css`**

Replace the `.mat-*` rules with the `.gnode` anatomy (remove `.mat-node*`, `.mat-pin*`, `.mat-node-params`, `.mat-param`, `.mat-code`, `.mat-copy-btn`, `.mat-warn*`, `.mat-reserved` — they are orphaned by the JSX change). Keep the `.react-flow__edge*` and `.react-flow__handle*` rules (edges/handles), updating colors to tokens; typed edge color is set inline in Task 9. New node CSS:

```css
.gnode { background: var(--bg2); border: 1px solid var(--bd); border-radius: var(--radius);
  min-width: 180px; max-width: 380px; color: var(--fg); font-size: 12px; overflow: hidden; }
.gnode-head { display: flex; align-items: center; gap: 8px; padding: 7px 10px; background: var(--bg1); border-bottom: 1px solid var(--bd); }
.gnode-catdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.gnode-titles { min-width: 0; flex: 1; }
.gnode-title { font-weight: 600; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gnode-sub { font-size: 10px; color: var(--fg-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gnode-badge { width: 16px; height: 16px; line-height: 16px; text-align: center; border-radius: 4px; font-size: 11px; flex: none; }
.gnode-badge.warn { background: rgba(224,179,77,.18); color: var(--warn); }
.gnode-badge.mf { background: rgba(160,107,255,.18); color: var(--accent); }
.gnode-body { display: flex; gap: 16px; padding: 8px 0; min-height: 24px; }
.gnode-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.gnode-in { padding-left: 12px; }
.gnode-out { padding-right: 12px; align-items: flex-end; }
.gpin { position: relative; display: flex; align-items: center; gap: 6px; height: 18px; white-space: nowrap; }
.gpin-r { flex-direction: row; justify-content: flex-end; }
.gpin-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.gpin-name { color: var(--fg-dim); }
.gnode-warn { border-color: var(--warn); }
.gnode-reserved .gnode-head { background: #20283a; }
```

- [ ] **Step 7: Build + observe**

Run: `pnpm --filter web build` → succeeds (no orphan imports/classes).
Run: `pnpm --filter web dev`. Expected: nodes show a category dot + title (+ subtitle on MF/Output/IO nodes), input pins on the left with colored dots, outputs on the right; MFCall nodes show the `ƒ` badge and still **double-click to enter** the MF; unknown nodes show the `!` badge. No params on nodes. Layout still looks reasonable (no overlap from stale sizing).

- [ ] **Step 8: Commit**

```bash
git add viewer/web/src/layout.ts viewer/web/src/nodes/MaterialNode.tsx viewer/web/src/nodes/MaterialFunctionCallNode.tsx viewer/web/src/nodes/styles.css viewer/tests/layout-sizing.test.ts
git commit -m "feat(viewer): param-free node anatomy + token sizing"
```

---

## Task 9: Canvas — typed edges, selection dimming, grid, MiniMap, zoom, fit-on-change

**Files:**
- Modify: `viewer/web/src/Graph.tsx`, `viewer/web/src/nodes/styles.css`

- [ ] **Step 1: Type-color edges + carry source pin type**

In `Graph.tsx` where `rfEdges` is built, attach the source pin's type so the edge can be colored. After resolving `finalOutputs` per node you already have output types; simplest: in the edge map, look up the source node's output type from `derivedPins`/DB. Set edge style:

```tsx
    const rfEdges: Edge[] = graph.connections.map((c, i) => {
      const [src, srcPin] = c.from.split(':');
      const [tgt, tgtPin] = c.to.split(':');
      const srcType = derivedPins[src]?.outputs.find(o => o.name === srcPin)?.type
        ?? db.nodes[graph.nodes.find(n => n.id === src)?.type ?? '']?.outputs?.find(o => o.name === srcPin)?.type;
      return { id: `e${i}`, source: src, sourceHandle: srcPin, target: tgt, targetHandle: tgtPin,
        style: { stroke: pinColor(srcType), strokeWidth: 2 } };
    });
```

Add `import { pinColor } from './theme/colors';` at the top.

- [ ] **Step 2: Selection dimming via `onNodeClick` + connected set**

Add selection state and report it up (App needs it for the Inspector — `onSelectNode`). Compute the connected set and dim others by setting node/edge opacity. In the component:

```tsx
  const [selId, setSelId] = useState<string | null>(null);
  const connSet = useMemo(() => {
    if (!selId) return null;
    const s = new Set<string>([selId]);
    for (const c of graph.connections) {
      const a = c.from.split(':')[0], b = c.to.split(':')[0];
      if (a === selId) s.add(b); if (b === selId) s.add(a);
    }
    return s;
  }, [selId, graph.connections]);
```

Apply opacity in the rendered nodes/edges: when `connSet` is set, nodes not in it get `style.opacity = .3`, edges whose endpoints aren't both in it get `style.opacity = .15`. Wire `onNodeClick={(_, n) => { setSelId(n.id); onSelectNode?.(n.id); }}` and clear on pane click `onPaneClick={() => { setSelId(null); onSelectNode?.(null); }}`.

- [ ] **Step 3: fitView on graph change + keep MiniMap, restyle Background/Controls**

Replace `fitView` prop usage with an explicit ref so it re-fits on graph switch:

```tsx
import ReactFlow, { ..., useReactFlow, ReactFlowProvider } from 'reactflow';
```

Wrap the existing `Graph` body in a `ReactFlowProvider` (rename the inner component to `GraphInner`, export a `Graph` wrapper that renders `<ReactFlowProvider><GraphInner .../></ReactFlowProvider>`). In `GraphInner`:

```tsx
  const rf = useReactFlow();
  useEffect(() => {
    const id = requestAnimationFrame(() => rf.fitView({ padding: 0.2, duration: 200 }));
    return () => cancelAnimationFrame(id);
  }, [initialLayout.nodes, rf]);
```

Keep `<MiniMap />` (add `pannable zoomable` and a dark `maskColor`), keep `<Controls />` (restyle via CSS), restyle `<Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2a2f37" />`. Add `import { BackgroundVariant } from 'reactflow';`.

- [ ] **Step 4: Canvas CSS in `styles.css`** (append)

```css
.react-flow__minimap { background: var(--bg1) !important; border: 1px solid var(--bd); border-radius: var(--radius); }
.react-flow__controls { background: var(--bg2); border: 1px solid var(--bd); border-radius: var(--radius); overflow: hidden; }
.react-flow__controls button { background: var(--bg2); color: var(--fg-dim); border-bottom: 1px solid var(--bd); }
.react-flow__controls button:hover { background: var(--bg1); color: var(--fg); }
.react-flow__edge.selected .react-flow__edge-path, .react-flow__edge:hover .react-flow__edge-path { stroke-width: 3 !important; filter: drop-shadow(0 0 3px currentColor); }
```

Keep the existing `.react-flow__handle*` highlight rules (the `setHandleHighlight` edge-hover behavior stays). Update the base handle border color to `var(--bg0)`.

- [ ] **Step 5: Build + observe**

Run: `pnpm --filter web build` → succeeds.
Run: `pnpm --filter web dev`. Expected: edges colored by output pin type; clicking a node dims unrelated nodes/edges and the Inspector (Task 12) reacts; clicking empty canvas clears; MiniMap bottom-right and zoom controls present; **switching graphs in the sidebar always re-centers on the nodes** (never blank); hovering an edge still highlights both endpoint handles; MFCall double-click still enters the MF.

- [ ] **Step 6: Commit**

```bash
git add viewer/web/src/Graph.tsx viewer/web/src/nodes/styles.css
git commit -m "feat(viewer): typed edges, selection dimming, fit-on-change, themed minimap/controls"
```

---

## Task 10: Sidebar — Files tab reskin (search, sub-tabs, status/counts, empty state)

**Files:**
- Modify: `viewer/web/src/Sidebar.tsx`, `viewer/web/src/FileList.tsx`, `viewer/web/src/sidebar.css`

- [ ] **Step 1: Add a search box + Materials/Functions sub-tabs to `FileList.tsx`**

`FileList` filters by a query and a sub-tab (Material vs MaterialFunction). Counts/status come from already-loaded graphs (degrade when absent). Update `FileList`:

```tsx
import { useState } from 'react';
import { useStore } from './store';
import { groupFiles, type Project, type FileEntry } from './groupFiles';

function statusFor(path: string, state: ReturnType<typeof useStore>['state']): 'ok' | 'warn' | null {
  const errs = state.errors[path]?.length ?? 0;
  const warns = state.graphs[path]?.warnings.length ?? 0;
  if (!state.graphs[path] && !state.errors[path]) return null; // not loaded → unknown
  return errs || warns ? 'warn' : 'ok';
}
function nodeCount(path: string, state: ReturnType<typeof useStore>['state']): number | null {
  return state.graphs[path]?.graph.nodes.length ?? null;
}
```

Add `query` + `subTab` state at the top of `FileList`; filter `groupFiles(state.files)` entries by `e.type === (subTab==='material'?'Material':'MaterialFunction') || e.type==='Unknown'` and by `query`. Render a search input, the two sub-tab buttons, then the project folders. Pass `state` into `FileRow` so it can render a `StatusDot` (color by `statusFor`) and a count chip (`nodeCount`, omitted if null). Preserve: collapsible folders (default open), Unorganized (default collapsed), type icons, click-to-open, active highlight (`state.breadcrumb[0] === entry.path`), path tooltip, and the empty-state hint (unchanged text).

- [ ] **Step 2: Reskin `sidebar.css` Files section with tokens**

Replace hardcoded colors (`#1e1e1e`, `#f0c060`, etc.) with tokens; add `.sb-search`, `.sb-subtabs`/`.sb-subtab.on`, `.st-dot.ok|warn`, `.tree-count` rules. Tab underline uses `--accent`. (Active file = `--accent` text + `--bg2` background.) Keep class names used by `FileList` consistent with the JSX.

- [ ] **Step 3: Build + observe**

Run: `pnpm --filter web build` → succeeds.
Run: `pnpm --filter web dev`. Expected: Files tab has a search box (filters projects/files), Materials/Functions sub-tabs switch which files show, loaded graphs show a status dot + node count, folders collapse/expand, active material stays highlighted while drilled into an MF, empty state shows when there are no graphs.

- [ ] **Step 4: Commit**

```bash
git add viewer/web/src/Sidebar.tsx viewer/web/src/FileList.tsx viewer/web/src/sidebar.css
git commit -m "feat(viewer): files tab — search, sub-tabs, status/counts, reskin"
```

---

## Task 11: Sidebar — Nodes tab reskin (category chips, keep detail)

**Files:**
- Modify: `viewer/web/src/NodeLibrary.tsx`, `viewer/web/src/sidebar.css`

- [ ] **Step 1: Add category filter chips to `NodeLibrary.tsx`**

Add a `cat` filter state and a chip row (`All` + sorted categories from the DB). When `cat !== 'All'`, filter entries to that category. **Keep** the search box, the search-auto-expands-all behavior, the per-node expand → `NodeDetail` (description, badges, Inputs/Outputs, **Params**, **Pin rule**), and both empty states. The chip row replaces the always-collapsible category headers only visually — you may keep category grouping but render chips for quick filtering; the simplest preserving change is to keep `CategoryBlock` and add the chip row above it that sets `cat`.

```tsx
  const [cat, setCat] = useState<string>('All');
  const allCats = useMemo(() => ['All', ...Array.from(new Set(allEntries.map(e => e.def.category || 'Uncategorized'))).sort()], [allEntries]);
  // apply: const catFiltered = cat === 'All' ? filtered : filtered.filter(e => (e.def.category||'Uncategorized') === cat);
```

Render chips:

```tsx
  <div className="sb-cats">
    {allCats.map(c => <button key={c} className={`sb-cat ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>{c}</button>)}
  </div>
```

- [ ] **Step 2: Reskin `sidebar.css` Nodes section with tokens**

Replace hardcoded colors with tokens for `.lib-*` and badges. Add `.sb-cats`/`.sb-cat.on`. Badge colors: verified → `--ok`, dynamic → `--warn`, deprecated/unverified → `--err`, dynamic-pin → info/blue. Keep `.lib-node-detail*`, `.lib-node-detail-pin` (mono), and the Pin-rule italic style.

- [ ] **Step 3: Build + observe**

Run: `pnpm --filter web build` → succeeds.
Run: `pnpm --filter web dev`. Expected: Nodes tab has search + category chips; selecting a chip filters; searching auto-expands; expanding a node still shows description, badges, **Inputs/Outputs, Params, and the Pin rule**; "No matches" shows for empty search.

- [ ] **Step 4: Commit**

```bash
git add viewer/web/src/NodeLibrary.tsx viewer/web/src/sidebar.css
git commit -m "feat(viewer): nodes tab — category chips + reskin (detail preserved)"
```

---

## Task 12: Inspector (read-only)

**Files:**
- Modify: `viewer/web/src/Inspector.tsx`
- Create: `viewer/web/src/inspector.css`

- [ ] **Step 1: Implement `viewer/web/src/Inspector.tsx`**

Renders selected-node detail (with the moved param Copy) or, when nothing is selected, material settings + export readiness. Reuse `DB` for the node def, `pinColor`/`catColor` for pins, and a local `CodeBlock` (moved from MaterialNode) for code-like params.

```tsx
import { useState } from 'react';
import type { MatGraph } from './protocol';
import { DB } from './db';
import { pinColor, catColor } from './theme/colors';
import './inspector.css';

function isCodeLike(v: unknown): v is string { return typeof v === 'string' && (v.includes('\n') || v.length > 40); }

function CodeBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="insp-code">
      <pre>{value}</pre>
      <button className="insp-copy" onMouseDown={e => e.stopPropagation()}
        onClick={e => { e.stopPropagation(); navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>
        {copied ? '✓ Copied' : '⧉ Copy'}
      </button>
    </div>
  );
}

export function Inspector({ graph, selectedNodeId }: { graph?: MatGraph; selectedNodeId: string | null }) {
  if (!graph) return <aside className="inspector-wrap" />;
  const node = selectedNodeId ? graph.nodes.find(n => n.id === selectedNodeId) : undefined;

  if (node) {
    const def = DB.nodes[node.type];
    const unknown = !def;
    const params = Object.entries(node.params ?? {});
    return (
      <aside className="inspector-wrap insp">
        <div className="insp-eyebrow"><span className="insp-catdot" style={{ background: catColor(def?.category) }} /><span className="mono">{def?.category ?? 'Unknown'}</span></div>
        <div className="insp-title">{node.type}</div>
        {unknown && <div className="insp-callout"><b>Not in node DB</b><p>The viewer renders it, but Export can't map its class — it'll be flagged, not blocked.</p></div>}
        {def?.inputs?.length ? <PinList title="Inputs" pins={def.inputs} /> : null}
        {def?.outputs?.length ? <PinList title="Outputs" pins={def.outputs} /> : null}
        {params.length > 0 && (
          <div className="insp-section"><div className="insp-sub">Parameters</div>
            {params.map(([k, v]) => (
              <div className="insp-param" key={k}><div className="insp-plabel">{k}</div>
                {isCodeLike(v) ? <CodeBlock value={v} /> : <code className="mono">{JSON.stringify(v)}</code>}
              </div>
            ))}
          </div>
        )}
      </aside>
    );
  }

  const unknownCount = graph.nodes.filter(n => !DB.nodes[n.type]).length;
  return (
    <aside className="inspector-wrap insp">
      <div className="insp-eyebrow"><span className="mono">Material</span></div>
      <div className="insp-title">{graph.name}</div>
      <div className="insp-subtitle">{graph.nodes.length} nodes</div>
      <div className="insp-section"><div className="insp-sub">Export readiness</div>
        <div className="ready-row ok">✓ {graph.nodes.length - unknownCount} of {graph.nodes.length} nodes mapped</div>
        {unknownCount > 0 && <div className="ready-row warn">! {unknownCount} unknown expression{unknownCount > 1 ? 's' : ''} — partial export</div>}
      </div>
    </aside>
  );

  function PinList({ title, pins }: { title: string; pins: { name: string; type: string }[] }) {
    return (
      <div className="insp-section"><div className="insp-sub">{title}</div>
        {pins.map(p => (
          <div className="insp-pin" key={p.name}><span className="insp-pindot" style={{ background: pinColor(p.type) }} /><span>{p.name || '(out)'}</span><span className="insp-pintype mono">{p.type}</span></div>
        ))}
      </div>
    );
  }
}
```

NOTE: `MatGraph` has no Domain/Shading/Blend fields (`protocol.ts`), so the no-selection view shows name + node count + export readiness only (graceful per spec). If those fields are added later, extend here.

- [ ] **Step 2: Create `viewer/web/src/inspector.css`**

```css
.insp { padding: 14px; font-size: 12px; }
.insp-eyebrow { display: flex; align-items: center; gap: 6px; color: var(--fg-faint); font-size: 11px; }
.insp-catdot { width: 8px; height: 8px; border-radius: 50%; }
.insp-title { font-size: 15px; font-weight: 600; margin-top: 4px; }
.insp-subtitle { color: var(--fg-faint); margin-top: 2px; }
.insp-callout { background: rgba(224,179,77,.12); border: 1px solid var(--warn); border-radius: var(--radius); padding: 8px 10px; margin: 10px 0; color: var(--warn); }
.insp-callout p { margin: 4px 0 0; color: var(--fg-dim); font-size: 11px; }
.insp-section { margin-top: 14px; }
.insp-sub { text-transform: uppercase; letter-spacing: .06em; font-size: 10px; color: var(--fg-faint); margin-bottom: 6px; }
.insp-pin { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
.insp-pindot { width: 8px; height: 8px; border-radius: 50%; }
.insp-pintype { margin-left: auto; color: var(--fg-faint); }
.insp-param { margin: 6px 0; }
.insp-plabel { color: var(--fg-dim); }
.insp-code { position: relative; margin-top: 4px; }
.insp-code pre { background: var(--bg0); color: var(--warn); padding: 6px 40px 6px 8px; border-radius: 5px; font-size: 11px; margin: 0; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow: auto; }
.insp-copy { position: absolute; top: 4px; right: 4px; background: var(--bg2); color: var(--fg-dim); border: 1px solid var(--bd); border-radius: 3px; padding: 2px 6px; font-size: 9px; cursor: pointer; }
.ready-row { display: flex; gap: 6px; padding: 3px 0; }
.ready-row.warn { color: var(--warn); }
.ready-row.ok { color: var(--ok); }
```

- [ ] **Step 3: Build + observe**

Run: `pnpm --filter web build` → succeeds.
Run: `pnpm --filter web dev`. Expected: clicking a node shows its category, type, inputs/outputs (typed, colored), and parameters; a `Custom`/HLSL param shows a code block with a working **Copy** button (clicking it doesn't deselect); clicking empty canvas shows the material's name, node count, and export-readiness; unknown nodes show the callout.

- [ ] **Step 4: Commit**

```bash
git add viewer/web/src/Inspector.tsx viewer/web/src/inspector.css
git commit -m "feat(viewer): read-only inspector (node detail + material readiness)"
```

---

## Task 13: Toast system + canvas topbar (warnings) + hot-reload notice

**Files:**
- Modify: `viewer/web/src/Toast.tsx`, `viewer/web/src/App.tsx`, `viewer/web/src/Graph.tsx`
- Create: `viewer/web/src/toast.css`

- [ ] **Step 1: Implement `ToastStack` in `viewer/web/src/Toast.tsx`**

```tsx
import { useEffect } from 'react';
import './toast.css';

export interface ToastItem {
  id: number;
  variant: 'loading' | 'success' | 'warning' | 'error' | 'info';
  title: string;
  message?: string;
  detail?: string[];
}

const ICON: Record<ToastItem['variant'], string> = { loading: '↻', success: '✓', warning: '!', error: '✕', info: '↻' };

function Toast({ t, onClose }: { t: ToastItem; onClose: (id: number) => void }) {
  useEffect(() => {
    if (t.variant === 'loading') return;
    const id = setTimeout(() => onClose(t.id), 6000);
    return () => clearTimeout(id);
  }, [t.id]);
  return (
    <div className={`toast toast-${t.variant}`}>
      <span className="toast-ico">{ICON[t.variant]}</span>
      <div className="toast-content">
        <div className="toast-title">{t.title}</div>
        {t.message && <div className="toast-msg">{t.message}</div>}
        {t.detail && t.detail.length > 0 && <ul className="toast-detail">{t.detail.map((d, i) => <li key={i} className="mono">{d}</li>)}</ul>}
      </div>
      {t.variant !== 'loading' && <button className="toast-x" onClick={() => onClose(t.id)}>×</button>}
    </div>
  );
}

export function ToastStack({ toasts, onClose }: { toasts: ToastItem[]; onClose: (id: number) => void }) {
  return <div className="toast-stack">{toasts.map(t => <Toast key={t.id} t={t} onClose={onClose} />)}</div>;
}
```

- [ ] **Step 2: Hot-reload info toast in `App.tsx`**

Watch `state.lastUpdate` and `state.connection`; when a `graph` message updates the currently open path after initial load, push an info toast. Minimal approach: track the previous payload reference for `current` and toast on change:

```tsx
  const prevPayloadRef = useRef(payload);
  useEffect(() => {
    if (prevPayloadRef.current && payload && prevPayloadRef.current !== payload && state.connection === 'live') {
      setToasts(ts => [...ts, { id: Date.now() + Math.random(), variant: 'info', title: 'Graph updated', message: `${current} reloaded from disk.` }]);
    }
    prevPayloadRef.current = payload;
  }, [payload, current, state.connection]);
```

(Import `useRef`.)

- [ ] **Step 3: Canvas topbar with all errors + warnings**

Add a topbar above the ReactFlow canvas in `App.tsx`'s `canvas-wrap` (or inside Graph). It shows the material name + node/link counts + an errors/warnings summary pulling **all** of `state.errors[current]` and `payload.warnings`:

```tsx
  const errs = current ? (state.errors[current] ?? []) : [];
  const warns = payload?.warnings ?? [];
  // inside <main className="canvas-wrap">, before <Graph/>:
  {payload && (
    <div className="canvas-topbar">
      <div className="ct-left"><span className="ct-title">{payload.graph.name}</span></div>
      <div className="ct-right">
        {(errs.length + warns.length) > 0 && <span className="ct-warn" title={[...errs, ...warns].join('\n')}>! {errs.length} error{errs.length!==1?'s':''} · {warns.length} warning{warns.length!==1?'s':''}</span>}
        <span className="ct-count mono">{payload.graph.nodes.length} nodes · {payload.graph.connections.length} links</span>
      </div>
    </div>
  )}
```

The old `WarningPanel` import/usage is already gone from `App.tsx` (Task 6). Delete `WarningPanel.tsx` only if nothing else imports it — otherwise leave it; mention in the commit. (Per surgical-change rule: if unused, remove it and its import.)

- [ ] **Step 4: Create `viewer/web/src/toast.css` + topbar CSS (in theme.css)**

```css
/* toast.css */
.toast-stack { position: fixed; right: 16px; bottom: 16px; z-index: 1000; display: flex; flex-direction: column; gap: 8px; max-width: 340px; }
.toast { display: flex; gap: 10px; background: var(--bg2); border: 1px solid var(--bd); border-left-width: 3px; border-radius: var(--radius); padding: 10px 12px; box-shadow: 0 8px 24px rgba(0,0,0,.4); }
.toast-success { border-left-color: var(--ok); }
.toast-warning { border-left-color: var(--warn); }
.toast-error { border-left-color: var(--err); }
.toast-info, .toast-loading { border-left-color: var(--accent); }
.toast-ico { color: var(--fg-dim); }
.toast-content { min-width: 0; flex: 1; }
.toast-title { font-weight: 600; }
.toast-msg { color: var(--fg-dim); font-size: 11px; margin-top: 2px; }
.toast-detail { margin: 6px 0 0; padding-left: 16px; color: var(--warn); font-size: 11px; }
.toast-x { background: none; border: 0; color: var(--fg-faint); cursor: pointer; font-size: 16px; }
```

```css
/* add to theme.css */
.canvas-topbar { display: flex; align-items: center; justify-content: space-between; height: 36px; padding: 0 12px; background: var(--bg1); border-bottom: 1px solid var(--bd); }
.ct-title { font-weight: 600; }
.ct-right { display: flex; align-items: center; gap: 12px; }
.ct-warn { color: var(--warn); font-size: 11px; }
.ct-count { color: var(--fg-faint); font-size: 11px; }
```

- [ ] **Step 5: Build + observe**

Run: `pnpm --filter web build` → succeeds.
Run: `pnpm --filter web dev`. Expected: topbar shows name + counts + (when present) an errors/warnings summary covering load errors and MF/pin warnings; exporting shows a success/warning toast (warnings listed); editing a `.matgraph.json` on disk hot-reloads with an info toast; toasts auto-dismiss.

- [ ] **Step 6: Commit**

```bash
git add viewer/web/src/Toast.tsx viewer/web/src/toast.css viewer/web/src/App.tsx viewer/web/src/theme.css viewer/web/src/Graph.tsx
git rm viewer/web/src/WarningPanel.tsx  # only if confirmed unused
git commit -m "feat(viewer): toast system, canvas topbar warnings, hot-reload notice"
```

---

## Task 14: Parity + final verification pass

**Files:** none (verification only).

- [ ] **Step 1: Server tests green**

Run: `pnpm test` (from `viewer/`)
Expected: all suites pass, including the new `pinColor`/`syncStatus`/`graphInfo`/`layout-sizing` tests.

- [ ] **Step 2: Production build green**

Run: `pnpm --filter web build`
Expected: success, no TS errors, no unused-import warnings from the changes.

- [ ] **Step 3: Single-file export still works (new UI inherits)**

Run (from `viewer/`, against a known graph): `node dist/server/index.js` is not needed; instead build then export. From repo root: `pnpm --filter web build` then `node viewer/dist/server/html-export.js export <name> --out /tmp/export-check.html` (or the documented `ue-mat-viewer export` path). Open `/tmp/export-check.html` in a browser.
Expected: the new UI renders, the graph loads from injected data, and the watch pill reads **snapshot**.

- [ ] **Step 4: Walk the Functionality parity checklist**

Open `pnpm --filter web dev` and confirm every row of the spec's parity checklist works: breadcrumb pop, all errors+warnings surfaced, Files (folders/Unorganized/icons/active/tooltip/empty-state), Nodes (search/auto-expand/no-match/detail with Params+Pin rule), edge-hover handle highlight, params + Copy in Inspector, MFCall double-click + `ƒ`, node drag + dagre + CommentBox, MiniMap + zoom + fit-on-change, export → clipboard + warnings toast, disabled Import, MF-root popover (auto-hint when MF present), export-mode snapshot.

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A
git commit -m "chore(viewer): UI redesign parity verification fixes"
```

---

## Self-Review notes (author)

- **Spec coverage:** §A shell (T6), §B tokens (T1–T2), §C canvas incl. MiniMap/fit/edge-hover/MF-dblclick (T8–T9), §D sidebar incl. empty states + Params/Pin rule (T10–T11), §E header+watch+export+MF popover+Import (T5,T7), §F inspector incl. param Copy (T12), §G toasts + comprehensive warnings (T13). Parity checklist → T14.
- **Pure-helper TDD** where logic exists (colors, sync age, MF detection, node sizing); components verified by build + observation (no React test runner in `viewer/web`, intentionally not added).
- **Orphan cleanup** called out explicitly (Graph export imports, layout param helpers, `.mat-*` CSS, `WarningPanel.tsx`).
- **Open items from spec** carried as NOTEs in-task: material settings absent from `MatGraph` (Inspector degrades), status/counts from loaded graphs only (FileList degrades), Controls-vs-custom decided as restyled native `Controls` + MiniMap.

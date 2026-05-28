# Sidebar — Projects & Node Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the viewer sidebar around project folders (`graphs/<project>/`) and add a Node Library tab that lets users search/browse the 142-node UE 5.7 DB.

**Architecture:** WS protocol's `files` payload changes from `string[]` to `{path, type}[]` (server reads top-level `type` field per JSON). A pure `groupFiles()` function turns that flat list into a tree of projects + Unorganized. The sidebar becomes a tab strip wrapping two panels: `<FileList>` (tree) and `<NodeLibrary>` (search + categorized list with inline detail). DB is already bundled client-side via `@db` alias.

**Tech Stack:** TypeScript, React, vitest, Node http+ws.

Spec: `docs/superpowers/specs/2026-05-28-sidebar-projects-and-node-library.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `viewer/server/ws-protocol.ts` | Modify | Add `FileEntry` type; `hello`/`fileList` use `FileEntry[]` |
| `viewer/server/http-server.ts` | Modify | `listFiles()` returns `FileEntry[]` (reads top-level `type`) |
| `viewer/tests/http-server.test.ts` | Modify | Updated assertion shape |
| `viewer/web/src/protocol.ts` | Modify | Mirror `FileEntry` type |
| `viewer/web/src/groupFiles.ts` | Create | Pure: flat entries → `{projects, unorganized}` |
| `viewer/tests/group-files.test.ts` | Create | Unit tests for grouping rules |
| `viewer/web/src/store.tsx` | Modify | State holds `FileEntry[]`; html-export branch maps to entries |
| `viewer/web/src/Sidebar.tsx` | Create | Tab strip + panel mount |
| `viewer/web/src/FileList.tsx` | Rewrite | Render tree from `groupFiles` output |
| `viewer/web/src/NodeLibrary.tsx` | Create | Search + categorized list + inline detail |
| `viewer/web/src/sidebar.css` | Create | Styling for tabs, tree, library |
| `viewer/web/src/App.tsx` | Modify | Mount `<Sidebar />` instead of `<FileList />` |
| `agent-pack/SPEC.md` | Modify | Update §"Where to write" + MF path examples |
| `agent-pack/CLAUDE.md` | Modify | Update output location guidance |
| `agent-pack/AGENTS.md` | Modify | Same |
| `agent-pack/GEMINI.md` | Modify | Same |

---

## Task 1: Add `FileEntry` type to both protocol files

**Files:**
- Modify: `viewer/server/ws-protocol.ts`
- Modify: `viewer/web/src/protocol.ts`

- [ ] **Step 1: Update `viewer/server/ws-protocol.ts`**

Replace the current content with:

```typescript
import type { MatGraph } from './types.js';
import type { ResolvedGraph } from './mf-resolver.js';

export interface FileEntry {
  path: string;
  type: 'Material' | 'MaterialFunction' | 'Unknown';
}

export type ServerMessage =
  | { kind: 'hello'; graphsRoot: string; files: FileEntry[] }
  | { kind: 'fileList'; files: FileEntry[] }
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

- [ ] **Step 2: Mirror in `viewer/web/src/protocol.ts`**

Edit only the `ServerMessage` block (keep all other interfaces intact). Add `FileEntry` and change `files: string[]` → `files: FileEntry[]`:

```typescript
export interface FileEntry {
  path: string;
  type: 'Material' | 'MaterialFunction' | 'Unknown';
}

export type ServerMessage =
  | { kind: 'hello'; graphsRoot: string; files: FileEntry[] }
  | { kind: 'fileList'; files: FileEntry[] }
  | { kind: 'graph'; path: string; payload: GraphPayload }
  | { kind: 'graphError'; path: string; errors: string[] };
```

- [ ] **Step 3: Build to confirm protocol compiles (web client + server)**

Run from repo root with `pnpm` on PATH:
```bash
pnpm -r build 2>&1 | tail -20
```
Expected: builds will fail downstream (http-server.ts, store.tsx, FileList.tsx still pass `string[]`). That's expected at this point — we'll fix in next tasks. Confirm `ws-protocol.ts` and `protocol.ts` themselves have no errors (the failures should be in *consumers*).

- [ ] **Step 4: Commit**
```bash
git add viewer/server/ws-protocol.ts viewer/web/src/protocol.ts
git commit -m "feat(protocol): file list carries Material/MF type"
```

---

## Task 2: Server `listFiles()` returns `FileEntry[]`

**Files:**
- Modify: `viewer/server/http-server.ts:64-80`
- Modify: `viewer/tests/http-server.test.ts:24`

- [ ] **Step 1: Replace `listFiles` in `http-server.ts`**

Find the current `listFiles` function (lines 64-80) and replace with:

```typescript
async function readGraphType(absPath: string): Promise<FileEntry['type']> {
  try {
    const raw = await readFile(absPath, 'utf-8');
    const parsed = JSON.parse(raw) as { type?: string };
    if (parsed.type === 'Material' || parsed.type === 'MaterialFunction') return parsed.type;
    return 'Unknown';
  } catch {
    return 'Unknown';
  }
}

async function listFiles(): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  async function walk(dir: string) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith('.matgraph.json')) {
        const type = await readGraphType(full);
        out.push({ path: relative(graphsRoot, full), type });
      }
    }
  }
  await walk(graphsRoot);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
```

- [ ] **Step 2: Update import in `http-server.ts`**

Find the existing import line:
```typescript
import type { ServerMessage, ClientMessage } from './ws-protocol.js';
```
Replace with:
```typescript
import type { ServerMessage, ClientMessage, FileEntry } from './ws-protocol.js';
```

- [ ] **Step 3: Update the failing test `viewer/tests/http-server.test.ts`**

Replace the assertion block (around line 23-24) which currently reads:
```typescript
    expect(hello.kind).toBe('hello');
    expect(hello.files.sort()).toEqual(['a.matgraph.json', 'functions/b.matgraph.json']);
```

The test writes empty `{}` files (no `type` field), so the type comes back as `'Unknown'`. Replace with:
```typescript
    expect(hello.kind).toBe('hello');
    expect(hello.files).toEqual([
      { path: 'a.matgraph.json', type: 'Unknown' },
      { path: 'functions/b.matgraph.json', type: 'Unknown' },
    ]);
```

- [ ] **Step 4: Add a test case that exercises real `type` values**

In the same test file, append a new test inside the existing `describe('startServer', ...)` block, AFTER the existing `it` block (still inside the `describe` callback). Insert before the closing `});` of the describe block:

```typescript
  it('reports Material and MaterialFunction types from file content', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'srv-'));
    mkdirSync(resolve(root, 'graphs/mat1'), { recursive: true });
    writeFileSync(resolve(root, 'graphs/mat1/main.matgraph.json'),
      JSON.stringify({ type: 'Material', schemaVersion: '1.0', ueVersion: '5.7', name: 'main', nodes: [], connections: [] }));
    writeFileSync(resolve(root, 'graphs/mat1/helper.matgraph.json'),
      JSON.stringify({ type: 'MaterialFunction', schemaVersion: '1.0', ueVersion: '5.7', name: 'helper', nodes: [], connections: [] }));

    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    const ws = new WebSocket(`ws://localhost:${server.port}`);
    const hello: any = await new Promise((res, rej) => {
      ws.on('message', d => res(JSON.parse(d.toString())));
      ws.on('error', rej);
    });

    expect(hello.files).toEqual([
      { path: 'mat1/helper.matgraph.json', type: 'MaterialFunction' },
      { path: 'mat1/main.matgraph.json', type: 'Material' },
    ]);

    ws.close();
    await server.close();
  }, 5000);
```

- [ ] **Step 5: Run server tests, verify both pass**

```bash
pnpm --filter viewer test -- http-server 2>&1 | tail -15
```
Expected: both `it(...)` blocks pass. If the new test fails because graphs/mat1/ wasn't picked up, confirm `walk()` is recursing into subdirectories (it already does — `if (e.isDirectory()) await walk(full)`).

- [ ] **Step 6: Commit**
```bash
git add viewer/server/http-server.ts viewer/tests/http-server.test.ts
git commit -m "feat(server): listFiles returns {path,type} per entry"
```

---

## Task 3: Pure `groupFiles()` function + tests

**Files:**
- Create: `viewer/web/src/groupFiles.ts`
- Create: `viewer/tests/group-files.test.ts`

- [ ] **Step 1: Write failing test FIRST**

Create `viewer/tests/group-files.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { groupFiles, type FileEntry } from '../web/src/groupFiles';

const F = (path: string, type: FileEntry['type'] = 'Material'): FileEntry => ({ path, type });

describe('groupFiles', () => {
  it('groups one project folder containing one Material + one MF', () => {
    const result = groupFiles([
      F('obsidian/obsidian.matgraph.json', 'Material'),
      F('obsidian/fresnel_lib.matgraph.json', 'MaterialFunction'),
    ]);
    expect(result.projects).toEqual([
      {
        folder: 'obsidian',
        material: F('obsidian/obsidian.matgraph.json', 'Material'),
        mfs: [F('obsidian/fresnel_lib.matgraph.json', 'MaterialFunction')],
      },
    ]);
    expect(result.unorganized).toEqual([]);
  });

  it('puts root-level files into unorganized', () => {
    const result = groupFiles([
      F('05_fresnel.matgraph.json', 'Material'),
      F('06_custom.matgraph.json', 'Material'),
    ]);
    expect(result.projects).toEqual([]);
    expect(result.unorganized).toEqual([
      F('05_fresnel.matgraph.json', 'Material'),
      F('06_custom.matgraph.json', 'Material'),
    ]);
  });

  it('folder with no Material → unorganized (e.g., legacy graphs/functions/)', () => {
    const result = groupFiles([
      F('functions/blend_normals.matgraph.json', 'MaterialFunction'),
    ]);
    expect(result.projects).toEqual([]);
    expect(result.unorganized).toEqual([
      F('functions/blend_normals.matgraph.json', 'MaterialFunction'),
    ]);
  });

  it('folder with two Materials → unorganized', () => {
    const result = groupFiles([
      F('ambiguous/a.matgraph.json', 'Material'),
      F('ambiguous/b.matgraph.json', 'Material'),
      F('ambiguous/helper.matgraph.json', 'MaterialFunction'),
    ]);
    expect(result.projects).toEqual([]);
    expect(result.unorganized).toEqual([
      F('ambiguous/a.matgraph.json', 'Material'),
      F('ambiguous/b.matgraph.json', 'Material'),
      F('ambiguous/helper.matgraph.json', 'MaterialFunction'),
    ]);
  });

  it('folder with Unknown-typed file → unorganized (cannot validate)', () => {
    const result = groupFiles([
      F('mystery/something.matgraph.json', 'Unknown'),
      F('mystery/m.matgraph.json', 'Material'),
    ]);
    expect(result.projects).toEqual([]);
    expect(result.unorganized.length).toBe(2);
  });

  it('projects sorted alphabetically by folder name', () => {
    const result = groupFiles([
      F('zeta/z.matgraph.json', 'Material'),
      F('alpha/a.matgraph.json', 'Material'),
      F('beta/b.matgraph.json', 'Material'),
    ]);
    expect(result.projects.map(p => p.folder)).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('mfs within a project sorted alphabetically', () => {
    const result = groupFiles([
      F('p/main.matgraph.json', 'Material'),
      F('p/z_helper.matgraph.json', 'MaterialFunction'),
      F('p/a_helper.matgraph.json', 'MaterialFunction'),
    ]);
    expect(result.projects[0].mfs.map(e => e.path)).toEqual([
      'p/a_helper.matgraph.json',
      'p/z_helper.matgraph.json',
    ]);
  });

  it('deeply nested paths use only first segment as folder', () => {
    const result = groupFiles([
      F('proj/sub/deep.matgraph.json', 'Material'),
    ]);
    expect(result.unorganized).toEqual([F('proj/sub/deep.matgraph.json', 'Material')]);
    expect(result.projects).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test, expect ALL to fail with "Cannot find module"**

```bash
pnpm --filter viewer test -- group-files 2>&1 | tail -10
```
Expected: failure because `groupFiles` doesn't exist yet.

- [ ] **Step 3: Implement `viewer/web/src/groupFiles.ts`**

Create the file:

```typescript
export interface FileEntry {
  path: string;
  type: 'Material' | 'MaterialFunction' | 'Unknown';
}

export interface Project {
  folder: string;
  material: FileEntry;
  mfs: FileEntry[];
}

export interface GroupResult {
  projects: Project[];
  unorganized: FileEntry[];
}

export function groupFiles(entries: FileEntry[]): GroupResult {
  const byFolder = new Map<string, FileEntry[]>();
  const rootLevel: FileEntry[] = [];

  for (const e of entries) {
    const segments = e.path.split('/');
    if (segments.length === 1) {
      rootLevel.push(e);
    } else {
      const folder = segments[0];
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder)!.push(e);
    }
  }

  const projects: Project[] = [];
  const unorganized: FileEntry[] = [...rootLevel];

  // Folders sorted alphabetically
  const folderNames = [...byFolder.keys()].sort();
  for (const folder of folderNames) {
    const contents = byFolder.get(folder)!;
    const materials = contents.filter(e => e.type === 'Material');
    const mfs = contents.filter(e => e.type === 'MaterialFunction').sort((a, b) => a.path.localeCompare(b.path));
    const unknowns = contents.filter(e => e.type === 'Unknown');

    // Project validity: exactly one Material, no Unknowns, only-Material+MFs.
    // Also require all contents are top-level (no deeper nesting like proj/sub/x).
    const hasNesting = contents.some(e => e.path.split('/').length > 2);
    if (materials.length === 1 && unknowns.length === 0 && !hasNesting) {
      projects.push({ folder, material: materials[0], mfs });
    } else {
      unorganized.push(...contents);
    }
  }

  return { projects, unorganized };
}
```

- [ ] **Step 4: Run tests, expect ALL to pass**
```bash
pnpm --filter viewer test -- group-files 2>&1 | tail -10
```
Expected: 8 tests pass.

- [ ] **Step 5: Commit**
```bash
git add viewer/web/src/groupFiles.ts viewer/tests/group-files.test.ts
git commit -m "feat(viewer): groupFiles() — flat entries to projects + unorganized"
```

---

## Task 4: Update `store.tsx` to hold `FileEntry[]`

**Files:**
- Modify: `viewer/web/src/store.tsx`

- [ ] **Step 1: Update state and reducer**

Open `viewer/web/src/store.tsx`. Replace the import line:
```typescript
import type { ServerMessage, GraphPayload } from './protocol';
```
with:
```typescript
import type { ServerMessage, GraphPayload, FileEntry } from './protocol';
```

Find the `State` interface and change `files: string[]` to `files: FileEntry[]`:
```typescript
interface State {
  files: FileEntry[];
  currentPath: string | null;
  breadcrumb: string[];
  graphs: Record<string, GraphPayload>;
  errors: Record<string, string[]>;
}
```

Find the `Action` type and change the two file-related actions:
```typescript
type Action =
  | { type: 'hello'; files: FileEntry[] }
  | { type: 'fileList'; files: FileEntry[] }
  | { type: 'graph'; path: string; payload: GraphPayload }
  | { type: 'graphError'; path: string; errors: string[] }
  | { type: 'open'; path: string }
  | { type: 'enterMF'; mfPath: string }
  | { type: 'popBreadcrumb'; toIndex: number };
```

- [ ] **Step 2: Update html-export branch and `useEffect` first-file-open**

In the `useEffect` body, replace:
```typescript
      dispatch({ type: 'hello', files: Object.keys(exportData.files) });
```
with:
```typescript
      const exportEntries: FileEntry[] = Object.entries(exportData.files).map(([path, g]) => {
        const t = (g as { type?: string }).type;
        return {
          path,
          type: t === 'Material' || t === 'MaterialFunction' ? t : 'Unknown',
        };
      });
      dispatch({ type: 'hello', files: exportEntries });
```

In `App.tsx`'s `Body` (NOT touched in this task — we cover it in Task 8) the first-file-open uses `state.files[0]`. We need to update that usage to `.path` later, but for this task only update the type definitions and html-export wiring.

Also update the auto-open useEffect in `App.tsx`. Since this lives in App.tsx but the change is one line, do it here:

Open `viewer/web/src/App.tsx`. Replace:
```typescript
    if (!state.currentPath && state.files.length > 0) {
      open(state.files[0]);
    }
```
with:
```typescript
    if (!state.currentPath && state.files.length > 0) {
      open(state.files[0].path);
    }
```

- [ ] **Step 3: Build to confirm no type errors**
```bash
pnpm --filter viewer build 2>&1 | tail -10
```
Expected: build succeeds (FileList.tsx still iterates `state.files` as if it were strings — it will TypeError. Continue anyway; Task 6 fixes FileList.)

If build fails with errors ONLY in `FileList.tsx`, that is expected — move on. If it fails elsewhere (store.tsx, App.tsx, html-export), fix before committing.

- [ ] **Step 4: Commit (even with FileList broken)**

Since FileList is about to be rewritten, commit the wiring now:
```bash
git add viewer/web/src/store.tsx viewer/web/src/App.tsx
git commit -m "feat(store): files state holds FileEntry[]"
```

---

## Task 5: New `Sidebar.tsx` tab shell + `sidebar.css`

**Files:**
- Create: `viewer/web/src/Sidebar.tsx`
- Create: `viewer/web/src/sidebar.css`

- [ ] **Step 1: Create `viewer/web/src/sidebar.css`**

```css
.sidebar { display: flex; flex-direction: column; height: 100%; background: #1e1e1e; color: #ddd; }

.sidebar-tabs { display: flex; border-bottom: 1px solid #333; }
.sidebar-tab {
  flex: 1; padding: 8px 0; text-align: center; cursor: pointer;
  font-size: 12px; color: #888; background: #1e1e1e;
  border: none; border-bottom: 2px solid transparent;
}
.sidebar-tab.active { color: #ddd; border-bottom-color: #f0c060; }
.sidebar-tab:hover { color: #ddd; }

.sidebar-panel { flex: 1; overflow-y: auto; padding: 8px; }

/* Files tab — tree */
.tree-folder { margin-bottom: 6px; }
.tree-folder-header {
  cursor: pointer; font-size: 11px; color: #aaa; padding: 2px 0;
  user-select: none; text-transform: none;
}
.tree-folder-header:hover { color: #ddd; }
.tree-folder-children { padding-left: 14px; }
.tree-file {
  cursor: pointer; padding: 3px 6px; font-size: 12px;
  border-radius: 2px;
}
.tree-file:hover { background: #2a2a2a; }
.tree-file.active { background: #3a3a3a; color: #f0c060; }
.tree-file-icon { display: inline-block; width: 12px; color: #888; text-align: center; }
.tree-file.material .tree-file-icon { color: #f0c060; }
.tree-file.mf .tree-file-icon { color: #8ab; }
.tree-file.unknown .tree-file-icon { color: #666; }

/* Nodes tab — library */
.lib-search {
  width: 100%; box-sizing: border-box; padding: 6px 8px;
  background: #2a2a2a; color: #ddd; border: 1px solid #444; border-radius: 3px;
  font-size: 12px; margin-bottom: 8px;
}
.lib-cat { margin-bottom: 4px; }
.lib-cat-header {
  cursor: pointer; padding: 4px 0; font-size: 11px; color: #aaa;
  user-select: none;
}
.lib-cat-header:hover { color: #ddd; }
.lib-cat-children { padding-left: 12px; }
.lib-node {
  padding: 3px 6px; font-size: 12px; cursor: pointer; border-radius: 2px;
}
.lib-node:hover { background: #2a2a2a; }
.lib-node-detail {
  background: #181818; border-left: 2px solid #f0c060;
  padding: 6px 8px; margin: 2px 0 4px 6px; font-size: 11px; color: #ccc;
}
.lib-node-detail-desc { font-style: italic; color: #aaa; margin-bottom: 4px; }
.lib-node-detail-section { margin-top: 4px; }
.lib-node-detail-section-title { color: #888; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
.lib-node-detail-pin { font-family: 'Menlo', monospace; font-size: 11px; }
.lib-badge {
  display: inline-block; padding: 1px 5px; border-radius: 2px; font-size: 9px;
  margin-right: 4px; vertical-align: middle;
}
.lib-badge.verified { background: #2d4a2d; color: #8c8; }
.lib-badge.dynamic { background: #4a3a20; color: #f0c060; }
.lib-badge.deprecated { background: #4a2020; color: #f88; }
```

- [ ] **Step 2: Create `viewer/web/src/Sidebar.tsx`**

```tsx
import { useState } from 'react';
import { FileList } from './FileList';
import { NodeLibrary } from './NodeLibrary';
import './sidebar.css';

type Tab = 'files' | 'nodes';

export function Sidebar() {
  const [tab, setTab] = useState<Tab>('files');
  return (
    <div className="sidebar">
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab ${tab === 'files' ? 'active' : ''}`}
          onClick={() => setTab('files')}
        >Files</button>
        <button
          className={`sidebar-tab ${tab === 'nodes' ? 'active' : ''}`}
          onClick={() => setTab('nodes')}
        >Nodes</button>
      </div>
      <div className="sidebar-panel">
        {tab === 'files' ? <FileList /> : <NodeLibrary />}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Build (FileList and NodeLibrary don't exist yet → expect errors in Sidebar.tsx referencing them)**
```bash
pnpm --filter viewer build 2>&1 | tail -10
```
Expected: build fails because `NodeLibrary` doesn't exist yet, and `FileList` has old prop expectations. Acceptable — Tasks 6 + 7 add them.

- [ ] **Step 4: Commit shell + styles**
```bash
git add viewer/web/src/Sidebar.tsx viewer/web/src/sidebar.css
git commit -m "feat(viewer): sidebar shell with Files/Nodes tabs"
```

---

## Task 6: Rewrite `FileList.tsx` as tree

**Files:**
- Modify: `viewer/web/src/FileList.tsx` (rewrite)

- [ ] **Step 1: Replace `FileList.tsx` entirely**

Open `viewer/web/src/FileList.tsx`. Replace ALL contents with:

```tsx
import { useState } from 'react';
import { useStore } from './store';
import { groupFiles, type Project, type FileEntry } from './groupFiles';

function fileClass(type: FileEntry['type']): string {
  if (type === 'Material') return 'material';
  if (type === 'MaterialFunction') return 'mf';
  return 'unknown';
}

function icon(type: FileEntry['type']): string {
  if (type === 'Material') return '●';        // ●
  if (type === 'MaterialFunction') return '·'; // ·
  return '?';                                  // ?
}

function FileRow({ entry }: { entry: FileEntry }) {
  const { state, open } = useStore();
  const active = state.breadcrumb[0] === entry.path;
  const baseName = entry.path.split('/').pop()?.replace(/\.matgraph\.json$/, '') ?? entry.path;
  return (
    <div
      className={`tree-file ${fileClass(entry.type)} ${active ? 'active' : ''}`}
      onClick={() => open(entry.path)}
      title={entry.path}
    >
      <span className="tree-file-icon">{icon(entry.type)}</span> {baseName}
    </div>
  );
}

function ProjectFolder({ project }: { project: Project }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="tree-folder">
      <div className="tree-folder-header" onClick={() => setOpen(!open)}>
        {open ? '▼' : '▶'} {project.folder}/
      </div>
      {open && (
        <div className="tree-folder-children">
          <FileRow entry={project.material} />
          {project.mfs.map(mf => <FileRow key={mf.path} entry={mf} />)}
        </div>
      )}
    </div>
  );
}

function UnorganizedSection({ entries }: { entries: FileEntry[] }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <div className="tree-folder">
      <div className="tree-folder-header" onClick={() => setOpen(!open)}>
        {open ? '▼' : '▶'} Unorganized ({entries.length})
      </div>
      {open && (
        <div className="tree-folder-children">
          {entries.map(e => <FileRow key={e.path} entry={e} />)}
        </div>
      )}
    </div>
  );
}

export function FileList() {
  const { state } = useStore();
  const { projects, unorganized } = groupFiles(state.files);
  return (
    <div>
      {projects.map(p => <ProjectFolder key={p.folder} project={p} />)}
      <UnorganizedSection entries={unorganized} />
      {projects.length === 0 && unorganized.length === 0 && (
        <div style={{ color: '#666', fontSize: 11 }}>No graphs yet. AI writes to graphs/&lt;project&gt;/&lt;name&gt;.matgraph.json</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build (NodeLibrary still missing — expect that one error only)**
```bash
pnpm --filter viewer build 2>&1 | tail -10
```
Expected: only `NodeLibrary` missing now. FileList compiles.

- [ ] **Step 3: Commit**
```bash
git add viewer/web/src/FileList.tsx
git commit -m "feat(viewer): FileList renders project tree + Unorganized"
```

---

## Task 7: `NodeLibrary.tsx` — search + categories + inline detail

**Files:**
- Create: `viewer/web/src/NodeLibrary.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { useMemo, useState } from 'react';
import { DB } from './db';
import type { NodeDef, PinDef, ParamDef } from '../../server/db-types';

interface NodeEntry {
  name: string;
  def: NodeDef;
}

function groupByCategory(entries: NodeEntry[]): Record<string, NodeEntry[]> {
  const out: Record<string, NodeEntry[]> = {};
  for (const e of entries) {
    const cat = e.def.category || 'Uncategorized';
    if (!out[cat]) out[cat] = [];
    out[cat].push(e);
  }
  for (const cat of Object.keys(out)) {
    out[cat].sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

function PinList({ title, pins }: { title: string; pins: PinDef[] }) {
  if (!pins || pins.length === 0) return null;
  return (
    <div className="lib-node-detail-section">
      <div className="lib-node-detail-section-title">{title}</div>
      {pins.map(p => (
        <div key={p.name} className="lib-node-detail-pin">
          {p.name} : {p.type}{p.required ? ' *' : ''}
        </div>
      ))}
    </div>
  );
}

function ParamList({ params }: { params?: ParamDef[] }) {
  if (!params || params.length === 0) return null;
  return (
    <div className="lib-node-detail-section">
      <div className="lib-node-detail-section-title">Params</div>
      {params.map(p => (
        <div key={p.name} className="lib-node-detail-pin">
          {p.name} : {p.type}
          {p.default !== undefined ? ` = ${JSON.stringify(p.default)}` : ''}
          {p.required ? ' *' : ''}
          {p.when ? ` (${p.when})` : ''}
        </div>
      ))}
    </div>
  );
}

function NodeDetail({ def }: { def: NodeDef }) {
  return (
    <div className="lib-node-detail">
      {def.description && <div className="lib-node-detail-desc">{def.description}</div>}
      <div>
        {def.verified && <span className="lib-badge verified">verified</span>}
        {def.dynamicPins && <span className="lib-badge dynamic">dynamic</span>}
        {def.deprecated && <span className="lib-badge deprecated">deprecated</span>}
      </div>
      <PinList title="Inputs" pins={def.inputs} />
      <PinList title="Outputs" pins={def.outputs} />
      <ParamList params={def.params} />
      {def.dynamicPins && def.pinInfo && (
        <div className="lib-node-detail-section">
          <div className="lib-node-detail-section-title">Pin rule</div>
          <div style={{ fontStyle: 'italic', color: '#aaa' }}>{def.pinInfo}</div>
        </div>
      )}
    </div>
  );
}

function CategoryBlock({
  category, entries, expandedAll, expanded, onToggle, openNode, setOpenNode,
}: {
  category: string;
  entries: NodeEntry[];
  expandedAll: boolean;
  expanded: boolean;
  onToggle: () => void;
  openNode: string | null;
  setOpenNode: (name: string | null) => void;
}) {
  const showChildren = expandedAll || expanded;
  return (
    <div className="lib-cat">
      <div className="lib-cat-header" onClick={onToggle}>
        {showChildren ? '▼' : '▶'} {category} ({entries.length})
      </div>
      {showChildren && (
        <div className="lib-cat-children">
          {entries.map(e => (
            <div key={e.name}>
              <div
                className="lib-node"
                onClick={() => setOpenNode(openNode === e.name ? null : e.name)}
              >{e.name}</div>
              {openNode === e.name && <NodeDetail def={e.def} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function NodeLibrary() {
  const [query, setQuery] = useState('');
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const [openNode, setOpenNode] = useState<string | null>(null);

  const allEntries: NodeEntry[] = useMemo(
    () => Object.entries(DB.nodes).map(([name, def]) => ({ name, def })),
    []
  );

  const q = query.trim().toLowerCase();
  const filtered = q
    ? allEntries.filter(e =>
        e.name.toLowerCase().includes(q) ||
        (e.def.description || '').toLowerCase().includes(q)
      )
    : allEntries;

  const grouped = useMemo(() => groupByCategory(filtered), [filtered]);
  const categories = Object.keys(grouped).sort();
  const expandAll = q.length > 0;

  return (
    <div>
      <input
        className="lib-search"
        type="text"
        placeholder="Search nodes (name + description)"
        value={query}
        onChange={e => setQuery(e.target.value)}
      />
      {categories.length === 0 && (
        <div style={{ color: '#666', fontSize: 11, padding: 8 }}>No matches for "{query}"</div>
      )}
      {categories.map(cat => (
        <CategoryBlock
          key={cat}
          category={cat}
          entries={grouped[cat]}
          expandedAll={expandAll}
          expanded={expandedCats.has(cat)}
          onToggle={() => {
            const s = new Set(expandedCats);
            if (s.has(cat)) s.delete(cat); else s.add(cat);
            setExpandedCats(s);
          }}
          openNode={openNode}
          setOpenNode={setOpenNode}
        />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Build**
```bash
pnpm --filter viewer build 2>&1 | tail -10
```
Expected: build succeeds.

- [ ] **Step 3: Commit**
```bash
git add viewer/web/src/NodeLibrary.tsx
git commit -m "feat(viewer): NodeLibrary tab — search + categories + inline detail"
```

---

## Task 8: Wire Sidebar into App

**Files:**
- Modify: `viewer/web/src/App.tsx`

- [ ] **Step 1: Replace FileList mount with Sidebar**

Open `viewer/web/src/App.tsx`. Replace the import:
```typescript
import { FileList } from './FileList';
```
with:
```typescript
import { Sidebar } from './Sidebar';
```

Find this JSX line:
```typescript
        <div style={{ width: 220 }}><FileList /></div>
```
Replace with:
```typescript
        <div style={{ width: 240 }}><Sidebar /></div>
```

(220 → 240 because the tab strip needs a bit more horizontal room for two labels.)

- [ ] **Step 2: Build + run all tests**
```bash
pnpm -r build 2>&1 | tail -10 && echo "---TESTS---" && pnpm -r test 2>&1 | tail -10
```
Expected: build clean. All tests pass (27 prior + 8 new groupFiles + 1 new http-server test = 36 total).

- [ ] **Step 3: Commit**
```bash
git add viewer/web/src/App.tsx
git commit -m "feat(viewer): mount Sidebar in App"
```

---

## Task 9: Update agent-pack docs for new convention

**Files:**
- Modify: `agent-pack/SPEC.md`
- Modify: `agent-pack/CLAUDE.md`
- Modify: `agent-pack/AGENTS.md`
- Modify: `agent-pack/GEMINI.md`

- [ ] **Step 1: Update `agent-pack/SPEC.md` §"Where to write"**

Replace lines 5-8 (current content):
```markdown
## Where to write

- `Material` files → `graphs/<name>.matgraph.json`
- `MaterialFunction` files → `graphs/functions/<name>.matgraph.json`
```

with:
```markdown
## Where to write

**One project = one folder under `graphs/`.** Each project folder contains exactly one Material and any MaterialFunctions that material references.

- `Material` file → `graphs/<project>/<material_name>.matgraph.json`
- `MaterialFunction` file → `graphs/<project>/<mf_name>.matgraph.json` (same folder as the Material that uses it)

By convention, the folder name matches the material name. If the user already named a project, use that.

Do **not** share MaterialFunctions across projects — copy them into each project that needs them. The viewer only recognizes a folder as a "project" if it contains exactly one Material; otherwise its contents appear under "Unorganized".
```

- [ ] **Step 2: Update `agent-pack/SPEC.md` §"Hard rules" item 7**

Replace lines 50-53 (current content):
```markdown
7. **`MaterialFunctionCall.params.MaterialFunction`** is a path relative to the **current file's directory** (not always `graphs/` root).
   - From a `Material` at `graphs/foo.matgraph.json` → `"./functions/blend_normals.matgraph.json"` resolves to `graphs/functions/blend_normals.matgraph.json`.
   - From a `MaterialFunction` at `graphs/functions/a.matgraph.json` → `"./b.matgraph.json"` resolves to `graphs/functions/b.matgraph.json` (sibling file).
   - Most projects keep all MFs in `graphs/functions/`, so MFs that call sibling MFs use `"./<name>.matgraph.json"`.
```

with:
```markdown
7. **`MaterialFunctionCall.params.MaterialFunction`** is a path relative to the **current file's directory** (not the `graphs/` root).
   - With the project-folder convention, the Material and its MFs are siblings in the same folder, so the path is just `"./<mf_name>.matgraph.json"`.
   - Example: from `graphs/obsidian/obsidian.matgraph.json` → `"./fresnel_lib.matgraph.json"` resolves to `graphs/obsidian/fresnel_lib.matgraph.json`.
   - MFs that call sibling MFs use the same `"./<name>.matgraph.json"` form.
```

- [ ] **Step 3: Update `agent-pack/CLAUDE.md`**

Replace the entire file content with:

```markdown
# UE Material Workflow

When asked to design or modify a UE5 material, follow the spec:

@SPEC.md
@nodes-ue5.7.json

Examples: @examples/01_basic_pbr.matgraph.json, @examples/02_with_function.matgraph.json

Write output to `graphs/<project>/`: one folder per project, containing the Material and any MaterialFunctions it uses. By convention the folder name matches the material name.
```

- [ ] **Step 4: Update `agent-pack/AGENTS.md`**

Replace the entire file content with:

```markdown
# UE Material Workflow

For UE5 material work: read `agent-pack/SPEC.md` and `agent-pack/nodes-ue5.7.json` before writing any `.matgraph.json` file.

Output location: `graphs/<project>/`. Each project folder contains one Material and any MaterialFunctions it references. By convention the folder name matches the material name.

Examples in `agent-pack/examples/`.
```

- [ ] **Step 5: Update `agent-pack/GEMINI.md`**

Replace the entire file content with:

```markdown
# UE Material Workflow

For UE5 material tasks: read `agent-pack/SPEC.md` and `agent-pack/nodes-ue5.7.json` first. Write `.matgraph.json` files to `graphs/<project>/` per the spec (one folder per project: Material + its MFs).
```

- [ ] **Step 6: Commit docs**
```bash
git add agent-pack/SPEC.md agent-pack/CLAUDE.md agent-pack/AGENTS.md agent-pack/GEMINI.md
git commit -m "docs(agent-pack): project-folder convention for material output"
```

---

## Task 10: Smoke test — manual verification

**Files:** none (manual verification)

- [ ] **Step 1: Create a smoke-test project on disk**

```bash
mkdir -p graphs/smoke_test
```

Create `graphs/smoke_test/smoke_test.matgraph.json`:
```json
{
  "schemaVersion": "1.0",
  "ueVersion": "5.7",
  "type": "Material",
  "name": "smoke_test",
  "description": "Sidebar grouping smoke test.",
  "nodes": [
    { "id": "OUT", "type": "MaterialOutput" },
    { "id": "c", "type": "Constant3Vector", "params": { "Value": [0.5, 0.5, 0.5] } }
  ],
  "connections": [
    { "from": "c:RGB", "to": "OUT:BaseColor" }
  ]
}
```

Create `graphs/smoke_test/helper.matgraph.json`:
```json
{
  "schemaVersion": "1.0",
  "ueVersion": "5.7",
  "type": "MaterialFunction",
  "name": "helper",
  "description": "Demo MF (not referenced — exists to verify sidebar shows it nested under smoke_test).",
  "nodes": [
    { "id": "IN", "type": "FunctionInput", "params": { "InputName": "X" } },
    { "id": "OUT", "type": "FunctionOutput", "params": { "OutputName": "Result" } }
  ],
  "connections": [
    { "from": "IN:Input", "to": "OUT:Input" }
  ]
}
```

(Note: these files are gitignored per `.gitignore` `graphs/**/*.matgraph.json`. They will not pollute the repo.)

- [ ] **Step 2: Start the viewer in background and open in browser**

```bash
pnpm start
```

Then visit `http://localhost:5790` (or whichever port the server reports).

- [ ] **Step 3: Visual checklist (write what you observe)**

Confirm in the browser:
1. Sidebar has `[Files] [Nodes]` tabs at the top. ✅ / ❌
2. Files tab shows `▼ smoke_test/` with `smoke_test` (Material, ●) and `helper` (MF, ·) nested. ✅ / ❌
3. The two pre-existing legacy files (`05_fresnel_glow`, `06_fresnel_custom`) appear under `▶ Unorganized (N)`. Click to expand and verify. ✅ / ❌
4. Click Nodes tab → search box visible, categories listed (collapsed). ✅ / ❌
5. Type "Multiply" → only matching category(ies) expand, Multiply visible. ✅ / ❌
6. Click on `Multiply` row → inline detail shows inputs `A : Float1...`, outputs `Result : ...`. ✅ / ❌
7. Find a node with `dynamicPins: true` (e.g., `LandscapeLayerBlend`) → detail shows `dynamic` badge + pin rule text. ✅ / ❌

- [ ] **Step 4: Clean up smoke-test files**
```bash
rm -rf graphs/smoke_test
```

- [ ] **Step 5: If issues found, file as new tasks; otherwise mark plan complete**

No additional commit required — smoke test is verification only.

---

## Done criteria

- All 10 tasks complete
- `pnpm -r build` clean
- `pnpm -r test` shows ≥36 tests passing (27 prior + 8 new groupFiles + 1 new http-server test)
- Visual checklist (Task 10 Step 3) all green
- Spec doc and plan doc both committed

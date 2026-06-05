# Comments + Large-Graph Gate Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the comment-box double-frame behavior with a nested ownership model that also exports faithfully to UE, and stop large graphs freezing the UI with a node-count-based confirm-before-open gate.

**Architecture:** A new pure module `commentBounds.ts` derives, from each comment's `contains` membership, (a) per-node ownership = smallest containing comment, (b) nesting via `contains ⊆`, (c) hierarchical bounding rects (child boxes feed parent boxes). `Graph.tsx` (render) and `ueT3D.ts` (export) both consume it, so rendered == exported geometry. Sibling overlap (incomparable comments sharing a node) is surfaced as a diagnostics warning. Separately, `FileEntry` gains `nodeCount`, computed server-side, and the open path confirms before opening graphs over a threshold.

**Tech Stack:** TypeScript, React + ReactFlow, vitest. Server = native Node http+ws. Run tests via `viewer/node_modules/.bin/vitest run` (pnpm is not on PATH; see memory).

**Branch:** `feat/viewer-workflow-enhancements`.

---

## File Structure

| File | Responsibility |
|---|---|
| `viewer/web/src/commentBounds.ts` (new) | Pure: ownership, nesting, hierarchical bounds, sibling-overlap detection |
| `viewer/tests/comment-bounds.test.ts` (new) | Unit tests for the above |
| `viewer/web/src/Graph.tsx` (modify) | `commentNodes` useMemo consumes `computeCommentBounds`; edge build O(E×N)→Map |
| `viewer/web/src/export/ueT3D.ts` (modify) | Comment T3D bounds consume `computeCommentBounds` |
| `viewer/web/src/graphDiagnostics.ts` (modify) | Add `comment-overlap` warning kind |
| `viewer/tests/graph-diagnostics.test.ts` (modify) | Test the overlap warning |
| `viewer/server/ws-protocol.ts` + `viewer/web/src/protocol.ts` (modify) | `FileEntry.nodeCount?: number` (mirror) |
| `viewer/server/http-server.ts` (modify) | `listFiles` populates `nodeCount` |
| `viewer/web/src/FileList.tsx` (modify) | Show count; confirm-before-open over threshold |
| `viewer/web/src/App.tsx` (modify) | Gate startup auto-open by threshold |

---

## Phase A — #5 Nested comment boxes

### Task A1: `commentBounds.ts` — types + ownership + nesting + bounds + overlap

**Files:**
- Create: `viewer/web/src/commentBounds.ts`
- Test: `viewer/tests/comment-bounds.test.ts`

Interface:
```ts
export interface Rect { x: number; y: number; width: number; height: number }
export interface CommentInput { id: string; contains: string[] }
export interface BoundsOpts { padX?: number; padTop?: number; padBottom?: number }

// commentId -> rect, omitting comments with no resolvable members
export function computeCommentBounds(
  comments: CommentInput[],
  nodeRect: (id: string) => Rect | undefined,
  opts?: BoundsOpts,
): Map<string, Rect>

// node id -> owning comment id (smallest containing comment; tie: lexicographically smallest comment id)
export function commentOwnership(comments: CommentInput[]): Map<string, string>

// nodes that sit in >=2 mutually-incomparable comments (true sibling overlap, not nesting)
export function commentOverlaps(comments: CommentInput[]): { nodeId: string; commentIds: string[] }[]
```

Algorithm notes (for the implementer):
- `size(c) = c.contains.length`. Owner of node n = the comment containing n with the smallest `size` (tie → smallest `id`).
- `parentOf(c)` = the comment `p` with `c.contains ⊊ p.contains` and the smallest `size(p)` (tie → smallest id); none → root.
- `directNodes(c)` = nodes whose owner is `c`.
- `bounds(c)` = hull of `{ nodeRect(n) : n ∈ directNodes(c) }` ∪ `{ bounds(child) : parentOf(child)=c }`, then pad (`padX=32, padTop=36, padBottom=24` to match current). Compute in ascending `size` order so children precede parents. Skip nodes with no `nodeRect`. A comment with an empty hull is omitted from the map.
- `commentOverlaps`: for each node, gather containing comments; if ≥2 and they are NOT totally ordered by ⊆ (i.e. some pair is incomparable), emit `{nodeId, commentIds}` once.

- [ ] **Step 1: Write failing tests** in `viewer/tests/comment-bounds.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeCommentBounds, commentOwnership, commentOverlaps } from '../web/src/commentBounds';

// 100x40 node boxes on a grid; absent ids return undefined
const rect = (positions: Record<string, [number, number]>) => (id: string) =>
  positions[id] ? { x: positions[id][0], y: positions[id][1], width: 100, height: 40 } : undefined;

describe('commentBounds', () => {
  it('flat disjoint comments: each box hulls its own nodes', () => {
    const comments = [{ id: 'A', contains: ['n1', 'n2'] }];
    const b = computeCommentBounds(comments, rect({ n1: [0, 0], n2: [200, 0] }), { padX: 0, padTop: 0, padBottom: 0 });
    expect(b.get('A')).toEqual({ x: 0, y: 0, width: 300, height: 40 });
  });

  it('nested: parent rect encloses child rect (and its node)', () => {
    // B (small) nested in A; shared node n1 in both
    const comments = [{ id: 'A', contains: ['n1', 'n2'] }, { id: 'B', contains: ['n1'] }];
    const pos = rect({ n1: [0, 0], n2: [500, 0] });
    const b = computeCommentBounds(comments, pos, { padX: 0, padTop: 0, padBottom: 0 });
    const A = b.get('A')!, B = b.get('B')!;
    expect(B).toEqual({ x: 0, y: 0, width: 100, height: 40 });      // owns n1
    // A owns n2 and wraps B's box -> spans n1..n2
    expect(A.x).toBe(0); expect(A.x + A.width).toBe(600);
  });

  it('sibling overlap: shared node owned by smaller box; larger excludes it; overlap reported', () => {
    const comments = [{ id: 'big', contains: ['n1', 'n2', 'shared'] }, { id: 'small', contains: ['shared'] }];
    // not nesting: 'small' ⊊ 'big' IS a subset here -> that's nesting, so craft a true sibling case:
    const sib = [{ id: 'X', contains: ['a', 'shared'] }, { id: 'Y', contains: ['b', 'shared'] }];
    const pos = rect({ a: [0, 0], b: [400, 0], shared: [800, 0] });
    const b = computeCommentBounds(sib, pos, { padX: 0, padTop: 0, padBottom: 0 });
    const owner = commentOwnership(sib);
    // tie on size(2,2) -> smaller id 'X' owns 'shared'
    expect(owner.get('shared')).toBe('X');
    const Y = b.get('Y')!; // Y owns only 'b' -> excludes 'shared'
    expect(Y).toEqual({ x: 400, y: 0, width: 100, height: 40 });
    expect(commentOverlaps(sib)).toEqual([{ nodeId: 'shared', commentIds: ['X', 'Y'] }]);
  });

  it('drag locality: moving an owned node changes its box (+ ancestors) but not an unrelated sibling', () => {
    const comments = [{ id: 'A', contains: ['n1'] }, { id: 'C', contains: ['n3'] }];
    const before = computeCommentBounds(comments, rect({ n1: [0, 0], n3: [500, 0] }), { padX: 0, padTop: 0, padBottom: 0 });
    const after = computeCommentBounds(comments, rect({ n1: [0, 100], n3: [500, 0] }), { padX: 0, padTop: 0, padBottom: 0 });
    expect(after.get('C')).toEqual(before.get('C'));   // sibling unaffected
    expect(after.get('A')).not.toEqual(before.get('A')); // owner moved
  });

  it('nested overlap is NOT flagged as sibling overlap', () => {
    expect(commentOverlaps([{ id: 'A', contains: ['n1', 'n2'] }, { id: 'B', contains: ['n1'] }])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `viewer/node_modules/.bin/vitest run comment-bounds` → module not found / assertions fail.
- [ ] **Step 3: Implement `commentBounds.ts`** per the algorithm notes above (pure, no React/DOM imports).
- [ ] **Step 4: Run, expect PASS** — `viewer/node_modules/.bin/vitest run comment-bounds`.
- [ ] **Step 5: Commit** — `git add viewer/web/src/commentBounds.ts viewer/tests/comment-bounds.test.ts && git commit -m "feat(viewer): nested comment ownership + hierarchical bounds module"` (+ Co-Authored-By trailer).

### Task A2: Graph.tsx uses computeCommentBounds

**Files:** Modify `viewer/web/src/Graph.tsx` (`commentNodes` useMemo, currently ~263-325).

- [ ] **Step 1:** Read the current `commentNodes` useMemo. Replace the per-comment hull loop with: build `nodeRect(id)` from the live `nodes` Map (`{x: n.position.x, y: n.position.y, width: computeNodeWidth(n.data), height: computeNodeHeight(n.data)}`), call `computeCommentBounds(graph.comments, nodeRect)`, and map each returned rect to a `commentBox` Node (same shape/zIndex/draggable:false as today). Keep the `initialLayout.clusterBounds` fallback only if a comment has no computed rect.
- [ ] **Step 2:** Manual sanity — `viewer/node_modules/.bin/vitest run` (existing layout tests stay green) + build (Task C-build below). No new unit test here (covered by A1 + manual canvas check during /run).
- [ ] **Step 3: Commit** — `git commit -am "feat(viewer): render comment boxes via shared nested-bounds"`.

### Task A3: ueT3D export uses computeCommentBounds

**Files:** Modify `viewer/web/src/export/ueT3D.ts` (comment bounds for T3D emission, ~638-674 per investigation).

- [ ] **Step 1: Write/extend a round-trip test** asserting that for a nested comment graph, the exported comment T3D rectangles satisfy: outer rect encloses inner rect (compare emitted sizes/positions). Add to the existing `viewer/tests/ueT3D.test.ts`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3:** Replace the export's own bounds math with `computeCommentBounds` (same `nodeRect` from the export's node-position source). Ensure padding matches what UE expects (keep current export padding constants if they differ from render — parametrize via `BoundsOpts`).
- [ ] **Step 4: Run, expect PASS** + existing ueT3D tests green.
- [ ] **Step 5: Commit** — `git commit -am "feat(viewer): export comment boxes via shared nested-bounds (UE round-trip)"`.

### Task A4: sibling-overlap diagnostics warning

**Files:** Modify `viewer/web/src/graphDiagnostics.ts` (add `'comment-overlap'` to `GraphIssueKind`; after the existing checks, call `commentOverlaps(graph.comments ?? [])` and push one warning per result, no `nodeId` since it spans multiple). Modify `viewer/tests/graph-diagnostics.test.ts`.

- [ ] **Step 1: Write failing test** — a graph with a sibling-overlap comment pair yields a `warning` whose message matches `/重疊|overlap/` and kind `'comment-overlap'`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the check in `diagnoseGraph` (reuse `commentOverlaps`).
- [ ] **Step 4: Run, expect PASS** (all graph-diagnostics tests).
- [ ] **Step 5: Commit** — `git commit -am "feat(viewer): warn on sibling-overlapping comment membership"`.

---

## Phase B — #4 Large-graph confirm gate

### Task B1: `FileEntry.nodeCount` on the wire + server populates it

**Files:** Modify `viewer/server/ws-protocol.ts` + `viewer/web/src/protocol.ts` (add `nodeCount?: number` to `FileEntry`, mirror). Modify `viewer/server/http-server.ts` `listFiles` (~361-378) + the per-file read (`readGraphType` ~350-358 → return `{type, nodeCount}` by also reading `Array.isArray(g.nodes) ? g.nodes.length : undefined`). Modify `viewer/tests/http-server.test.ts`.

- [ ] **Step 1: Write failing test** — the WS `hello`/`fileList` `FileEntry` for a known fixture includes `nodeCount` equal to its node array length (e.g. `stress_common` = 47).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** — extend the file read to also return node count; populate `FileEntry.nodeCount`.
- [ ] **Step 4: Run, expect PASS** (and existing http-server tests — update the FileEntry-shape assertions to allow the new optional field).
- [ ] **Step 5: Commit** — `git commit -am "feat(viewer): surface per-file nodeCount in the file list"`.

### Task B2: confirm-before-open gate + gated auto-open + edge-build fix

**Files:** Modify `viewer/web/src/FileList.tsx` (FileRow ~24-42: show `nodeCount`; on click, if `nodeCount && nodeCount > LARGE_GRAPH_THRESHOLD` → `window.confirm` the zh-TW message before `open(path)`). Add `export const LARGE_GRAPH_THRESHOLD = 300` (in FileList or a small constants module). Modify `viewer/web/src/App.tsx` (the startup auto-open effect ~22-24: skip auto-open when `files[0].nodeCount > LARGE_GRAPH_THRESHOLD`). Modify `viewer/web/src/Graph.tsx` (rfEdges loop ~203-211: build `Map<id, type>` once instead of `.find` per edge).

- [ ] **Step 1: Write failing test** — extract a pure `shouldConfirmOpen(nodeCount: number | undefined, threshold = LARGE_GRAPH_THRESHOLD): boolean` and test: `undefined→false`, `47→false`, `685→true`. (Put it in FileList or a helper; test in `viewer/tests/`.)
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `shouldConfirmOpen`; wire FileRow click + auto-open through it (`window.confirm` in the UI path); replace the edge `.find` with a Map.
- [ ] **Step 4: Run, expect PASS** + build.
- [ ] **Step 5: Commit** — `git commit -am "feat(viewer): confirm before opening large graphs; faster edge build"`.

---

## Build/verify checkpoint (run after each phase)

- `viewer/node_modules/.bin/vitest run` (expect all green, was 237 + new)
- Server tsc: `(cd viewer && node_modules/.bin/tsc -p tsconfig.json)`
- Web tsc+build: `(cd viewer/web && node_modules/.bin/tsc -b && node_modules/.bin/vite build)`
- Manual canvas check via the `run` skill: open `stress_common` (nested/overlap comments behave; dragging a shared node doesn't move unrelated boxes) and confirm the large-graph gate fires on `stress_all_nodes`.

---

## Self-Review

- **Spec coverage:** #5 → A1-A4 (ownership/nesting/bounds, render, export round-trip, overlap warning). #4 → B1-B2 (nodeCount, gate, auto-open gate, edge-map). ✓
- **Placeholder scan:** none — test code is concrete; implementation steps reference exact files/line ranges + the algorithm spec in A1.
- **Type consistency:** `computeCommentBounds`/`commentOwnership`/`commentOverlaps`/`Rect`/`CommentInput`/`BoundsOpts` used consistently A1→A2/A3/A4; `LARGE_GRAPH_THRESHOLD`/`shouldConfirmOpen` consistent B1→B2; `FileEntry.nodeCount` mirrored both protocol files.
- **Open exec detail:** the exact `nodeRect` source in A2/A3 and the `window.confirm` vs modal choice in B2 are resolved at execution by reading the file first (window.confirm is the chosen minimal; a modal is deferred to the #6 redesign).

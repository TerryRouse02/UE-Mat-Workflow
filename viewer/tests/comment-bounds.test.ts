import { describe, it, expect } from 'vitest';
import { computeCommentBounds, commentOwnership, commentOverlaps, buildCommentNodes } from '../web/src/commentBounds';

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

describe('buildCommentNodes', () => {
  const rect = (positions: Record<string, [number, number]>) => (id: string) =>
    positions[id] ? { x: positions[id][0], y: positions[id][1], width: 100, height: 40 } : undefined;

  // Regression guard: comment boxes vanished after an agent patch_graph (until a
  // node drag or page refresh) because React Flow hides any controlled node whose
  // internals lack width/height, and comment nodes — derived, never flowing through
  // onNodesChange — lost their measured size on every `nodes` array churn. The fix
  // is explicit TOP-LEVEL width/height on each comment node.
  it('emits comment nodes with positive top-level width/height (not only in data)', () => {
    const out = buildCommentNodes(
      [{ id: 'A', text: 'Group', color: '#5588cc', contains: ['n1', 'n2'] }],
      rect({ n1: [0, 0], n2: [200, 0] }),
      {},
    );
    expect(out).toHaveLength(1);
    const node = out[0];
    expect(node.id).toBe('comment-A');
    expect(node.width).toBeGreaterThan(0);
    expect(node.height).toBeGreaterThan(0);
    // The size must be mirrored at the node top level AND in data (the renderer uses data).
    expect(node.width).toBe(node.data.width);
    expect(node.height).toBe(node.data.height);
  });

  it('falls back to dagre cluster bounds (keyed comment-<id>) when no live rect resolves', () => {
    const out = buildCommentNodes(
      [{ id: 'A', text: 'Group', contains: ['missing'] }],
      () => undefined, // no node rects available yet
      { 'comment-A': { x: 5, y: 6, width: 120, height: 80 } },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'comment-A', position: { x: 5, y: 6 }, width: 120, height: 80 });
  });

  it('drops a comment with neither a computed bound nor a fallback', () => {
    const out = buildCommentNodes(
      [{ id: 'A', text: 'Group', contains: ['missing'] }],
      () => undefined,
      {},
    );
    expect(out).toEqual([]);
  });

  it('defaults a missing colour to #888', () => {
    const out = buildCommentNodes(
      [{ id: 'A', text: 'G', contains: ['n1'] }],
      rect({ n1: [0, 0] }),
      {},
    );
    expect(out[0].data.color).toBe('#888');
  });
});

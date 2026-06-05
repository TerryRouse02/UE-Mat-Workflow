// Pure module: no React/DOM/node: imports.
// Derives nested comment ownership, hierarchical bounding rects, and sibling-overlap detection.

export interface Rect { x: number; y: number; width: number; height: number }
export interface CommentInput { id: string; contains: string[] }
export interface BoundsOpts { padX?: number; padTop?: number; padBottom?: number }

const DEFAULT_PAD_X = 32;
const DEFAULT_PAD_TOP = 36;
const DEFAULT_PAD_BOTTOM = 24;

/**
 * For each node, determine which comment owns it.
 * Owner = comment containing the node with the smallest `size` (contains.length).
 * Tie-break: lexicographically smallest comment id.
 */
export function commentOwnership(comments: CommentInput[]): Map<string, string> {
  const ownership = new Map<string, string>();

  for (const nodeId of allContainedNodes(comments)) {
    let bestComment: CommentInput | undefined;
    for (const c of comments) {
      if (!c.contains.includes(nodeId)) continue;
      if (!bestComment) {
        bestComment = c;
      } else {
        const cSize = c.contains.length;
        const bSize = bestComment.contains.length;
        if (cSize < bSize || (cSize === bSize && c.id < bestComment.id)) {
          bestComment = c;
        }
      }
    }
    if (bestComment) {
      ownership.set(nodeId, bestComment.id);
    }
  }

  return ownership;
}

/**
 * Returns nodes that appear in two or more mutually-incomparable comments
 * (true sibling overlap — not nesting).
 * Two comments are comparable if one's `contains` is a subset of the other's.
 */
export function commentOverlaps(comments: CommentInput[]): { nodeId: string; commentIds: string[] }[] {
  const results: { nodeId: string; commentIds: string[] }[] = [];

  for (const nodeId of allContainedNodes(comments)) {
    const containing = comments.filter(c => c.contains.includes(nodeId));
    if (containing.length < 2) continue;

    // Check if all pairs are comparable (one is a subset of the other).
    // If any pair is incomparable, we have a sibling overlap.
    let hasIncomparablePair = false;
    for (let i = 0; i < containing.length && !hasIncomparablePair; i++) {
      for (let j = i + 1; j < containing.length && !hasIncomparablePair; j++) {
        const a = containing[i];
        const b = containing[j];
        const aSubB = a.contains.every(n => b.contains.includes(n));
        const bSubA = b.contains.every(n => a.contains.includes(n));
        if (!aSubB && !bSubA) {
          hasIncomparablePair = true;
        }
      }
    }

    if (hasIncomparablePair) {
      const commentIds = containing.map(c => c.id).sort();
      results.push({ nodeId, commentIds });
    }
  }

  // Sort results by nodeId for stable output
  results.sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0);
  return results;
}

/**
 * Compute hierarchical bounding rects for each comment.
 * - Each comment's rect is the hull of its directly-owned nodes' rects PLUS
 *   the rects of its direct child comments.
 * - Padding: padX applied to left/right, padTop to top, padBottom to bottom.
 * - Comments with no resolvable members are omitted from the result.
 */
export function computeCommentBounds(
  comments: CommentInput[],
  nodeRect: (id: string) => Rect | undefined,
  opts?: BoundsOpts,
): Map<string, Rect> {
  const padX = opts?.padX ?? DEFAULT_PAD_X;
  const padTop = opts?.padTop ?? DEFAULT_PAD_TOP;
  const padBottom = opts?.padBottom ?? DEFAULT_PAD_BOTTOM;

  const ownership = commentOwnership(comments);
  const result = new Map<string, Rect>();

  // Process comments in ascending size order so children are computed before parents.
  const sorted = [...comments].sort((a, b) => {
    if (a.contains.length !== b.contains.length) return a.contains.length - b.contains.length;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  for (const comment of sorted) {
    // Gather rects for directly-owned nodes
    const rects: Rect[] = [];
    for (const nodeId of comment.contains) {
      if (ownership.get(nodeId) !== comment.id) continue;
      const r = nodeRect(nodeId);
      if (r) rects.push(r);
    }

    // Gather rects of direct child comments (whose parentOf = this comment)
    for (const child of sorted) {
      if (child.id === comment.id) continue;
      if (!isStrictSubset(child.contains, comment.contains)) continue;
      // Check that there's no smaller parent in between
      const directParent = findParent(child, sorted);
      if (directParent?.id !== comment.id) continue;
      const childRect = result.get(child.id);
      if (childRect) rects.push(childRect);
    }

    if (rects.length === 0) continue;

    const minX = Math.min(...rects.map(r => r.x));
    const minY = Math.min(...rects.map(r => r.y));
    const maxX = Math.max(...rects.map(r => r.x + r.width));
    const maxY = Math.max(...rects.map(r => r.y + r.height));

    result.set(comment.id, {
      x: minX - padX,
      y: minY - padTop,
      width: (maxX - minX) + padX * 2,
      height: (maxY - minY) + padTop + padBottom,
    });
  }

  return result;
}

// --- Helpers ---

function allContainedNodes(comments: CommentInput[]): Set<string> {
  const nodes = new Set<string>();
  for (const c of comments) {
    for (const n of c.contains) nodes.add(n);
  }
  return nodes;
}

/** Returns true if `a.contains` ⊊ `b.contains` (strict subset). */
function isStrictSubset(a: string[], b: string[]): boolean {
  if (a.length >= b.length) return false;
  return a.every(n => b.includes(n));
}

/**
 * parentOf(c) = the comment p with c.contains ⊊ p.contains and the smallest size(p)
 * (tie → smallest id); none → undefined (root).
 */
function findParent(child: CommentInput, all: CommentInput[]): CommentInput | undefined {
  let best: CommentInput | undefined;
  for (const candidate of all) {
    if (candidate.id === child.id) continue;
    if (!isStrictSubset(child.contains, candidate.contains)) continue;
    if (!best) {
      best = candidate;
    } else {
      const cSize = candidate.contains.length;
      const bSize = best.contains.length;
      if (cSize < bSize || (cSize === bSize && candidate.id < best.id)) {
        best = candidate;
      }
    }
  }
  return best;
}

import type { MatGraph, DerivedPins } from './protocol';
import type { NodeDB } from '../../server/db-types';
import { validateConnectionPins } from './validate';
import { commentOverlaps } from './commentBounds';
import i18n from './i18n';

export type GraphIssueKind =
  | 'missing-output'
  | 'extra-output'
  | 'mf-no-input'
  | 'mf-no-output'
  | 'unknown-type'
  | 'bad-pin'
  | 'unresolved-mf'
  | 'comment-overlap';

export interface GraphIssue {
  severity: 'error' | 'warning';
  /** Set for issues produced by diagnoseGraph; omitted for ad-hoc errors (e.g. schema load failures). */
  kind?: GraphIssueKind;
  message: string;
  nodeId?: string;   // when set, the Inspector can focus this node on click
}

/** A node type that is neither in the DB nor a reserved built-in — Export can't map it. */
export function isUnknownNodeType(type: string, db: NodeDB, reserved: Set<string>): boolean {
  return !db.nodes[type] && !reserved.has(type);
}

/** A MaterialFunctionCall whose pins never resolved (MF missing, or its index not crawled). */
export function mfPinsUnresolved(dp: DerivedPins | undefined): boolean {
  return !dp || (dp.inputs.length === 0 && dp.outputs.length === 0);
}

// Health check for a loaded graph, computed entirely client-side from the same data
// the canvas already has (graph + node DB + resolved MF pins). Drives the Inspector's
// "what's wrong / what's missing" panel; each node-tied issue is clickable-to-focus.
//
// The Material MaterialOutput-count rule mirrors the server's materialStructureWarnings
// (viewer/server/schema.ts) INCLUDING its severity: the server deliberately treats it as a
// WARNING (so the canvas is never blanked), so we match that here — otherwise the same
// problem would show as a "warning" in the canvas topbar but an "error" in this panel.
// The MaterialFunction FunctionInput/FunctionOutput rules are client-only (SPEC rule 7);
// the server does not validate MaterialFunction structure, so this panel is intentionally
// the richer view there. Missing FunctionOutput is a hard error because an MF with no output
// is useless; missing FunctionInput is valid for parameter-only or generator functions.
export function diagnoseGraph(
  graph: MatGraph,
  db: NodeDB,
  derivedPins?: Record<string, DerivedPins>,
): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const reserved = new Set(db.reservedTypes ?? []);

  if (graph.type === 'Material') {
    const outs = graph.nodes.filter(n => n.type === 'MaterialOutput');
    if (outs.length === 0) {
      issues.push({ severity: 'warning', kind: 'missing-output', message: i18n.t('graphDiagnostics.missingOutput') });
    } else if (outs.length > 1) {
      for (const o of outs.slice(1)) {
        issues.push({ severity: 'warning', kind: 'extra-output', message: i18n.t('graphDiagnostics.extraOutput'), nodeId: o.id });
      }
    }
  } else {
    if (!graph.nodes.some(n => n.type === 'FunctionOutput')) {
      issues.push({ severity: 'error', kind: 'mf-no-output', message: i18n.t('graphDiagnostics.mfNoOutput') });
    }
  }

  // Unknown node types — not in the DB and not a reserved built-in.
  for (const n of graph.nodes) {
    if (isUnknownNodeType(n.type, db, reserved)) {
      issues.push({ severity: 'warning', kind: 'unknown-type', message: i18n.t('graphDiagnostics.unknownType', { type: n.type }), nodeId: n.id });
    }
  }

  // Connections referencing a pin that doesn't exist on its node. validateConnectionPins
  // attributes each issue to the offending node, so we read issue.nodeId directly.
  for (const issue of validateConnectionPins(graph, db)) {
    issues.push({ severity: 'warning', kind: 'bad-pin', message: issue.problem, nodeId: issue.nodeId });
  }

  // MaterialFunctionCall whose pins never resolved (MF missing, or its index not crawled).
  for (const n of graph.nodes) {
    if (n.type !== 'MaterialFunctionCall') continue;
    if (mfPinsUnresolved(derivedPins?.[n.id])) {
      issues.push({ severity: 'warning', kind: 'unresolved-mf', message: i18n.t('graphDiagnostics.unresolvedMf', { id: n.id }), nodeId: n.id });
    }
  }

  // Sibling-overlapping comments: a node belongs to two or more mutually-incomparable comments.
  for (const { nodeId, commentIds } of commentOverlaps(graph.comments ?? [])) {
    issues.push({
      severity: 'warning',
      kind: 'comment-overlap',
      message: i18n.t('graphDiagnostics.commentOverlap', { nodeId, commentList: commentIds.join(i18n.t('common.listSep')) }),
    });
  }

  return issues;
}

import type { MatGraph, DerivedPins } from './protocol';
import type { NodeDB } from '../../server/db-types';
import { validateConnectionPins } from './validate';
import { splitRef } from './connstr';

export interface GraphIssue {
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;   // when set, the Inspector can focus this node on click
}

// Health check for a loaded graph, computed entirely client-side from the same data
// the canvas already has (graph + node DB + resolved MF pins). Drives the Inspector's
// "what's wrong / what's missing" panel; each node-tied issue is clickable-to-focus.
export function diagnoseGraph(
  graph: MatGraph,
  db: NodeDB,
  derivedPins?: Record<string, DerivedPins>,
): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const reserved = new Set(db.reservedTypes ?? []);

  // Output-sink convention (mirrors the server's materialStructureWarnings + the
  // MaterialFunction in/out requirement from SPEC).
  if (graph.type === 'Material') {
    const outs = graph.nodes.filter(n => n.type === 'MaterialOutput');
    if (outs.length === 0) {
      issues.push({ severity: 'error', message: '缺少 MaterialOutput 輸出節點（Material 必須恰好一個）。' });
    } else if (outs.length > 1) {
      for (const o of outs.slice(1)) {
        issues.push({ severity: 'error', message: '多餘的 MaterialOutput（Material 只能有一個輸出節點）。', nodeId: o.id });
      }
    }
  } else {
    if (!graph.nodes.some(n => n.type === 'FunctionInput')) {
      issues.push({ severity: 'warning', message: 'MaterialFunction 沒有 FunctionInput 節點。' });
    }
    if (!graph.nodes.some(n => n.type === 'FunctionOutput')) {
      issues.push({ severity: 'error', message: 'MaterialFunction 缺少 FunctionOutput 節點（至少要一個）。' });
    }
  }

  // Unknown node types — not in the DB and not a reserved built-in.
  for (const n of graph.nodes) {
    if (!db.nodes[n.type] && !reserved.has(n.type)) {
      issues.push({ severity: 'warning', message: `未知節點型別「${n.type}」——不在 node DB，導出無法對映。`, nodeId: n.id });
    }
  }

  // Connections referencing a pin that doesn't exist on its node.
  for (const issue of validateConnectionPins(graph, db)) {
    const nodeId = issue.problem.includes('no input pin') ? splitRef(issue.to)[0] : splitRef(issue.from)[0];
    issues.push({ severity: 'warning', message: issue.problem, nodeId });
  }

  // MaterialFunctionCall whose pins never resolved (MF missing, or its index not crawled).
  for (const n of graph.nodes) {
    if (n.type !== 'MaterialFunctionCall') continue;
    const dp = derivedPins?.[n.id];
    if (!dp || (dp.inputs.length === 0 && dp.outputs.length === 0)) {
      issues.push({ severity: 'warning', message: `MaterialFunctionCall「${n.id}」沒有解析到 pin——MF 缺失或需要先爬取它的 index。`, nodeId: n.id });
    }
  }

  return issues;
}

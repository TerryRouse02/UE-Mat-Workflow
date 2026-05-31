import type { MatGraph } from './protocol';

export function hasMaterialFunctionCall(graph: MatGraph | undefined): boolean {
  if (!graph) return false;
  return graph.nodes.some(n => n.type === 'MaterialFunctionCall');
}

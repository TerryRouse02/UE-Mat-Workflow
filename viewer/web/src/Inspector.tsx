import type { MatGraph } from './protocol';

export interface InspectorProps {
  graph?: MatGraph;
  selectedNodeId: string | null;
}

// Stub — real implementation in a later task.
export function Inspector(_: InspectorProps) {
  return <aside className="inspector-wrap" />;
}

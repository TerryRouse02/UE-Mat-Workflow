import { describe, it, expect } from 'vitest';
import { autoLayout } from '../web/src/layout';

// Regression for the blank-canvas crash: a node id of literally "length" made
// dagre 0.8.5 throw inside its position pass (lodash treats the node-keyed result
// map as array-like because of the "length" key), which bubbled out of the Graph
// render and white-screened the viewer. graphs/stress_common has such a node
// ({ id: "length", type: "Length" }). autoLayout must namespace its dagre keys so
// any AI-authored id lays out without throwing.
describe('autoLayout tolerates lodash-colliding node ids', () => {
  it('lays out a graph containing a node id "length"', () => {
    const r = autoLayout({
      nodes: [{ id: 'a' }, { id: 'length' }, { id: 'b' }],
      edges: [
        { id: 'e0', source: 'a', target: 'length' },
        { id: 'e1', source: 'length', target: 'b' },
      ],
    });
    expect(Number.isFinite(r.positions['a']?.x)).toBe(true);
    expect(Number.isFinite(r.positions['length']?.x)).toBe(true);
    expect(Number.isFinite(r.positions['b']?.x)).toBe(true);
  });

  it('lays out "length" inside a comment cluster too', () => {
    const r = autoLayout({
      nodes: [{ id: 'length' }, { id: 'b' }],
      edges: [{ id: 'e0', source: 'length', target: 'b' }],
      clusters: [{ id: 'comment-c1', childNodeIds: ['length', 'b'] }],
    });
    expect(Number.isFinite(r.positions['length']?.x)).toBe(true);
    expect(Number.isFinite(r.positions['b']?.x)).toBe(true);
  });

  it('still produces a normal layout for ordinary ids', () => {
    const r = autoLayout({
      nodes: [{ id: 'src' }, { id: 'dst' }],
      edges: [{ id: 'e0', source: 'src', target: 'dst' }],
    });
    // LR layout: the target sits to the right of the source.
    expect(r.positions['dst'].x).toBeGreaterThan(r.positions['src'].x);
  });
});

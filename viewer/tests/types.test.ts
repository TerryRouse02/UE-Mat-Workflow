import { describe, it, expectTypeOf } from 'vitest';
import type { MatGraph, Node, Connection, Comment } from '../server/types';

describe('MatGraph types', () => {
  it('Material graph compiles', () => {
    const g: MatGraph = {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      type: 'Material',
      name: 'x',
      nodes: [{ id: 'n1', type: 'Multiply', params: { ConstB: 0.5 } }],
      connections: [{ from: 'n1:Result', to: 'OUT:BaseColor' }],
      comments: [],
    };
    expectTypeOf(g).toMatchTypeOf<MatGraph>();
  });
});

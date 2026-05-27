import { describe, it, expectTypeOf } from 'vitest';
import type { NodeDB, NodeDef, PinDef, ParamDef } from '../server/db-types';

describe('NodeDB types', () => {
  it('valid DB compiles', () => {
    const db: NodeDB = {
      schemaVersion: '1.0',
      ueVersion: '5.7',
      generatedAt: '2026-05-26',
      source: 'manual',
      reservedTypes: ['MaterialOutput', 'FunctionInput', 'FunctionOutput', 'MaterialFunctionCall'],
      nodes: {
        Multiply: {
          category: 'Math',
          description: '',
          inputs: [{ name: 'A', type: 'Float1|2|3|4', required: true }],
          outputs: [{ name: 'Result', type: 'matchInput' }],
          params: [{ name: 'ConstB', type: 'Float', default: 1, when: 'B unconnected' }],
          verified: true,
        },
      },
    };
    expectTypeOf(db).toMatchTypeOf<NodeDB>();
  });
});

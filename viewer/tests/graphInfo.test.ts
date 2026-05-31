import { describe, it, expect } from 'vitest';
import { hasMaterialFunctionCall } from '../web/src/graphInfo';
import type { MatGraph } from '../web/src/protocol';

const base: MatGraph = {
  schemaVersion: '1', ueVersion: '5.7', type: 'Material', name: 'M',
  nodes: [], connections: [],
};

describe('hasMaterialFunctionCall', () => {
  it('false when no MFCall nodes', () => {
    expect(hasMaterialFunctionCall({ ...base, nodes: [{ id: 'a', type: 'Multiply' }] })).toBe(false);
  });
  it('true when a MaterialFunctionCall node exists', () => {
    expect(hasMaterialFunctionCall({ ...base, nodes: [{ id: 'a', type: 'MaterialFunctionCall' }] })).toBe(true);
  });
});

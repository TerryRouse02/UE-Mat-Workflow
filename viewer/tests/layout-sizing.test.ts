import { describe, it, expect } from 'vitest';
import { computeNodeHeight, computeNodeWidth } from '../web/src/layout';

const withCode = { label: 'Custom', inputs: [{ name: 'In', type: 'Float' }], outputs: [{ name: 'Out', type: 'Float' }],
  params: { Code: 'return saturate(x);\n'.repeat(10) } };
const noParams = { label: 'Custom', inputs: [{ name: 'In', type: 'Float' }], outputs: [{ name: 'Out', type: 'Float' }], params: {} };

describe('node sizing ignores params', () => {
  it('height is identical with or without params', () => {
    expect(computeNodeHeight(withCode)).toBe(computeNodeHeight(noParams));
  });
  it('width is identical with or without params', () => {
    expect(computeNodeWidth(withCode)).toBe(computeNodeWidth(noParams));
  });
});

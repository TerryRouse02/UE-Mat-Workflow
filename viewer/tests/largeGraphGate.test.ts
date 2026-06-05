import { describe, it, expect } from 'vitest';
import { shouldConfirmOpen, LARGE_GRAPH_THRESHOLD } from '../web/src/largeGraphGate';

describe('shouldConfirmOpen', () => {
  it('returns false when nodeCount is undefined', () => {
    expect(shouldConfirmOpen(undefined)).toBe(false);
  });

  it('returns false for a small graph (47 nodes)', () => {
    expect(shouldConfirmOpen(47)).toBe(false);
  });

  it('returns true for a large graph (685 nodes)', () => {
    expect(shouldConfirmOpen(685)).toBe(true);
  });

  it('returns false exactly at the threshold', () => {
    expect(shouldConfirmOpen(LARGE_GRAPH_THRESHOLD)).toBe(false);
  });

  it('returns true one above the threshold', () => {
    expect(shouldConfirmOpen(LARGE_GRAPH_THRESHOLD + 1)).toBe(true);
  });

  it('respects a custom threshold parameter', () => {
    expect(shouldConfirmOpen(100, 50)).toBe(true);
    expect(shouldConfirmOpen(49, 50)).toBe(false);
  });
});

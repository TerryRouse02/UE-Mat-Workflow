import { describe, it, expect } from 'vitest';
import { formatSyncAgo } from '../web/src/syncStatus';

describe('formatSyncAgo', () => {
  it('shows "just now" under 2s', () => {
    expect(formatSyncAgo(1000)).toBe('just now');
  });
  it('shows seconds', () => {
    expect(formatSyncAgo(5000)).toBe('5s ago');
  });
  it('shows minutes', () => {
    expect(formatSyncAgo(125000)).toBe('2m ago');
  });
  it('shows hours', () => {
    expect(formatSyncAgo(3 * 3600 * 1000)).toBe('3h ago');
  });
});

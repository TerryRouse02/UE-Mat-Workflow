import { describe, it, expect } from 'vitest';
import { compareVersions, latestOf } from '../web/src/versionUtil';

describe('compareVersions', () => {
  it('orders by numeric component, not lexically', () => {
    // The trap: a string sort puts "5.10" before "5.7"; numeric sort must not.
    expect(compareVersions('5.10', '5.7')).toBeGreaterThan(0);
    expect(compareVersions('5.7', '5.10')).toBeLessThan(0);
  });

  it('compares major before minor', () => {
    expect(compareVersions('6.0', '5.99')).toBeGreaterThan(0);
  });

  it('treats equal versions as 0', () => {
    expect(compareVersions('5.7', '5.7')).toBe(0);
  });

  it('handles differing component counts', () => {
    expect(compareVersions('5.7', '5.7.0')).toBe(0);
    expect(compareVersions('5.7.1', '5.7')).toBeGreaterThan(0);
  });
});

describe('latestOf', () => {
  it('returns the highest version numerically', () => {
    expect(latestOf(['5.7', '5.10', '5.8'])).toBe('5.10');
  });

  it('returns the single version when there is one', () => {
    expect(latestOf(['5.7'])).toBe('5.7');
  });

  it('returns undefined for an empty list', () => {
    expect(latestOf([])).toBeUndefined();
  });
});

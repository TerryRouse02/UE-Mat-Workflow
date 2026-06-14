// lang.test.ts — colocated unit test for the pure effectiveLanguage() resolver.
// Imports ONLY lang.ts (no i18n.ts), so it runs green under the node-env vitest
// without react-i18next being installed.

import { describe, it, expect } from 'vitest';
import { effectiveLanguage } from './lang';

describe('effectiveLanguage', () => {
  it('local override beats the team default', () => {
    expect(effectiveLanguage('en', 'zh-Hant')).toBe('en');
    expect(effectiveLanguage('zh-Hant', 'en')).toBe('zh-Hant');
  });

  it('applies the team default when there is no local choice', () => {
    expect(effectiveLanguage(null, 'en')).toBe('en');
    expect(effectiveLanguage(undefined, 'en')).toBe('en');
  });

  it("falls back to 'zh-Hant' when neither is set", () => {
    expect(effectiveLanguage()).toBe('zh-Hant');
    expect(effectiveLanguage(null, null)).toBe('zh-Hant');
    expect(effectiveLanguage(undefined, undefined)).toBe('zh-Hant');
  });
});

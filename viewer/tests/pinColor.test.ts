import { describe, it, expect } from 'vitest';
import { pinColor, catColor } from '../web/src/theme/colors';

describe('pinColor', () => {
  it('maps float family to scalar green', () => {
    expect(pinColor('Float')).toBe('#7ec96f');
    expect(pinColor('Float1')).toBe('#7ec96f');
  });
  it('maps vector widths', () => {
    expect(pinColor('Float2')).toBe('#5cc4c4');
    expect(pinColor('Float3')).toBe('#e0b34d');
    expect(pinColor('Float4')).toBe('#b48cf0');
  });
  it('maps texture, bool, attributes (case-insensitive)', () => {
    expect(pinColor('texture')).toBe('#5b9bf0');
    expect(pinColor('Texture')).toBe('#5b9bf0');
    expect(pinColor('bool')).toBe('#e0728a');
    expect(pinColor('MaterialAttributes')).toBe('#e8ebef');
  });
  it('falls back to neutral grey for unknown types', () => {
    expect(pinColor('Wat')).toBe('#8a93a0');
    expect(pinColor(undefined)).toBe('#8a93a0');
  });
});

describe('catColor', () => {
  it('maps known categories', () => {
    expect(catColor('Math')).toBe('#5b9bf0');
    expect(catColor('Functions')).toBe('#a06bff');
  });
  it('defaults unknown categories', () => {
    expect(catColor('Nope')).toBe('#6b7886');
    expect(catColor(undefined)).toBe('#6b7886');
  });
});

import { describe, it, expect } from 'vitest';

// ─── uiHelpers ───────────────────────────────────────────────────────────────
import {
  variantClass,
  parseLogLine,
  estimateLinks,
  LINK_FACTOR,
  matchesCmd,
  matchesNode,
} from '../web/src/uiHelpers';

// ─── timeUtils ───────────────────────────────────────────────────────────────
import {
  fmtTimeCompact,
  relTimeMinutes,
  fmtTimeIso,
  relTimeHours,
} from '../web/src/timeUtils';

// ═══════════════════════════════════════════════════════════════════════════════
// variantClass
// ═══════════════════════════════════════════════════════════════════════════════

describe('variantClass', () => {
  it('success → ok', () => {
    expect(variantClass('success')).toBe('ok');
  });

  it('error → err', () => {
    expect(variantClass('error')).toBe('err');
  });

  it('warning → err', () => {
    expect(variantClass('warning')).toBe('err');
  });

  it('info → empty string', () => {
    expect(variantClass('info')).toBe('');
  });

  it('loading → empty string', () => {
    expect(variantClass('loading')).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// parseLogLine
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseLogLine', () => {
  it('returns info for plain text', () => {
    const result = parseLogLine('Starting material crawl', 0);
    expect(result.lvl).toBe('info');
    expect(result.msg).toBe('Starting material crawl');
    expect(result.t).toBe(0);
  });

  it('classifies error keyword → error', () => {
    expect(parseLogLine('Encountered an error reading file', 1).lvl).toBe('error');
  });

  it('classifies fail keyword → error', () => {
    expect(parseLogLine('Operation failed: timeout', 2).lvl).toBe('error');
  });

  it('classifies fatal keyword → error', () => {
    expect(parseLogLine('[FATAL] Out of memory', 3).lvl).toBe('error');
  });

  it('classifies exception keyword → error', () => {
    expect(parseLogLine('Unhandled exception thrown', 4).lvl).toBe('error');
  });

  it('classifies warn keyword → warn', () => {
    expect(parseLogLine('Warning: asset not found', 5).lvl).toBe('warn');
  });

  it('classifies logasset keyword → dim', () => {
    expect(parseLogLine('LogAsset: loading /Game/M_Rock', 6).lvl).toBe('dim');
  });

  it('classifies loginit keyword → dim', () => {
    expect(parseLogLine('LogInit: Engine version 5.7', 7).lvl).toBe('dim');
  });

  it('t is index * 0.1', () => {
    expect(parseLogLine('msg', 0).t).toBeCloseTo(0.0);
    expect(parseLogLine('msg', 5).t).toBeCloseTo(0.5);
    expect(parseLogLine('msg', 10).t).toBeCloseTo(1.0);
  });

  it('error takes precedence over warn when both keywords present', () => {
    expect(parseLogLine('warning: error occurred', 0).lvl).toBe('error');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// estimateLinks
// ═══════════════════════════════════════════════════════════════════════════════

describe('estimateLinks', () => {
  it('rounds nodeCount * LINK_FACTOR', () => {
    expect(estimateLinks(0)).toBe(0);
    expect(estimateLinks(1)).toBe(Math.round(1 * LINK_FACTOR));
    expect(estimateLinks(10)).toBe(Math.round(10 * LINK_FACTOR));
    expect(estimateLinks(100)).toBe(Math.round(100 * LINK_FACTOR));
  });

  it('matches the original inline formula from BigGraphConfirm', () => {
    // The original component had: Math.round(file.nodeCount * 1.6)
    for (const n of [0, 1, 5, 25, 100, 300, 685]) {
      expect(estimateLinks(n)).toBe(Math.round(n * 1.6));
    }
  });

  it('LINK_FACTOR is 1.6', () => {
    expect(LINK_FACTOR).toBe(1.6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// matchesCmd
// ═══════════════════════════════════════════════════════════════════════════════

describe('matchesCmd', () => {
  it('matches when label contains query (case-insensitive)', () => {
    expect(matchesCmd({ label: '前往 Config／爬取面板' }, 'config')).toBe(true);
    expect(matchesCmd({ label: '前往 Config／爬取面板' }, 'CONFIG')).toBe(true);
  });

  it('matches empty query (returns all)', () => {
    expect(matchesCmd({ label: '匯出選取到剪貼簿（T3D）' }, '')).toBe(true);
  });

  it('returns false when label does not contain query', () => {
    expect(matchesCmd({ label: '前往 Config' }, 'xyz')).toBe(false);
  });

  it('matches partial label substring', () => {
    expect(matchesCmd({ label: '重爬專案母材質' }, '母材')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// matchesNode
// ═══════════════════════════════════════════════════════════════════════════════

describe('matchesNode', () => {
  it('matches on title (case-insensitive)', () => {
    expect(matchesNode({ title: 'Multiply', id: 'node-1' }, 'multiply')).toBe(true);
    expect(matchesNode({ title: 'Multiply', id: 'node-1' }, 'MULT')).toBe(true);
  });

  it('matches on id', () => {
    expect(matchesNode({ title: 'Add', id: 'node-123' }, '123')).toBe(true);
  });

  it('empty query matches everything', () => {
    expect(matchesNode({ title: 'Lerp', id: 'lerp-1' }, '')).toBe(true);
  });

  it('returns false when neither title nor id matches', () => {
    expect(matchesNode({ title: 'Lerp', id: 'lerp-1' }, 'xyz')).toBe(false);
  });

  it('id match takes effect even if title does not match', () => {
    expect(matchesNode({ title: 'Texture2D', id: 'mul-99' }, 'mul')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// fmtTimeCompact (ConfigPanel flavour)
// ═══════════════════════════════════════════════════════════════════════════════

describe('fmtTimeCompact', () => {
  it('formats a valid ISO string to MM-DD HH:MM (local time based)', () => {
    // We only verify the shape: "MM-DD HH:MM"
    const result = fmtTimeCompact('2025-03-15T14:30:00Z');
    expect(result).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('produces NaN-NaN NaN:NaN for empty string (matches original component behavior)', () => {
    // new Date('') yields Invalid Date; the try/catch does not intercept NaN math.
    // The original ConfigPanel fmtTime had the same behavior — no input validation.
    expect(fmtTimeCompact('')).toBe('NaN-NaN NaN:NaN');
  });

  it('produces NaN-NaN NaN:NaN for a clearly invalid string (matches original)', () => {
    expect(fmtTimeCompact('not-a-date')).toBe('NaN-NaN NaN:NaN');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// relTimeMinutes (ConfigPanel flavour)
// ═══════════════════════════════════════════════════════════════════════════════

describe('relTimeMinutes', () => {
  it('returns 剛剛 for a timestamp seconds ago', () => {
    const iso = new Date(Date.now() - 10_000).toISOString();
    expect(relTimeMinutes(iso)).toBe('剛剛');
  });

  it('returns X 分鐘前 for ~2 minutes ago', () => {
    const iso = new Date(Date.now() - 2 * 60_000).toISOString();
    expect(relTimeMinutes(iso)).toBe('2 分鐘前');
  });

  it('returns X 小時前 for ~3 hours ago', () => {
    const iso = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(relTimeMinutes(iso)).toBe('3 小時前');
  });

  it('returns X 天前 for ~2 days ago', () => {
    const iso = new Date(Date.now() - 2 * 86400_000).toISOString();
    expect(relTimeMinutes(iso)).toBe('2 天前');
  });

  it('produces a NaN-containing string for a clearly invalid ISO (matches original behavior)', () => {
    // new Date('bad-iso') → NaN; the try/catch does not intercept arithmetic on NaN.
    // Original relTime in ConfigPanel had identical behavior.
    const result = relTimeMinutes('bad-iso');
    expect(result).toContain('NaN');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// fmtTimeIso (Inspector flavour)
// ═══════════════════════════════════════════════════════════════════════════════

describe('fmtTimeIso', () => {
  it('replaces T with space and trims to 16 chars', () => {
    expect(fmtTimeIso('2025-03-15T14:30:00.000Z')).toBe('2025-03-15 14:30');
  });

  it('returns — for null', () => {
    expect(fmtTimeIso(null)).toBe('—');
  });

  it('returns — for undefined', () => {
    expect(fmtTimeIso(undefined)).toBe('—');
  });

  it('returns — for empty string', () => {
    expect(fmtTimeIso('')).toBe('—');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// relTimeHours (Inspector flavour)
// ═══════════════════════════════════════════════════════════════════════════════

describe('relTimeHours', () => {
  it('returns 剛剛 for a timestamp less than half an hour ago', () => {
    // relTimeHours uses Math.round(delta / 36e5). 10 min → 0.17 → rounds to 0 → 剛剛.
    const iso = new Date(Date.now() - 10 * 60_000).toISOString(); // 10 min ago
    expect(relTimeHours(iso)).toBe('剛剛');
  });

  it('returns X 小時前 for ~5 hours ago', () => {
    const iso = new Date(Date.now() - 5 * 3600_000).toISOString();
    expect(relTimeHours(iso)).toBe('5 小時前');
  });

  it('returns X 天前 for ~3 days ago', () => {
    const iso = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
    expect(relTimeHours(iso)).toBe('3 天前');
  });

  it('returns empty string for null', () => {
    expect(relTimeHours(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(relTimeHours(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(relTimeHours('')).toBe('');
  });
});

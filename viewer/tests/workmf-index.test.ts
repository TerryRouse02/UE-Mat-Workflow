import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadWorkMfIndex, deriveWorkMfPins } from '../server/workmf-index';
import type { WorkMfIndex } from '../server/workmf-index';

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'workmf-'));
  const p = resolve(dir, name);
  writeFileSync(p, content);
  return p;
}

describe('loadWorkMfIndex', () => {
  it('loads a valid index', async () => {
    const p = tmpFile('workmf-index.json', JSON.stringify({
      schemaVersion: '1.0', kind: 'workmf-index', ueVersion: '5.7',
      functions: {
        '/Game/MF_A.MF_A': {
          assetPath: '/Game/MF_A.MF_A',
          inputs: [{ name: 'X', type: 'Float1' }],
          outputs: [{ name: 'R', type: 'Float3' }],
        },
      },
    }));
    const { index, warnings } = await loadWorkMfIndex(p);
    expect(warnings).toEqual([]);
    expect(index?.functions['/Game/MF_A.MF_A'].inputs[0].name).toBe('X');
  });

  it('returns empty (and does NOT warn) when the file is absent', async () => {
    const { index, warnings } = await loadWorkMfIndex(resolve(tmpdir(), 'no-such-workmf-index.json'));
    expect(index).toBeNull();
    expect(warnings).toEqual([]);
  });

  it('warns on malformed JSON', async () => {
    const p = tmpFile('bad.json', '{ not json');
    const { index, warnings } = await loadWorkMfIndex(p);
    expect(index).toBeNull();
    expect(warnings[0]).toMatch(/invalid JSON/i);
  });

  it('warns when kind is wrong (guards a nodes-ue DB being mistaken for an index)', async () => {
    const p = tmpFile('wrong.json', JSON.stringify({ schemaVersion: '1.0', ueVersion: '5.7', nodes: {} }));
    const { index, warnings } = await loadWorkMfIndex(p);
    expect(index).toBeNull();
    expect(warnings[0]).toMatch(/kind/i);
  });
});

describe('deriveWorkMfPins', () => {
  const index: WorkMfIndex = {
    kind: 'workmf-index',
    functions: {
      '/Game/MF_A.MF_A': {
        assetPath: '/Game/MF_A.MF_A',
        inputs: [{ name: 'X', type: 'Float1' }, { name: 'Y', type: 'Float2' }],
        outputs: [{ name: 'R', type: 'Float3' }],
      },
    },
  };

  it('returns ordered pins (name+type only) for a hit', () => {
    expect(deriveWorkMfPins(index, '/Game/MF_A.MF_A')).toEqual({
      inputs: [{ name: 'X', type: 'Float1' }, { name: 'Y', type: 'Float2' }],
      outputs: [{ name: 'R', type: 'Float3' }],
    });
  });

  it('returns null for a miss or a null index', () => {
    expect(deriveWorkMfPins(index, '/Game/Nope.Nope')).toBeNull();
    expect(deriveWorkMfPins(null, '/Game/MF_A.MF_A')).toBeNull();
  });
});

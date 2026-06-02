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

  it('accepts the full WorkMF producer output shape (provenance, category, pin index fields)', async () => {
    // Mirrors exactly what the UE commandlet WriteWorkMfIndex emits, so a producer/consumer
    // schema drift fails here instead of silently at runtime on the user's machine.
    const p = tmpFile('workmf-index.json', JSON.stringify({
      schemaVersion: '1.0', kind: 'workmf-index', ueVersion: '5.7',
      provenance: {
        ueVersion: '5.7', engineVersion: '5.7.4-51494982+++UE5+Release-5.7',
        generatedBy: 'UEMatExportMetadata', generatedAt: '2026-06-01T00:00:00.000Z', contentRoots: '/Game',
      },
      functions: {
        '/Game/Functions/MF_Foo.MF_Foo': {
          assetPath: '/Game/Functions/MF_Foo.MF_Foo',
          displayName: 'MF_Foo',
          category: '/Game/Functions',
          inputs: [{ name: 'Color', type: 'Float3', index: 0 }, { name: 'Amount', type: 'Float1', index: 1 }],
          outputs: [{ name: 'Result', type: 'Float3', index: 0 }],
          missing: false,
        },
      },
    }));
    const { index, warnings } = await loadWorkMfIndex(p);
    expect(warnings).toEqual([]);
    // The exporter consumes pins by declared order; the `index` field is informational only.
    expect(deriveWorkMfPins(index, '/Game/Functions/MF_Foo.MF_Foo')).toEqual({
      inputs: [{ name: 'Color', type: 'Float3' }, { name: 'Amount', type: 'Float1' }],
      outputs: [{ name: 'Result', type: 'Float3' }],
    });
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

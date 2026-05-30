import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ExportMeta } from '../web/src/export/export-meta-types';

const ROOT = resolve(__dirname, '../../agent-pack');
const exp: ExportMeta = JSON.parse(readFileSync(resolve(ROOT, 'nodes-ue5.7.export.json'), 'utf-8'));
const db = JSON.parse(readFileSync(resolve(ROOT, 'nodes-ue5.7.json'), 'utf-8'));

describe('nodes-ue5.7.export.json', () => {
  it('declares ue 5.7', () => {
    expect(exp.ueVersion).toBe('5.7');
  });

  it('has no orphan node entries (every export key exists in the authoring DB)', () => {
    const orphans = Object.keys(exp.nodes).filter(k => !(k in db.nodes));
    expect(orphans).toEqual([]);
  });

  it('includes the hand-authored subset', () => {
    for (const t of ['Multiply', 'Add', 'Subtract', 'Saturate', 'Lerp', 'Constant',
                     'ScalarParameter', 'StaticSwitchParameter', 'QualitySwitch',
                     'FeatureLevelSwitch', 'TextureSampleParameter2D']) {
      expect(exp.nodes[t], `missing export meta for ${t}`).toBeTruthy();
      expect(exp.nodes[t].ueClass).toMatch(/^\/Script\/Engine\.MaterialExpression/);
    }
  });

  it('covers the reserved types that are exportable', () => {
    for (const t of ['MaterialFunctionCall', 'FunctionInput', 'FunctionOutput']) {
      expect(exp.reserved[t], `missing reserved export meta for ${t}`).toBeTruthy();
    }
    expect(exp.reserved['MaterialOutput']).toBeUndefined(); // never exported
  });

  it('every node/reserved entry has well-formed outputs and params maps', () => {
    for (const m of [...Object.values(exp.nodes), ...Object.values(exp.reserved)]) {
      expect(typeof m.ueClass).toBe('string');
      expect(typeof m.inputs).toBe('object');
      expect(typeof m.outputs).toBe('object');
      expect(typeof m.params).toBe('object');
    }
  });
});

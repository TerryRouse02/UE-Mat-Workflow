import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDB, validateDB } from '../server/db-loader';

const DB_PATH = resolve(__dirname, '../../agent-pack/nodes-ue5.7.json');

describe('db-loader', () => {
  it('loads the seed DB without errors', () => {
    const db = loadDB(DB_PATH);
    expect(db.ueVersion).toBe('5.7');
    expect(Object.keys(db.nodes).length).toBeGreaterThanOrEqual(10);
  });

  it('every node has at least one output', () => {
    const db = loadDB(DB_PATH);
    for (const [name, def] of Object.entries(db.nodes)) {
      expect(def.outputs.length, `${name} must have outputs`).toBeGreaterThan(0);
    }
  });

  it('validateDB rejects DB with duplicate pin names', () => {
    const bad = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
    bad.nodes.Multiply.inputs.push({ name: 'A', type: 'Float1', required: false });
    expect(() => validateDB(bad)).toThrow(/duplicate pin/i);
  });

  it('validateDB rejects when a node has no outputs', () => {
    const bad = JSON.parse(readFileSync(DB_PATH, 'utf-8'));
    bad.nodes.Multiply.outputs = [];
    expect(() => validateDB(bad)).toThrow(/no outputs/i);
  });
});

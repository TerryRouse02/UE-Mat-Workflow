import { readFileSync } from 'node:fs';
import type { NodeDB } from './db-types.js';

export function loadDB(path: string): NodeDB {
  const raw = readFileSync(path, 'utf-8');
  const db = JSON.parse(raw) as NodeDB;
  validateDB(db);
  return db;
}

export function validateDB(db: NodeDB): void {
  if (!db.nodes || typeof db.nodes !== 'object') {
    throw new Error('DB.nodes missing');
  }
  for (const [name, def] of Object.entries(db.nodes)) {
    if (!def.outputs || def.outputs.length === 0) {
      throw new Error(`Node "${name}" has no outputs`);
    }
    assertUniquePinNames(name, 'inputs', def.inputs ?? []);
    assertUniquePinNames(name, 'outputs', def.outputs);
  }
}

function assertUniquePinNames(node: string, side: string, pins: { name: string }[]): void {
  const seen = new Set<string>();
  for (const p of pins) {
    if (seen.has(p.name)) {
      throw new Error(`duplicate pin "${p.name}" on ${node}.${side}`);
    }
    seen.add(p.name);
  }
}

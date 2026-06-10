import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDB, validateDB, OUTPUTLESS_NODES } from '../server/db-loader';

const AGENT_PACK = resolve(__dirname, '../../agent-pack');

// Every shipped authoring DB: agent-pack/nodes-ue<ver>.json (the .export.json
// siblings are export metadata and the .index.json siblings are the generated
// minimal indexes — neither is a DB). As more UE versions are added this
// validates each one automatically.
const dbFiles = readdirSync(AGENT_PACK)
  .filter(f => f.startsWith('nodes-ue') && f.endsWith('.json')
    && !f.endsWith('.export.json') && !f.endsWith('.index.json'))
  .map(f => resolve(AGENT_PACK, f));

describe('db-loader — all shipped version DBs', () => {
  it('finds at least one version DB', () => {
    expect(dbFiles.length).toBeGreaterThan(0);
  });

  for (const path of dbFiles) {
    const name = path.split('/').pop()!;
    describe(name, () => {
      it('loads and validates without errors', () => {
        const db = loadDB(path);
        expect(db.ueVersion).toBeTruthy();
        expect(Object.keys(db.nodes).length).toBeGreaterThanOrEqual(10);
      });

      it('every node has an output (except declared output-less sinks like NamedRerouteDeclaration)', () => {
        const db = loadDB(path);
        for (const [n, def] of Object.entries(db.nodes)) {
          if (OUTPUTLESS_NODES.has(n)) continue;
          expect(def.outputs.length, `${n} must have outputs`).toBeGreaterThan(0);
        }
      });
    });
  }
});

describe('validateDB rejects malformed DBs', () => {
  const base = dbFiles[0];

  it('rejects duplicate pin names', () => {
    const bad = JSON.parse(readFileSync(base, 'utf-8'));
    const first = Object.keys(bad.nodes)[0];
    bad.nodes[first].inputs = [
      ...(bad.nodes[first].inputs ?? []),
      { name: 'DUP', type: 'Float1' },
      { name: 'DUP', type: 'Float1' },
    ];
    expect(() => validateDB(bad)).toThrow(/duplicate pin/i);
  });

  it('rejects when a node has no outputs', () => {
    const bad = JSON.parse(readFileSync(base, 'utf-8'));
    const first = Object.keys(bad.nodes)[0];
    bad.nodes[first].outputs = [];
    expect(() => validateDB(bad)).toThrow(/no outputs/i);
  });
});

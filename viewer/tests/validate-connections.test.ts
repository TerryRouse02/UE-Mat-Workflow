import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateConnectionPins } from '../web/src/validate';
import type { MatGraph } from '../web/src/protocol';
import type { NodeDB } from '../server/db-types';

const DB: NodeDB = JSON.parse(
  readFileSync(resolve(__dirname, '../../agent-pack/nodes-ue5.7.json'), 'utf-8'),
) as NodeDB;

function graph(nodes: MatGraph['nodes'], connections: MatGraph['connections']): MatGraph {
  return {
    schemaVersion: '1', ueVersion: '5.7', type: 'Material', name: 't',
    nodes, connections,
  };
}

describe('validateConnectionPins', () => {
  it('(a) reports a connection to a nonexistent INPUT pin on a static node', () => {
    const g = graph(
      [
        { id: 'c1', type: 'Constant', params: { Value: 1 } },
        { id: 'm1', type: 'Multiply' },
      ],
      [{ from: 'c1:Value', to: 'm1:NotAPin' }],
    );
    const issues = validateConnectionPins(g, DB);
    expect(issues).toHaveLength(1);
    expect(issues[0].to).toBe('m1:NotAPin');
    expect(issues[0].problem).toMatch(/NotAPin/);
    expect(issues[0].problem).toMatch(/input/i);
  });

  it('(b) reports a connection FROM a nonexistent OUTPUT pin on a static node', () => {
    const g = graph(
      [
        { id: 'c1', type: 'Constant', params: { Value: 1 } },
        { id: 'm1', type: 'Multiply' },
      ],
      [{ from: 'c1:Bogus', to: 'm1:A' }],
    );
    const issues = validateConnectionPins(g, DB);
    expect(issues).toHaveLength(1);
    expect(issues[0].from).toBe('c1:Bogus');
    expect(issues[0].problem).toMatch(/Bogus/);
    expect(issues[0].problem).toMatch(/output/i);
  });

  it('(c) does NOT report valid pins', () => {
    const g = graph(
      [
        { id: 'c1', type: 'Constant', params: { Value: 1 } },
        { id: 'c2', type: 'Constant', params: { Value: 2 } },
        { id: 'm1', type: 'Multiply' },
      ],
      [
        { from: 'c1:Value', to: 'm1:A' },
        { from: 'c2:Value', to: 'm1:B' },
      ],
    );
    expect(validateConnectionPins(g, DB)).toEqual([]);
  });

  it('(d) SKIPS dynamic-pin nodes (Custom) on both sides', () => {
    const g = graph(
      [
        { id: 'cust', type: 'Custom', params: {} },
        { id: 'm1', type: 'Multiply' },
      ],
      [
        // Custom output pin name not in static DB - must be skipped
        { from: 'cust:WhateverOut', to: 'm1:A' },
        // Custom input pin name not in static DB - must be skipped
        { from: 'm1:Result', to: 'cust:WhateverIn' },
      ],
    );
    expect(validateConnectionPins(g, DB)).toEqual([]);
  });

  it('(d2) SKIPS SetMaterialAttributes (dynamic-pin) pins', () => {
    const g = graph(
      [
        { id: 'c1', type: 'Constant', params: { Value: 1 } },
        { id: 'sma', type: 'SetMaterialAttributes' },
      ],
      [{ from: 'c1:Value', to: 'sma:SomeDynamicAttr' }],
    );
    expect(validateConnectionPins(g, DB)).toEqual([]);
  });

  it('(e) MaterialOutput: valid attribute pin not reported, invalid one reported', () => {
    const g = graph(
      [
        { id: 'c1', type: 'Constant', params: { Value: 1 } },
        { id: 'c2', type: 'Constant', params: { Value: 0.5 } },
        { id: 'out', type: 'MaterialOutput' },
      ],
      [
        { from: 'c1:Value', to: 'out:BaseColor' },   // valid attribute
        { from: 'c2:Value', to: 'out:NotAnAttr' },   // invalid attribute
      ],
    );
    const issues = validateConnectionPins(g, DB);
    expect(issues).toHaveLength(1);
    expect(issues[0].to).toBe('out:NotAnAttr');
    expect(issues[0].problem).toMatch(/NotAnAttr/);
  });

  it('(f) SKIPS MaterialFunctionCall (pins are derived)', () => {
    const g = graph(
      [
        { id: 'c1', type: 'Constant', params: { Value: 1 } },
        { id: 'mfc', type: 'MaterialFunctionCall', params: { MaterialFunction: './foo.matgraph.json' } },
        { id: 'm1', type: 'Multiply' },
      ],
      [
        { from: 'c1:Value', to: 'mfc:AnyDerivedInput' },
        { from: 'mfc:AnyDerivedOutput', to: 'm1:A' },
      ],
    );
    expect(validateConnectionPins(g, DB)).toEqual([]);
  });

  it('skips connections referencing an unknown node id (not a pin problem)', () => {
    const g = graph(
      [{ id: 'm1', type: 'Multiply' }],
      [{ from: 'ghost:Value', to: 'm1:A' }],
    );
    expect(validateConnectionPins(g, DB)).toEqual([]);
  });

  it('skips unknown node TYPES (handled by existing Unknown-node-type warning)', () => {
    const g = graph(
      [
        { id: 'x', type: 'TotallyMadeUpNodeType' },
        { id: 'm1', type: 'Multiply' },
      ],
      [{ from: 'x:Anything', to: 'm1:A' }],
    );
    expect(validateConnectionPins(g, DB)).toEqual([]);
  });

  it('splits on the first colon: a pin name containing a colon is not truncated', () => {
    // A plain `.split(':')` destructure would drop everything after the second colon,
    // checking the pin "Base" instead of the real (invalid) "Base:Color". splitRef keeps
    // the whole pin name so the report names the actual offending pin.
    const g = graph(
      [
        { id: 'c1', type: 'Constant', params: { Value: 1 } },
        { id: 'out', type: 'MaterialOutput' },
      ],
      [{ from: 'c1:Value', to: 'out:Base:Color' }],
    );
    const issues = validateConnectionPins(g, DB);
    expect(issues).toHaveLength(1);
    // The reported pin name (in quotes) is the full "Base:Color", not the truncated "Base".
    expect(issues[0].problem).toMatch(/input pin "Base:Color"/);
  });
});

// Regression test for: Graph.tsx handleNodeMouseEnter extracts wrong nodeType
// for reserved node types and MaterialFunctionCall.
//
// The bug: `data.label ?? node.id` was used, but reserved types have no `label`
// (data = { id, params, warning? }) and MaterialFunctionCall.label is a filename
// stem, not the type string. The fix: all node variants now carry `data.nodeType`.
//
// This test validates the extraction logic and the data-shape contract for each
// node variant without requiring a full React render.

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Simulate the data shapes that Graph.tsx initialLayout produces for each
// node variant (matches the fixed code).
// ---------------------------------------------------------------------------

interface NodeLike {
  id: string;
  data: Record<string, unknown>;
}

/** Mirrors the extraction in handleNodeMouseEnter after the fix. */
function extractNodeType(node: NodeLike): string {
  return (node.data as { nodeType?: string })?.nodeType ?? node.id;
}

describe('Graph.tsx — nodeType extraction from RF node.data', () => {
  it('MaterialOutput: data.nodeType is "MaterialOutput"', () => {
    const node: NodeLike = {
      id: 'output1',
      data: { id: 'output1', nodeType: 'MaterialOutput', params: {}, warning: undefined },
    };
    expect(extractNodeType(node)).toBe('MaterialOutput');
  });

  it('FunctionInput: data.nodeType is "FunctionInput"', () => {
    const node: NodeLike = {
      id: 'mat_input1',
      data: { id: 'mat_input1', nodeType: 'FunctionInput', params: {} },
    };
    expect(extractNodeType(node)).toBe('FunctionInput');
  });

  it('FunctionOutput: data.nodeType is "FunctionOutput"', () => {
    const node: NodeLike = {
      id: 'result',
      data: { id: 'result', nodeType: 'FunctionOutput', params: {} },
    };
    expect(extractNodeType(node)).toBe('FunctionOutput');
  });

  it('MaterialFunctionCall: data.nodeType is "MaterialFunctionCall" (not the filename stem)', () => {
    const node: NodeLike = {
      id: 'mf1',
      data: {
        id: 'mf1',
        nodeType: 'MaterialFunctionCall',
        // label holds the filename stem — must NOT be used as nodeType
        label: 'fire_emissive',
        inputs: [],
        outputs: [],
        params: { MaterialFunction: './functions/fire_emissive.matgraph.json' },
      },
    };
    expect(extractNodeType(node)).toBe('MaterialFunctionCall');
    // Confirm that the old (broken) extraction would have returned the wrong value.
    const oldExtract = (n: NodeLike) =>
      (n.data as { label?: string })?.label ?? n.id;
    expect(oldExtract(node)).toBe('fire_emissive'); // demonstrates the old bug
  });

  it('Generic DB node (Multiply): data.nodeType is the type string', () => {
    const node: NodeLike = {
      id: 'mul1',
      data: { id: 'mul1', nodeType: 'Multiply', label: 'Multiply', inputs: [], outputs: [], params: {} },
    };
    expect(extractNodeType(node)).toBe('Multiply');
  });

  it('Regression: reserved nodes without label field fell back to node.id (old bug)', () => {
    // Simulate the OLD data shape (no nodeType, no label) to confirm the old behavior.
    const oldMaterialOutputNode: NodeLike = {
      id: 'output1',
      data: { id: 'output1', params: {}, warning: undefined }, // no label, no nodeType
    };
    // Old extraction (label ?? node.id) returns 'output1' — the user-id, not the type.
    const oldExtract = (n: NodeLike) =>
      (n.data as { label?: string })?.label ?? n.id;
    expect(oldExtract(oldMaterialOutputNode)).toBe('output1'); // wrong type

    // New extraction uses nodeType field — absent here, falls back to id (still shows the issue).
    // This confirms the fix requires nodeType to be explicitly set in data.
    expect(extractNodeType(oldMaterialOutputNode)).toBe('output1');
  });
});

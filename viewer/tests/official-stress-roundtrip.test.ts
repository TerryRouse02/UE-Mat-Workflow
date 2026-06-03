import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseUET3D, graphToUET3D } from '../web/src/export/ueT3D';
import type { ExportMeta } from '../web/src/export/export-meta-types';
import type { DerivedPins } from '../web/src/protocol';

const META = JSON.parse(
  readFileSync(resolve(__dirname, '../../agent-pack/nodes-ue5.7.export.json'), 'utf-8'),
) as ExportMeta;
const ENGINE_MF = JSON.parse(
  readFileSync(resolve(__dirname, '../../agent-pack/enginemf-index-ue5.7.json'), 'utf-8'),
) as { functions: Record<string, { inputs: { name: string; type: string }[]; outputs: { name: string; type: string }[] }> };

const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures', name), 'utf-8');

// derivedPins for any MaterialFunctionCall, sourced from the committed engine index
// (what the server's mf-resolver supplies for /Engine/ MFs at runtime).
function engineDerived(graph: { nodes: { id: string; type: string; params?: Record<string, unknown> }[] }): Record<string, DerivedPins> {
  const dp: Record<string, DerivedPins> = {};
  for (const n of graph.nodes) {
    if (n.type !== 'MaterialFunctionCall') continue;
    const e = ENGINE_MF.functions[String(n.params?.MaterialFunction ?? '')];
    if (e) dp[n.id] = { inputs: e.inputs.map(p => ({ ...p })), outputs: e.outputs.map(p => ({ ...p })) };
  }
  return dp;
}

// Official-only UE 5.7 capture (see tools/node-t3d-metadata/docs/OFFICIAL_STRESS_FIXTURE.md).
describe('official stress fixture — direct material-output path', () => {
  const { graph, warnings } = parseUET3D(fixture('ue-official-stress.t3d'), META, { name: 'stress' });

  it('imports cleanly with no dropped wires', () => {
    expect(warnings).toEqual([]);
  });

  it('recovers the material output node and its wired root pins (收口)', () => {
    expect(graph.nodes.some(n => n.type === 'MaterialOutput')).toBe(true);
    const out = graph.connections.filter(c => c.to.startsWith('OUT:'));
    expect(out).toContainEqual({ from: 'LinearInterpolate_0:Result', to: 'OUT:BaseColor' });
    expect(out).toContainEqual({ from: 'Add_0:Result', to: 'OUT:Roughness' });
    // Normal comes through the Transform node — the exact wire that used to vanish.
    expect(out).toContainEqual({ from: 'Transform_0:Result', to: 'OUT:Normal' });
  });

  it('keeps the official multi-input MF wired to distinct plain-named pins', () => {
    const mfc = graph.connections.filter(c => c.to.startsWith('MaterialFunctionCall_0:'));
    expect(mfc.map(c => c.to.split(':')[1]).sort()).toEqual(['Rotation Angle (0-1)', 'UVs']);
  });

  it('re-exports the output via a synthesized MakeMaterialAttributes', () => {
    const layout = Object.fromEntries(graph.nodes.map(n => [n.id, { x: 0, y: 0 }]));
    const { text, warnings: ew } = graphToUET3D(graph, layout, META, engineDerived(graph));
    expect(text).toMatch(/MaterialExpressionMakeMaterialAttributes/);
    expect(ew.some(w => /auto-collected 3 attribute/.test(w))).toBe(true);
    // No collapse / unmapped-input warnings on the official content.
    expect(ew.filter(w => /defaulting to FunctionInputs\(0\)|has no pin mapping|not a standard attribute/.test(w))).toEqual([]);
  });
});

describe('official stress fixture — Use Material Attributes path', () => {
  const { graph, warnings } = parseUET3D(fixture('ue-official-stress-useattrs.t3d'), META, { name: 'stress-ua' });

  it('imports cleanly', () => {
    expect(warnings).toEqual([]);
  });

  it('recovers the root Material Attributes wire', () => {
    expect(graph.nodes.some(n => n.type === 'MaterialOutput')).toBe(true);
    expect(graph.connections).toContainEqual({ from: 'SetMaterialAttributes_1:MaterialAttributes', to: 'OUT:MaterialAttributes' });
  });

  it('exports with a Use-Material-Attributes hint and no empty synthesized collector', () => {
    const layout = Object.fromEntries(graph.nodes.map(n => [n.id, { x: 0, y: 0 }]));
    const { text, warnings: ew } = graphToUET3D(graph, layout, META, engineDerived(graph));
    expect(ew.some(w => /uses Material Attributes/.test(w))).toBe(true);
    // The only MakeMaterialAttributes in the output is the graph's own node, not an empty
    // synthesized OUT collector.
    expect(text).not.toMatch(/Name="OUT__MakeAttributes/);
  });
});

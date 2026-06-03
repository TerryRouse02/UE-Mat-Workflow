import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadGraph } from '../server/graph-loader';
import { parseUET3D, graphToUET3D } from '../web/src/export/ueT3D';
import type { ExportMeta } from '../web/src/export/export-meta-types';
import type { MatGraph } from '../web/src/protocol';

// ---------------------------------------------------------------------------
// Round-trip regression for the paste-safe "common nodes" stress material
// (graphs/stress_common/stress_common.matgraph.json).
//
// Unlike stress_all_nodes (an export-only artifact that crashes UE on paste),
// this material covers only common, stable authoring nodes and contains NO
// MaterialFunctionCall, so it is meant to be pasted into the UE 5.7 editor.
// We prove it locally by driving the real exporter + re-importer.
// ---------------------------------------------------------------------------

const REPO = resolve(__dirname, '../..');
const MATERIAL_PATH = resolve(REPO, 'graphs/stress_common/stress_common.matgraph.json');
const EXPORT_META_PATH = resolve(REPO, 'agent-pack/nodes-ue5.7.export.json');

const META = JSON.parse(readFileSync(EXPORT_META_PATH, 'utf-8')) as ExportMeta;

// Warning classes that signal a real authoring/wiring mistake: dropped wires,
// pins that don't map, MF fallbacks, non-standard output attrs, anything unmapped.
const BAD_WARNING = /wire dropped|has no pin mapping|defaulting to FunctionInputs|not a standard attribute|unmapped/;

async function buildExport() {
  const loaded = await loadGraph(MATERIAL_PATH);
  expect(loaded.errors, 'stress_common must be schema-valid').toEqual([]);
  const graph = loaded.graph as MatGraph;

  const layout = Object.fromEntries(
    graph.nodes.map((node, i) => [node.id, { x: (i % 12) * 240, y: Math.floor(i / 12) * 220 }]),
  );

  // No MaterialFunctionCall, so no derived-pin / engine-MF map is needed.
  const { text, warnings } = graphToUET3D(graph, layout, META, {});
  return { graph, layout, text, warnings };
}

describe('stress_common round-trip', () => {
  it('loads schema-valid with no errors', async () => {
    const loaded = await loadGraph(MATERIAL_PATH);
    expect(loaded.errors).toEqual([]);
    const graph = loaded.graph as MatGraph;
    // Sanity: a broad, paste-safe material with no MaterialFunctionCall.
    expect(graph.nodes.length).toBeGreaterThanOrEqual(35);
    expect(graph.nodes.some(n => n.type === 'MaterialFunctionCall')).toBe(false);
  });

  it('exports with no dropped-wire / unmapped-pin warnings', async () => {
    const { warnings } = await buildExport();
    const bad = warnings.filter(w => BAD_WARNING.test(w));
    expect(bad, `unexpected export warnings: ${JSON.stringify(bad)}`).toEqual([]);
  });

  it('funnels the output through a synthesized MakeMaterialAttributes (Use Material Attributes)', async () => {
    const { text, warnings } = await buildExport();
    expect(text).toMatch(/MaterialExpressionMakeMaterialAttributes/);
    expect(warnings.some(w => /auto-collected \d+ attribute\(s\) into MakeMaterialAttributes/.test(w))).toBe(true);
  });

  // A UE clipboard copy of a material selection never contains the root node — the
  // user makes one manual connection on paste (MakeMaterialAttributes Output -> the
  // material's Material Attributes root pin) and enables "Use Material Attributes".
  // We model exactly that single step here by splicing a MaterialGraphNode_Root that
  // links to the synthesized collector's Output pin, then re-import. This is the
  // faithful round-trip of the enforced Use-Material-Attributes funnel.
  function spliceMaterialAttributesRoot(text: string): string {
    // Locate the synthesized MakeMaterialAttributes graph-node block and its Output PinId.
    const blocks = text.split(/(?=Begin Object Class=\/Script\/UnrealEd\.MaterialGraphNode )/);
    const makeBlock = blocks.find(b => b.includes('MaterialExpressionMakeMaterialAttributes'));
    expect(makeBlock, 'export must contain a MakeMaterialAttributes graph node').toBeTruthy();
    const collectorNode = /Name="(MaterialGraphNode_\d+)"/.exec(makeBlock!)![1];
    const outputPinId = /PinId=([0-9A-Fa-f]{32}),PinName="Output"/.exec(makeBlock!)![1];

    const root = [
      '', // ensure the spliced block starts on its own line (export text has no trailing newline)
      'Begin Object Class=/Script/UnrealEd.MaterialGraphNode_Root Name="MaterialGraphNode_Root_0" ExportPath="/Script/UnrealEd.MaterialGraphNode_Root\'/Engine/Transient.UEMatWorkflowClipboard:MaterialGraph_0.MaterialGraphNode_Root_0\'"',
      '   NodePosX=400',
      '   NodeGuid=00000000000000000000000000000001',
      `   CustomProperties Pin (PinId=00000000000000000000000000000002,PinName="Material Attributes",LinkedTo=(${collectorNode} ${outputPinId},),)`,
      'End Object',
      '',
    ].join('\n');
    return text + root;
  }

  it('re-imports cleanly and recovers the Material Attributes root wire (收口)', async () => {
    const { text } = await buildExport();
    const withRoot = spliceMaterialAttributesRoot(text);
    const { graph, warnings } = parseUET3D(withRoot, META, { name: 'stress_common' });
    expect(warnings, `import warnings: ${JSON.stringify(warnings)}`).toEqual([]);

    // The root (收口) is recovered as a MaterialOutput node fed via a single
    // Material Attributes wire — the enforced Use-Material-Attributes output.
    expect(graph.nodes.some(n => n.type === 'MaterialOutput')).toBe(true);
    const rootWires = graph.connections.filter(c => c.to.startsWith('OUT:'));
    expect(rootWires.map(c => c.to.split(':')[1])).toEqual(['MaterialAttributes']);

    // The per-attribute authoring survives the round-trip onto the recovered
    // MakeMaterialAttributes collector (the funnel that feeds the root).
    const make = graph.nodes.find(n => n.type === 'MakeMaterialAttributes');
    expect(make, 'collector node should round-trip').toBeTruthy();
    // The single root wire is fed by that collector's MaterialAttributes output.
    expect(rootWires[0].from).toBe(`${make!.id}:MaterialAttributes`);
    const collectorInputs = new Set(
      graph.connections.filter(c => c.to.startsWith(`${make!.id}:`)).map(c => c.to.split(':')[1]),
    );
    for (const attr of ['BaseColor', 'Roughness', 'Metallic', 'Normal', 'EmissiveColor', 'AmbientOcclusion']) {
      expect(collectorInputs.has(attr), `expected something feeding ${make!.id}:${attr}`).toBe(true);
    }
  });
});

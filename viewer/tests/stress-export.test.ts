import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadGraph } from '../server/graph-loader';
import { resolveMaterialFunctions } from '../server/mf-resolver';
import { graphToUET3D } from '../web/src/export/ueT3D';
import type { ExportMeta } from '../web/src/export/export-meta-types';
import type { MatGraph, DerivedPins } from '../web/src/protocol';

// ---------------------------------------------------------------------------
// CI regression test for the multi-dimensional EXPORT stress material.
//
// This drives the REAL exporter (graphToUET3D) over the REAL stress graph
// (graphs/stress_all_nodes/stress_all_nodes.matgraph.json) with the REAL export
// metadata (agent-pack/nodes-ue5.7.export.json) and the REAL MF resolver,
// turning the hand-authored stress artifact into an executable regression guard.
//
// FIXED: Named Reroute linkage — every Declaration emits a stable VariableGuid and
// every Usage emits Declaration=/DeclarationGuid= (via the params.rerouteName
// convention), so a Usage resolves back to its Declaration.
//
// FIXED: the dynamic-pin nodes SetMaterialAttributes / GetMaterialAttributes /
// LandscapeLayerBlend now export against their real UE 5.7 clipboard fixtures
// (tests/fixtures/ue-{set,get}-material-attributes.t3d, ue-landscape-layer-blend.t3d).
// An attribute whose FGuid was never captured (Normal here for Set, EmissiveColor for
// Get) is dropped with a warning rather than invented — see material-attribute-guids.
// ---------------------------------------------------------------------------

const REPO = resolve(__dirname, '../..');
const MATERIAL_PATH = resolve(REPO, 'graphs/stress_all_nodes/stress_all_nodes.matgraph.json');
const EXPORT_META_PATH = resolve(REPO, 'agent-pack/nodes-ue5.7.export.json');
const FIXTURES = resolve(__dirname, 'fixtures');

const EXPORT_META = JSON.parse(readFileSync(EXPORT_META_PATH, 'utf-8')) as ExportMeta;

async function buildExport() {
  const loaded = await loadGraph(MATERIAL_PATH);
  expect(loaded.errors, 'stress material must be schema-valid').toEqual([]);
  const graph = loaded.graph as MatGraph;

  const resolved = await resolveMaterialFunctions(graph, dirname(MATERIAL_PATH));

  // Synthesize a deterministic layout for every node id (the exporter needs
  // positions but their exact values do not matter for these assertions).
  const layout = Object.fromEntries(
    graph.nodes.map((node, i) => [node.id, { x: (i % 24) * 240, y: Math.floor(i / 24) * 220 }]),
  );

  const { text, warnings } = graphToUET3D(
    graph,
    layout,
    EXPORT_META,
    resolved.derivedPins as Record<string, DerivedPins>,
  );
  return { graph, resolved, text, warnings };
}

const trimmedLines = (text: string) => text.split('\n').map(l => l.trim());

describe('stress_all_nodes export', () => {
  it('loads schema-valid and resolves its MaterialFunction without warnings', async () => {
    const { resolved } = await buildExport();
    expect(resolved.warnings, 'MF resolution should be clean').toEqual([]);
  });

  it('emits one MaterialGraphNode block per exportable expression', async () => {
    const { graph, text } = await buildExport();

    // Every node that is NOT a MaterialOutput now produces a MaterialGraphNode block
    // (the three dynamic-pin nodes are no longer skipped). The auto-collected
    // MakeMaterialAttributes adds one more block (the synthesized collector).
    const exportable = graph.nodes.filter(n => n.type !== 'MaterialOutput');
    const blocks = (text.match(/Begin Object Class=\/Script\/UnrealEd\.MaterialGraphNode /g) ?? []).length;

    // +1 synthesized MakeMaterialAttributes collector for the single MaterialOutput.
    expect(blocks).toBe(exportable.length + 1);

    // The MaterialOutput root itself is never serialized.
    expect(text).not.toContain('MaterialExpressionMaterialOutput');
  });

  it('emits the expected, intentional warning set (and nothing else)', async () => {
    const { warnings } = await buildExport();

    // Three "wired more than once" dedup warnings: two MaterialOutput pins
    // (BaseColor + EmissiveColor) collected into the synthesized node, plus one
    // ordinary node input (N_DoubleInput:A) deduped by the exporter.
    expect(warnings.filter(w => /wired more than once/.test(w))).toHaveLength(3);
    expect(warnings.some(w => /pin "BaseColor" wired more than once/.test(w))).toBe(true);
    expect(warnings.some(w => /pin "EmissiveColor" wired more than once/.test(w))).toBe(true);
    expect(warnings.some(w => /N_DoubleInput" input "A" wired more than once/.test(w))).toBe(true);

    // Two uncaptured-attribute drops: Set lists Normal, Get lists EmissiveColor — neither
    // has a captured GUID, so each is dropped with a warning (never invented).
    expect(warnings.filter(w => /has no captured GUID - dropped/.test(w))).toHaveLength(2);
    expect(warnings.some(w => /SetMaterialAttributes "N_SetMaterialAttributes": attribute "Normal" has no captured GUID/.test(w))).toBe(true);
    expect(warnings.some(w => /GetMaterialAttributes "N_GetMaterialAttributes": attribute "EmissiveColor" has no captured GUID/.test(w))).toBe(true);

    // The dynamic-pin nodes are now exported, so NOTHING is "not exportable yet" and
    // no wire is "dropped: source was not exported" (N_DynSink now resolves both inputs).
    expect(warnings.filter(w => /not exportable yet - skipped/.test(w))).toHaveLength(0);
    expect(warnings.filter(w => /dropped: source .* was not exported/.test(w))).toHaveLength(0);

    // The auto-collect guidance warning for the single MaterialOutput.
    expect(warnings.some(w => /auto-collected \d+ attribute\(s\) into MakeMaterialAttributes/.test(w))).toBe(true);

    // The local-MF auto-link reminder for MFC.
    expect(warnings.some(w => /MaterialFunctionCall "MFC".*auto-link/.test(w))).toBe(true);

    // No OTHER warning classes leaked in (e.g. unmapped pins, missing metadata).
    const unexpected = warnings.filter(w =>
      !/wired more than once/.test(w) &&
      !/has no captured GUID - dropped/.test(w) &&
      !/auto-collected \d+ attribute\(s\)/.test(w) &&
      !/auto-link/.test(w),
    );
    expect(unexpected, `unexpected warnings: ${JSON.stringify(unexpected)}`).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Float extremes -> plain decimals (UE's T3D parser rejects scientific form).
  // -------------------------------------------------------------------------
  it('formats float extremes as plain decimals, never scientific notation', async () => {
    const { text } = await buildExport();

    // No emitted numeric literal may use an exponent. JS scientific notation
    // always carries an explicit sign (1e-7 -> "1e-7", 1e21 -> "1e+21"), so we
    // require the `[eE][-+]` discriminator — that never matches hex GUIDs/PinIds
    // (which have `E` followed by a hex digit, never a sign).
    const sciLines = trimmedLines(text).filter(l => /\d[eE][-+]\d/.test(l));
    expect(sciLines, `scientific-notation literals leaked: ${JSON.stringify(sciLines)}`).toEqual([]);

    // The specific extreme constants round-trip as faithful plain decimals.
    const rLines = trimmedLines(text).filter(l => /^R=/.test(l));
    expect(rLines).toContain('R=0.0000001');                  // 1e-7
    expect(rLines).toContain('R=1000000000000000000000.0');   // 1e21
    expect(rLines).toContain('R=-0.0000000035');              // -3.5e-9
  });

  // -------------------------------------------------------------------------
  // Special-character escaping in Custom.Code / Description and comment text.
  // -------------------------------------------------------------------------
  it('escapes double-quotes, backslashes and newlines via quote()', async () => {
    const { text } = await buildExport();

    // Custom.Code: newlines -> \n, quotes -> \", backslash -> \\.
    expect(text).toContain(
      'Code="// \\"quoted\\" \\\\ backslash\\nfloat v = UV.x;\\nreturn float3(v, v, \\"0\\" == 0 ? 0.0 : v);"',
    );
    // Custom.Description with quotes + backslashes.
    expect(text).toContain('Description="Stress \\"Quoted\\" \\\\Back\\\\Slash Desc"');
    // A NamedRerouteDeclaration Name param with quotes + a backslash.
    expect(text).toContain('Name="RR \\"Quote\\"\\\\Slash"');
    // A comment whose text carries quotes + backslashes (Text= and NodeComment=).
    expect(text).toContain('Text="Named Reroute \\"stress\\" — decls + usages \\\\ heavy fan-out"');
    expect(text).toContain('NodeComment="Named Reroute \\"stress\\" — decls + usages \\\\ heavy fan-out"');

    // The raw (unescaped) multi-line Code source must NOT appear verbatim — proof
    // that quote() collapsed its real newlines into the escaped "\n" sequence.
    expect(text).not.toContain('// "quoted" \\ backslash\nfloat v = UV.x;');
  });

  // -------------------------------------------------------------------------
  // ComponentMask sub-channel outputs carry the right component mask suffix.
  // -------------------------------------------------------------------------
  it('emits per-channel masks for sub-channel outputs feeding the MaterialAttributes family', async () => {
    const { text } = await buildExport();
    const lines = trimmedLines(text);

    // Constant4Vector R output (index 2) -> single-R mask on the collector input.
    expect(lines.some(l => /^Metallic=\(Expression=.*Constant4Vector.*OutputIndex=2,Mask=1,MaskR=1\)$/.test(l))).toBe(true);
    // Constant4Vector RGB output (index 1) -> RGB mask.
    expect(lines.some(l => /^BaseColor=\(Expression=.*Constant4Vector.*OutputIndex=1,Mask=1,MaskR=1,MaskG=1,MaskB=1\)$/.test(l))).toBe(true);
  });

  // =========================================================================
  // Named Reroute linkage (FIXED).
  // =========================================================================
  it('[FIXED] emits a VariableGuid on every Named Reroute Declaration', async () => {
    const { graph, text } = await buildExport();

    // The material really does use Named Reroute heavily.
    const declCount = graph.nodes.filter(n => n.type === 'NamedRerouteDeclaration').length;
    const usageCount = graph.nodes.filter(n => n.type === 'NamedRerouteUsage').length;
    expect(declCount).toBeGreaterThanOrEqual(5);
    expect(usageCount).toBeGreaterThanOrEqual(8);

    // Declaration expressions are emitted (class + Name + Input)...
    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionNamedRerouteDeclaration');
    expect(text).toContain('Name="RR_Albedo"');
    expect(text).toMatch(/Input=\(Expression=MaterialExpressionConstant3Vector_\d+,OutputIndex=0\)/);

    // ...and each carries a stable VariableGuid (one per declaration) that a Usage
    // references to resolve back here.
    const guids = text.match(/VariableGuid=[0-9A-F]{32}/g) ?? [];
    expect(guids.length).toBe(declCount);
  });

  it('[FIXED] emits Declaration= + DeclarationGuid= on every Named Reroute Usage', async () => {
    const { text } = await buildExport();

    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionNamedRerouteUsage');
    expect(text).toMatch(/Declaration="\/Script\/Engine\.MaterialExpressionNamedRerouteDeclaration'[^']+'"/);
    expect(text).toMatch(/DeclarationGuid=[0-9A-F]{32}/);

    // The `rerouteName` convention field is CONSUMED to build the link, never
    // emitted verbatim into the T3D.
    expect(text).not.toContain('rerouteName');
  });

  it('[FIXED] every Usage DeclarationGuid matches a real Declaration VariableGuid', async () => {
    const { text } = await buildExport();
    const declGuids = new Set([...text.matchAll(/VariableGuid=([0-9A-F]{32})/g)].map(m => m[1]));
    const useGuids = [...text.matchAll(/DeclarationGuid=([0-9A-F]{32})/g)].map(m => m[1]);
    expect(declGuids.size).toBeGreaterThanOrEqual(5);
    expect(useGuids.length).toBeGreaterThanOrEqual(8);
    expect(useGuids.every(g => declGuids.has(g))).toBe(true);
    for (const m of text.matchAll(/Declaration=("[^"]+")/g)) {
      expect(m[1]).toContain("MaterialExpressionNamedRerouteDeclaration'");
    }
  });

  // =========================================================================
  // Dynamic-pin nodes (FIXED) — Set / Get / LandscapeLayerBlend, verified
  // against the real UE 5.7 clipboard fixtures the formats were built from.
  // =========================================================================

  // The captured attribute FGuids the emitter is allowed to use, read straight from
  // the fixtures so the constant table can never silently drift from ground truth.
  const fixtureGuids = (file: string, key: 'AttributeSetTypes' | 'AttributeGetTypes') =>
    new Set([...readFileSync(resolve(FIXTURES, file), 'utf-8')
      .matchAll(new RegExp(`${key}\\(\\d+\\)=([0-9A-F]{32})`, 'g'))].map(m => m[1]));

  it('[FIXED] SetMaterialAttributes emits Inputs + AttributeSetTypes matching the fixture', async () => {
    const { text } = await buildExport();
    const lines = trimmedLines(text);

    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionSetMaterialAttributes');
    // Inputs(0) is the base MaterialAttributes (fully-qualified ref, no InputName).
    expect(lines.some(l => /^Inputs\(0\)=\(Expression="\/Script\/Engine\.MaterialExpressionMakeMaterialAttributes'[^']+'"\)$/.test(l))).toBe(true);
    // Inputs(1) sets Base Color from a vector source: InputName before the RGB mask (fixture order).
    expect(lines.some(l => /^Inputs\(1\)=\(Expression="[^"]+",InputName="Base Color",Mask=1,MaskR=1,MaskG=1,MaskB=1\)$/.test(l))).toBe(true);
    // Scalar attributes carry an InputName but no mask.
    expect(lines).toContain('Inputs(2)=(Expression="/Script/Engine.MaterialExpressionOneMinus\'MaterialGraphNode_4.MaterialExpressionOneMinus_4\'",InputName="Roughness")');

    // Exactly three AttributeSetTypes (BaseColor, Roughness, Metallic) — Normal was dropped.
    const setTypes = [...text.matchAll(/AttributeSetTypes\(\d+\)=([0-9A-F]{32})/g)].map(m => m[1]);
    expect(setTypes).toEqual([
      '69B8D33616ED4D499AA497292F050F7A', // Base Color
      'D1DD967C4CAD47D39E6346FB08ECF210', // Roughness
      '57C3A1617F064296B00B24A5A496F34C', // Metallic
    ]);
    // ...and every emitted GUID is one really present in the captured fixture.
    const ground = fixtureGuids('ue-set-material-attributes.t3d', 'AttributeSetTypes');
    expect(setTypes.every(g => ground.has(g))).toBe(true);

    // The uncaptured attribute is genuinely absent (not invented under a guessed GUID).
    expect(text).not.toContain('InputName="Normal"');
  });

  it('[FIXED] GetMaterialAttributes emits MaterialAttributes + AttributeGetTypes + Outputs matching the fixture', async () => {
    const { text } = await buildExport();
    const lines = trimmedLines(text);

    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionGetMaterialAttributes');
    // The single MaterialAttributes input is a fully-qualified ref (here fed by the Set node).
    expect(lines.some(l => /^MaterialAttributes=\(Expression="\/Script\/Engine\.MaterialExpressionSetMaterialAttributes'[^']+'"\)$/.test(l))).toBe(true);

    // Two captured attributes (BaseColor, Roughness); EmissiveColor was dropped.
    const getTypes = [...text.matchAll(/AttributeGetTypes\(\d+\)=([0-9A-F]{32})/g)].map(m => m[1]);
    expect(getTypes).toEqual([
      '69B8D33616ED4D499AA497292F050F7A', // Base Color
      'D1DD967C4CAD47D39E6346FB08ECF210', // Roughness
    ]);
    const ground = fixtureGuids('ue-get-material-attributes.t3d', 'AttributeGetTypes');
    expect(getTypes.every(g => ground.has(g))).toBe(true);

    // Named outputs start at index 1 (index 0 is the MaterialAttributes pass-through).
    expect(lines).toContain('Outputs(1)=(OutputName="Base Color")');
    expect(lines).toContain('Outputs(2)=(OutputName="Roughness")');
    expect(text).not.toContain('OutputName="Emissive Color"');
    expect(text).not.toContain('AttributeGetTypes(2)='); // only two captured
  });

  it('[FIXED] LandscapeLayerBlend emits one Layers(i) struct per layer with Layer/Height inputs', async () => {
    const { text } = await buildExport();
    const lines = trimmedLines(text);

    expect(text).toContain('Begin Object Class=/Script/Landscape.MaterialExpressionLandscapeLayerBlend');

    // Three layers, including one whose name contains a space ("Rock Layer").
    expect(lines.some(l => /^Layers\(0\)=\(LayerName="Dirt",BlendType=LB_HeightBlend,LayerInput=\(Expression="[^"]+",Mask=1,MaskR=1,MaskG=1,MaskB=1\),HeightInput=\(Expression="[^"]+"\)\)$/.test(l))).toBe(true);
    expect(lines.some(l => /^Layers\(2\)=\(LayerName="Rock Layer",BlendType=LB_HeightBlend,/.test(l))).toBe(true);
    expect((text.match(/Layers\(\d+\)=\(LayerName=/g) ?? []).length).toBe(3);

    // The graph (internal) pin name "Layer Rock Layer" survives intact (split on first colon).
    expect(text).toContain('PinName="Layer Rock Layer"');
  });

  it('[FIXED] ordinary nodes fed by a dynamic node use a fully-qualified Expression ref', async () => {
    const { graph, text } = await buildExport();
    const lines = trimmedLines(text);

    // N_DynSink (an Add) is now fully wired: A from Get:BaseColor (output index 1),
    // B from LandscapeLayerBlend:Result (index 0). Both must be fully-qualified refs
    // (the dynamic source's pins are rebuilt on paste, so a bare ref would not resolve).
    expect(graph.nodes.some(n => n.id === 'N_DynSink')).toBe(true);
    expect(lines.some(l => /^A=\(Expression="\/Script\/Engine\.MaterialExpressionGetMaterialAttributes'[^']+'",OutputIndex=1\)$/.test(l))).toBe(true);
    expect(lines.some(l => /^B=\(Expression="\/Script\/Landscape\.MaterialExpressionLandscapeLayerBlend'[^']+'"\)$/.test(l))).toBe(true);

    // No Add fill object is left with both inputs missing (the old silent-drop symptom).
    const addStarts = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.startsWith('Begin Object Name="MaterialExpressionAdd_'));
    const dynSinkInputless = addStarts.some(({ i }) => {
      const end = lines.slice(i).findIndex(l => l === 'End Object');
      const body = lines.slice(i + 1, i + end);
      const hasGetA = body.some(l => /^A=\(Expression="[^"]*GetMaterialAttributes/.test(l));
      const hasBlendB = body.some(l => /^B=\(Expression="[^"]*LandscapeLayerBlend/.test(l));
      return hasGetA && hasBlendB;
    });
    expect(dynSinkInputless, 'N_DynSink should be the Add wired from Get + LayerBlend').toBe(true);
  });
});

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
// metadata (agent-pack/nodes-ue5.7.export.json) and the REAL MF resolver. It
// turning the hand-authored stress artifact into an executable regression guard.
//
// FIXED here: Named Reroute linkage — every Declaration now emits a stable
// VariableGuid and every Usage emits Declaration=/DeclarationGuid= (via the
// params.rerouteName convention), so a Usage resolves back to its Declaration.
//
// REMAINING gap (UE-capture-gated, P1): SetMaterialAttributes /
// GetMaterialAttributes / LandscapeLayerBlend are dynamicExport nodes still
// skipped with a warning (their exact T3D format needs a real UE capture). Any
// ordinary input fed by one of these now reports a "dropped" warning instead of
// vanishing silently.
// ---------------------------------------------------------------------------

const REPO = resolve(__dirname, '../..');
const MATERIAL_PATH = resolve(REPO, 'graphs/stress_all_nodes/stress_all_nodes.matgraph.json');
const EXPORT_META_PATH = resolve(REPO, 'agent-pack/nodes-ue5.7.export.json');

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

    // Every node that is NOT a MaterialOutput and NOT a dynamicExport-skipped
    // type should produce a MaterialGraphNode block. The auto-collected
    // MakeMaterialAttributes adds one more block (the synthesized collector).
    const SKIPPED = new Set(['SetMaterialAttributes', 'GetMaterialAttributes', 'LandscapeLayerBlend']);
    const exportable = graph.nodes.filter(n => n.type !== 'MaterialOutput' && !SKIPPED.has(n.type));
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

    // Exactly the three dynamic-pin nodes are skipped (dynamicExport, UE-capture-gated).
    for (const type of ['SetMaterialAttributes', 'GetMaterialAttributes', 'LandscapeLayerBlend']) {
      expect(warnings.some(w => new RegExp(`type ${type}\\) not exportable yet - skipped`).test(w))).toBe(true);
    }
    expect(warnings.filter(w => /not exportable yet - skipped/.test(w))).toHaveLength(3);

    // Both wires into N_DynSink (fed only by skipped dynamic nodes) are reported
    // as dropped rather than vanishing silently.
    expect(warnings.filter(w => /dropped: source .* was not exported/.test(w))).toHaveLength(2);
    expect(warnings.some(w => /N_DynSink" input "A" dropped: source "N_GetMaterialAttributes"/.test(w))).toBe(true);
    expect(warnings.some(w => /N_DynSink" input "B" dropped: source "N_LandscapeLayerBlend"/.test(w))).toBe(true);

    // The auto-collect guidance warning for the single MaterialOutput.
    expect(warnings.some(w => /auto-collected \d+ attribute\(s\) into MakeMaterialAttributes/.test(w))).toBe(true);

    // The local-MF auto-link reminder for MFC.
    expect(warnings.some(w => /MaterialFunctionCall "MFC".*auto-link/.test(w))).toBe(true);

    // No OTHER warning classes leaked in (e.g. unmapped pins, missing metadata).
    const unexpected = warnings.filter(w =>
      !/wired more than once/.test(w) &&
      !/not exportable yet - skipped/.test(w) &&
      !/dropped: source .* was not exported/.test(w) &&
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
  // P0 — NAMED REROUTE LINKAGE GAP (documented as CURRENT behavior).
  //
  // The exporter has NO special Named Reroute handling. It emits the generic
  // expression for each node, which is missing the fields UE needs to link a
  // Usage to its Declaration. We assert the CURRENT (broken) reality so a future
  // fix forces this test to be updated alongside it.
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

    // ...and now each carries a stable VariableGuid (one per declaration) that a
    // Usage references to resolve back here.
    const guids = text.match(/VariableGuid=[0-9A-F]{32}/g) ?? [];
    expect(guids.length).toBe(declCount);
  });

  it('[FIXED] emits Declaration= + DeclarationGuid= on every Named Reroute Usage', async () => {
    const { text } = await buildExport();

    // Usage expressions now link back to their Declaration by object path + guid.
    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionNamedRerouteUsage');
    expect(text).toMatch(/Declaration="\/Script\/Engine\.MaterialExpressionNamedRerouteDeclaration'[^']+'"/);
    expect(text).toMatch(/DeclarationGuid=[0-9A-F]{32}/);

    // The `rerouteName` convention field is CONSUMED to build the link, never
    // emitted verbatim into the T3D.
    expect(text).not.toContain('rerouteName');
  });

  it('[FIXED] a final-output attribute routed through a Usage resolves via a linked Usage', async () => {
    const { text } = await buildExport();

    // OUT:Metallic is wired from a NamedRerouteUsage; after auto-collect it lands
    // on the synthesized MakeMaterialAttributes' Metallic input, referencing the
    // Usage expression — which now carries a Declaration link, so Metallic resolves
    // correctly on paste instead of going null.
    expect(text).toMatch(/Metallic=\(Expression="\/Script\/Engine\.MaterialExpressionNamedRerouteUsage'[^']+'"\)/);
  });

  it('[FIXED] every Usage DeclarationGuid matches a real Declaration VariableGuid', async () => {
    const { text } = await buildExport();
    // Every usage's DeclarationGuid must be one of the declaration VariableGuids —
    // i.e. each usage resolves to a real declaration via the shared guid UE links on.
    const declGuids = new Set([...text.matchAll(/VariableGuid=([0-9A-F]{32})/g)].map(m => m[1]));
    const useGuids = [...text.matchAll(/DeclarationGuid=([0-9A-F]{32})/g)].map(m => m[1]);
    expect(declGuids.size).toBeGreaterThanOrEqual(5);
    expect(useGuids.length).toBeGreaterThanOrEqual(8);
    expect(useGuids.every(g => declGuids.has(g))).toBe(true);
    // And every Declaration= object path points at a NamedRerouteDeclaration expr.
    for (const m of text.matchAll(/Declaration=("[^"]+")/g)) {
      expect(m[1]).toContain("MaterialExpressionNamedRerouteDeclaration'");
    }
  });

  // =========================================================================
  // P1 — dynamicExport SKIP (Set/Get/LayerBlend) + silent downstream drop.
  // =========================================================================
  it('[GAP P1] skips SetMaterialAttributes / GetMaterialAttributes / LandscapeLayerBlend entirely', async () => {
    const { text } = await buildExport();
    // None of the three dynamic-pin classes appear in the output at all.
    expect(text).not.toContain('MaterialExpressionSetMaterialAttributes');
    expect(text).not.toContain('MaterialExpressionGetMaterialAttributes');
    expect(text).not.toContain('MaterialExpressionLandscapeLayerBlend');
  });

  it('[FIXED] warns (instead of silently dropping) when an input wire feeds from a skipped dynamic node', async () => {
    const { graph, text, warnings } = await buildExport();
    const lines = trimmedLines(text);

    // N_DynSink (an Add) is fed only by outputs of skipped dynamic nodes
    // (GetMaterialAttributes + LandscapeLayerBlend). The wires still cannot be
    // emitted (their sources aren't exportable), so the Add's fill object has no
    // A=/B= expression — but each dropped wire is now surfaced as a warning
    // instead of vanishing silently.
    expect(graph.nodes.some(n => n.id === 'N_DynSink')).toBe(true);

    const addFillStarts = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => l.startsWith('Begin Object Name="MaterialExpressionAdd_'));
    const hasInputlessAdd = addFillStarts.some(({ i }) => {
      const end = lines.slice(i).findIndex(l => l === 'End Object');
      const body = lines.slice(i + 1, i + end);
      return !body.some(l => /^A=\(Expression=/.test(l) || /^B=\(Expression=/.test(l));
    });
    expect(hasInputlessAdd, 'expected an Add fill object with both inputs dropped').toBe(true);

    // ...and both drops are now reported.
    expect(warnings.some(w => /N_DynSink" input "A" dropped: source "N_GetMaterialAttributes"/.test(w))).toBe(true);
    expect(warnings.some(w => /N_DynSink" input "B" dropped: source "N_LandscapeLayerBlend"/.test(w))).toBe(true);
  });
});

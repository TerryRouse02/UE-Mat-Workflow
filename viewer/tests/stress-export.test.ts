import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadGraph } from '../server/graph-loader';
import { resolveMaterialFunctions } from '../server/mf-resolver';
import { loadWorkMfIndex } from '../server/workmf-index';
import { graphToUET3D } from '../web/src/export/ueT3D';
import type { ExportMeta } from '../web/src/export/export-meta-types';
import type { MatGraph, DerivedPins } from '../web/src/protocol';
import { MATERIAL_ATTRIBUTE_GUIDS } from '../web/src/material-attribute-guids';

// ---------------------------------------------------------------------------
// CI regression test for the multi-dimensional EXPORT stress material.
//
// This drives the REAL exporter (graphToUET3D) over the REAL stress graph
// (graphs/stress_all_nodes/stress_all_nodes.matgraph.json) with the REAL export
// metadata (agent-pack/nodes-ue5.7.export.json) and the REAL MF resolver,
// turning the authored stress artifact into an executable regression guard.
//
// The graph covers EVERY authoring node definition in nodes-ue5.7.json plus ~26 official
// /Engine Material Functions (resolved from the committed enginemf-index) and one
// local sibling MaterialFunction. The MF resolver is given the engine index exactly
// as the server does, so official MFs resolve their pins.
//
// Named Reroute linkage: every Declaration emits a stable VariableGuid and every
// Usage emits Declaration=/DeclarationGuid= (via the params.rerouteName convention).
//
// Dynamic-pin nodes SetMaterialAttributes / GetMaterialAttributes / LandscapeLayerBlend
// export against their real UE 5.7 clipboard fixtures (tests/fixtures/ue-{set,get}-
// material-attributes.t3d, ue-landscape-layer-blend.t3d). An attribute whose FGuid is
// not in the effective table is dropped with a warning rather than invented; with the
// committed export.json materialAttributes map present, all attributes used here resolve.
// ---------------------------------------------------------------------------

const REPO = resolve(__dirname, '../..');
const MATERIAL_PATH = resolve(REPO, 'graphs/stress_all_nodes/stress_all_nodes.matgraph.json');
const EXPORT_META_PATH = resolve(REPO, 'agent-pack/nodes-ue5.7.export.json');
const NODE_DB_PATH = resolve(REPO, 'agent-pack/nodes-ue5.7.json');
const ENGINE_MF_INDEX_PATH = resolve(REPO, 'agent-pack/enginemf-index-ue5.7.json');
const FIXTURES = resolve(__dirname, 'fixtures');

const EXPORT_META = JSON.parse(readFileSync(EXPORT_META_PATH, 'utf-8')) as ExportMeta;
const NODE_DB = JSON.parse(readFileSync(NODE_DB_PATH, 'utf-8')) as { nodes: Record<string, unknown> };

// The effective attribute table, mirroring the exporter (buildAttributeTable): the full
// commandlet-generated map if export.json carries one, else the fixture-captured fallback
// (BaseColor/Roughness/Metallic). Keeping these assertions table-driven means they stay green
// whether or not export.json has a materialAttributes section.
const ATTR_TABLE: Record<string, { display: string; guid: string }> =
  EXPORT_META.materialAttributes && EXPORT_META.materialAttributes.length
    ? Object.fromEntries(EXPORT_META.materialAttributes.map(a => [a.name.replace(/\s+/g, ''), { display: a.name, guid: a.guid }]))
    : MATERIAL_ATTRIBUTE_GUIDS;
const hasAttr = (n: string) => n.replace(/\s+/g, '') in ATTR_TABLE;
const SET_ATTRS = ['BaseColor', 'Roughness', 'Metallic', 'Normal'];   // N_SetMaterialAttributes.params.AttributeNames
const GET_ATTRS = ['BaseColor', 'Roughness', 'EmissiveColor'];        // N_GetMaterialAttributes.params.AttributeNames
const droppedAttrs = [...SET_ATTRS, ...GET_ATTRS].filter(a => !hasAttr(a));
const UNSUPPORTED_DYNAMIC_TYPES = new Set(['MaterialCache', 'LandscapeGrassOutput', 'PhysicalMaterialOutput']);

async function buildExport() {
  const loaded = await loadGraph(MATERIAL_PATH);
  expect(loaded.errors, 'stress material must be schema-valid').toEqual([]);
  const graph = loaded.graph as MatGraph;

  // Give the resolver the committed engine-MF index, exactly as the server does, so the
  // ~26 official /Engine MaterialFunctionCalls resolve their pins instead of warning.
  const { index: engineMfIndex } = await loadWorkMfIndex(ENGINE_MF_INDEX_PATH);
  const resolved = await resolveMaterialFunctions(graph, dirname(MATERIAL_PATH), new Set(), { engineMfIndex });

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
  it('covers every node type in the DB plus official + local MaterialFunctions', async () => {
    const { graph } = await buildExport();
    const present = new Set(graph.nodes.map(n => n.type));
    const missing = Object.keys(NODE_DB.nodes).filter(t => !present.has(t));
    expect(missing, `node types missing from the stress material: ${JSON.stringify(missing)}`).toEqual([]);

    const mfc = graph.nodes.filter(n => n.type === 'MaterialFunctionCall');
    const engineMfc = mfc.filter(n => String((n.params as Record<string, unknown> | undefined)?.MaterialFunction ?? '').startsWith('/Engine'));
    const localMfc = mfc.filter(n => String((n.params as Record<string, unknown> | undefined)?.MaterialFunction ?? '').endsWith('.matgraph.json'));
    expect(engineMfc.length, 'should call a representative set of official /Engine MFs').toBeGreaterThanOrEqual(20);
    expect(localMfc.length, 'should keep at least one local sibling MF').toBeGreaterThanOrEqual(1);
  });

  it('loads schema-valid and resolves its MaterialFunctions without warnings', async () => {
    const { resolved } = await buildExport();
    expect(resolved.warnings, 'MF resolution should be clean (engine index supplies official MF pins)').toEqual([]);
  });

  it('emits one MaterialGraphNode block per exportable expression', async () => {
    const { graph, text } = await buildExport();

    // Every node except MaterialOutput and the explicitly unsupported per-instance
    // dynamic nodes produces a block. The synthesized collector adds one more.
    const exportable = graph.nodes.filter(n => n.type !== 'MaterialOutput' && !UNSUPPORTED_DYNAMIC_TYPES.has(n.type));
    const blocks = (text.match(/Begin Object Class=\/Script\/UnrealEd\.MaterialGraphNode /g) ?? []).length;
    expect(blocks).toBe(exportable.length + 1);

    // The MaterialOutput root itself is never serialized.
    expect(text).not.toContain('MaterialExpressionMaterialOutput');
  });

  it('emits no dangling LinkedTo pin references across the whole material', async () => {
    // Every LinkedTo=(GraphNode PinId) must reference a pin that actually exists on that
    // node. This is the at-scale guard for the MakeMaterialAttributes output-pin fix
    // (graph pin "MaterialAttributes" keyed for PinId, displayed as "Output").
    const { text } = await buildExport();
    const pinsByNode = new Map<string, Set<string>>();
    const refs: { node: string; pinId: string }[] = [];
    let current = '';
    for (const line of text.split('\n')) {
      const begin = /^Begin Object Class=\/Script\/UnrealEd\.MaterialGraphNode(?:_Comment)? Name="([^"]+)"/.exec(line.trim());
      if (begin) { current = begin[1]; pinsByNode.set(current, new Set()); continue; }
      const pin = /CustomProperties Pin \(PinId=([0-9A-Fa-f]+)/.exec(line);
      if (pin) pinsByNode.get(current)!.add(pin[1]);
      const linked = /LinkedTo=\(([^)]*)\)/.exec(line);
      if (linked) {
        for (const entry of linked[1].split(',').map(s => s.trim()).filter(Boolean)) {
          const [node, pinId] = entry.split(/\s+/);
          if (node && pinId) refs.push({ node, pinId });
        }
      }
    }
    const dangling = refs.filter(r => !pinsByNode.get(r.node)?.has(r.pinId));
    expect(dangling, `dangling LinkedTo references: ${JSON.stringify(dangling.slice(0, 10))}`).toEqual([]);
    expect(refs.length, 'the material should contain wired links').toBeGreaterThan(100);
  });

  it('emits the expected, intentional warning set (and nothing else)', async () => {
    const { warnings } = await buildExport();

    // Two "wired more than once" dedup warnings: the MaterialOutput BaseColor pin
    // (collected into the synthesized node) plus one ordinary node input (N_DoubleInput:A).
    expect(warnings.filter(w => /wired more than once/.test(w))).toHaveLength(2);
    expect(warnings.some(w => /pin "BaseColor" wired more than once/.test(w))).toBe(true);
    expect(warnings.some(w => /N_DoubleInput" input "A" wired more than once/.test(w))).toBe(true);

    // Every AttributeNames entry without a known GUID is dropped + warned (never invented).
    // With the committed export.json materialAttributes map present, all attributes used here
    // resolve, so this is zero; if the map were absent it would be the fixture-fallback set.
    expect(warnings.filter(w => /has no captured GUID - dropped/.test(w))).toHaveLength(droppedAttrs.length);
    for (const a of droppedAttrs) {
      expect(warnings.some(w => new RegExp(`attribute "${a}" has no captured GUID`).test(w)), `expected a drop warning for ${a}`).toBe(true);
    }

    // Custom and the three fixture-backed dynamic families export. The remaining
    // instance-dependent types are recorded in the DB but intentionally skipped until
    // they have dedicated per-instance exporters.
    const skipped = warnings.filter(w => /not exportable yet - skipped/.test(w));
    expect(skipped).toHaveLength(UNSUPPORTED_DYNAMIC_TYPES.size);
    for (const type of UNSUPPORTED_DYNAMIC_TYPES) {
      expect(skipped.some(w => w.includes(`type ${type}`)), `expected ${type} to be explicitly skipped`).toBe(true);
    }
    expect(warnings.filter(w => /dropped: source .* was not exported/.test(w))).toHaveLength(0);

    // The auto-collect guidance warning for the single MaterialOutput.
    expect(warnings.some(w => /auto-collected \d+ attribute\(s\) into MakeMaterialAttributes/.test(w))).toBe(true);

    // The local-MF auto-link reminder (fires only for the non-/Engine sibling MF path).
    expect(warnings.filter(w => /auto-link/.test(w))).toHaveLength(1);

    // No OTHER warning classes leaked in (e.g. unmapped pins, missing metadata, MF-not-in-index).
    const unexpected = warnings.filter(w =>
      !/wired more than once/.test(w) &&
      !/has no captured GUID - dropped/.test(w) &&
      !/not exportable yet - skipped/.test(w) &&
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

    // No emitted numeric literal may use an exponent. JS scientific notation always carries
    // an explicit sign (1e-7 -> "1e-7", 1e21 -> "1e+21"), so the `[eE][-+]` discriminator
    // never matches hex GUIDs/PinIds (which have `E` followed by a hex digit, never a sign).
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
  // Channel-named outputs feeding the MaterialAttributes family carry the right
  // component mask. (Single-channel masks, e.g. MaskR only, are covered against the
  // real UE fixture in ueT3D.test.ts; here we assert the multi-channel RGB case.)
  // -------------------------------------------------------------------------
  it('emits per-channel masks for channel outputs feeding the MaterialAttributes family', async () => {
    const { text } = await buildExport();
    const lines = trimmedLines(text);
    // An RGB (Float3) source into a MaterialAttributes-family input -> full RGB mask.
    expect(lines.some(l => /Mask=1,MaskR=1,MaskG=1,MaskB=1\)$/.test(l))).toBe(true);
  });

  // =========================================================================
  // Named Reroute linkage.
  // =========================================================================
  it('emits a VariableGuid on every Named Reroute Declaration', async () => {
    const { graph, text } = await buildExport();

    const declCount = graph.nodes.filter(n => n.type === 'NamedRerouteDeclaration').length;
    const usageCount = graph.nodes.filter(n => n.type === 'NamedRerouteUsage').length;
    expect(declCount).toBeGreaterThanOrEqual(5);
    expect(usageCount).toBeGreaterThanOrEqual(8);

    // Declaration expressions are emitted (class + Name + Input)...
    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionNamedRerouteDeclaration');
    expect(text).toContain('Name="RR_Albedo"');
    expect(text).toMatch(/Input=\(Expression=MaterialExpression\w+,OutputIndex=0\)/);

    // ...and each carries a stable VariableGuid (one per declaration).
    const guids = text.match(/VariableGuid=[0-9A-F]{32}/g) ?? [];
    expect(guids.length).toBe(declCount);
  });

  it('emits Declaration= + DeclarationGuid= on every Named Reroute Usage', async () => {
    const { text } = await buildExport();

    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionNamedRerouteUsage');
    expect(text).toMatch(/Declaration="\/Script\/Engine\.MaterialExpressionNamedRerouteDeclaration'[^']+'"/);
    expect(text).toMatch(/DeclarationGuid=[0-9A-F]{32}/);

    // The `rerouteName` convention field is CONSUMED to build the link, never emitted verbatim.
    expect(text).not.toContain('rerouteName');
  });

  it('every Usage DeclarationGuid matches a real Declaration VariableGuid', async () => {
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
  // Dynamic-pin nodes — Set / Get / LandscapeLayerBlend, verified against the
  // real UE 5.7 clipboard fixtures the formats were built from.
  // =========================================================================

  // The captured attribute FGuids the emitter is allowed to use, read straight from
  // the fixtures so the constant table can never silently drift from ground truth.
  const fixtureGuids = (file: string, key: 'AttributeSetTypes' | 'AttributeGetTypes') =>
    new Set([...readFileSync(resolve(FIXTURES, file), 'utf-8')
      .matchAll(new RegExp(`${key}\\(\\d+\\)=([0-9A-F]{32})`, 'g'))].map(m => m[1]));

  it('SetMaterialAttributes emits Inputs + AttributeSetTypes matching the fixture', async () => {
    const { text } = await buildExport();
    const lines = trimmedLines(text);

    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionSetMaterialAttributes');
    // Inputs(0) is the base MaterialAttributes (fully-qualified ref, no InputName).
    expect(lines.some(l => /^Inputs\(0\)=\(Expression="\/Script\/Engine\.MaterialExpressionMakeMaterialAttributes'[^']+'"\)$/.test(l))).toBe(true);
    // Inputs(1) sets Base Color from a vector source: InputName before the RGB mask (fixture order).
    const bcName = ATTR_TABLE['BaseColor'].display;
    expect(lines.some(l => new RegExp(`^Inputs\\(1\\)=\\(Expression="[^"]+",InputName="${bcName}",Mask=1,MaskR=1,MaskG=1,MaskB=1\\)$`).test(l))).toBe(true);
    // A scalar attribute (Roughness) carries an InputName, sourced from a fully-qualified ref.
    const rName = ATTR_TABLE['Roughness'].display;
    expect(lines.some(l => new RegExp(`^Inputs\\(\\d+\\)=\\(Expression="[^"]+",InputName="${rName}"\\)$`).test(l))).toBe(true);

    // One AttributeSetTypes per emitted attribute; BaseColor/Roughness/Metallic lead in order.
    const setEmitted = SET_ATTRS.filter(hasAttr);
    const setTypes = [...text.matchAll(/AttributeSetTypes\(\d+\)=([0-9A-F]{32})/g)].map(m => m[1]);
    expect(setTypes).toHaveLength(setEmitted.length);
    expect(setTypes.slice(0, 3)).toEqual([
      '69B8D33616ED4D499AA497292F050F7A', // Base Color
      'D1DD967C4CAD47D39E6346FB08ECF210', // Roughness
      '57C3A1617F064296B00B24A5A496F34C', // Metallic
    ]);
    // ...and those three are GUIDs really present in the captured fixture (ground truth).
    const ground = fixtureGuids('ue-set-material-attributes.t3d', 'AttributeSetTypes');
    expect(setTypes.slice(0, 3).every(g => ground.has(g))).toBe(true);

    // Normal is exported iff its GUID is in the effective table — dropped, never invented, otherwise.
    expect(text.includes('InputName="Normal"')).toBe(hasAttr('Normal'));
  });

  it('GetMaterialAttributes emits MaterialAttributes + AttributeGetTypes + Outputs matching the fixture', async () => {
    const { text } = await buildExport();
    const lines = trimmedLines(text);

    expect(text).toContain('Begin Object Class=/Script/Engine.MaterialExpressionGetMaterialAttributes');
    // The single MaterialAttributes input is a fully-qualified ref (here fed by the Set node).
    expect(lines.some(l => /^MaterialAttributes=\(Expression="\/Script\/Engine\.MaterialExpressionSetMaterialAttributes'[^']+'"\)$/.test(l))).toBe(true);

    // One AttributeGetTypes per emitted attribute; BaseColor/Roughness lead in order.
    const getEmitted = GET_ATTRS.filter(hasAttr);
    const getTypes = [...text.matchAll(/AttributeGetTypes\(\d+\)=([0-9A-F]{32})/g)].map(m => m[1]);
    expect(getTypes).toHaveLength(getEmitted.length);
    expect(getTypes.slice(0, 2)).toEqual([
      '69B8D33616ED4D499AA497292F050F7A', // Base Color
      'D1DD967C4CAD47D39E6346FB08ECF210', // Roughness
    ]);
    const ground = fixtureGuids('ue-get-material-attributes.t3d', 'AttributeGetTypes');
    expect(getTypes.slice(0, 2).every(g => ground.has(g))).toBe(true);

    // Named outputs start at index 1 (index 0 is the MaterialAttributes pass-through).
    expect(lines).toContain(`Outputs(1)=(OutputName="${ATTR_TABLE['BaseColor'].display}")`);
    expect(lines).toContain(`Outputs(2)=(OutputName="${ATTR_TABLE['Roughness'].display}")`);
    // EmissiveColor's output (a third AttributeGetTypes) appears iff its GUID is captured.
    expect(text.includes('AttributeGetTypes(2)=')).toBe(hasAttr('EmissiveColor'));
  });

  it('LandscapeLayerBlend emits one Layers(i) struct per layer with Layer/Height inputs', async () => {
    const { text } = await buildExport();
    const lines = trimmedLines(text);

    expect(text).toContain('Begin Object Class=/Script/Landscape.MaterialExpressionLandscapeLayerBlend');

    // Three layers. Dirt is a height blend (has both LayerInput and HeightInput).
    expect(lines.some(l => /^Layers\(0\)=\(LayerName="Dirt",BlendType=LB_HeightBlend,.*LayerInput=\(Expression="[^"]+",Mask=1,MaskR=1,MaskG=1,MaskB=1\),HeightInput=\(Expression="[^"]+"\)/.test(l))).toBe(true);
    // "Rock Layer" (name with a space) is a weight blend: present, with NO HeightInput.
    expect(lines.some(l => /^Layers\(2\)=\(LayerName="Rock Layer",BlendType=LB_WeightBlend,(?!.*HeightInput)/.test(l))).toBe(true);
    expect((text.match(/Layers\(\d+\)=\(LayerName=/g) ?? []).length).toBe(3);

    // The graph (internal) pin name "Layer Rock Layer" survives intact (split on first colon).
    expect(text).toContain('PinName="Layer Rock Layer"');
  });

  it('ordinary nodes fed by a dynamic node use a fully-qualified Expression ref', async () => {
    const { text } = await buildExport();
    const lines = trimmedLines(text);

    // A consumer fed by GetMaterialAttributes:<attr> (output index >= 1, since index 0 is the
    // MaterialAttributes pass-through) must use a fully-qualified Expression ref — the dynamic
    // source's pins are rebuilt on paste, so a bare ref would not resolve.
    expect(lines.some(l => /^[AB]=\(Expression="\/Script\/Engine\.MaterialExpressionGetMaterialAttributes'[^']+'",OutputIndex=[1-9]\d*\)$/.test(l))).toBe(true);
    // A consumer fed by LandscapeLayerBlend:Result (output index 0) — fully-qualified, no index.
    expect(lines.some(l => /^[AB]=\(Expression="\/Script\/Landscape\.MaterialExpressionLandscapeLayerBlend'[^']+'"\)$/.test(l))).toBe(true);
  });
});

# Codex hand-off — Phase 2: paste our export back into UE (reverse round-trip check)

**Goal.** Confirm the tool's **export** (matgraph → UE T3D) pastes back into a
fresh UE 5.7 material with **zero broken links** and reconstructs the graph we
captured in Phase 1. This closes the loop: Phase 1 proved UE→tool import; this
proves tool→UE export. **English editor only.**

## What to paste

Two tool-generated clipboard files are committed (deterministic output of the
current importer+exporter run over the Phase-1 fixtures):

- `tools/node-t3d-metadata/fixtures/roundtrip/M_OfficialStress_RoundTrip.t3d`
  (the direct material-output material)
- `tools/node-t3d-metadata/fixtures/roundtrip/M_OfficialStress_UseAttrs_RoundTrip.t3d`
  (the Use Material Attributes material)

These are plain UE clipboard T3D. Copy the **entire file contents** to the
clipboard and paste into the UE Material Editor graph (Ctrl+V).

> If you'd rather regenerate them yourself instead of trusting the committed
> copy, they are produced by importing the Phase-1 fixtures and re-exporting via
> `viewer/web/src/export/ueT3D.ts` (`parseUET3D` then `graphToUET3D`, with
> MaterialFunctionCall derivedPins taken from `agent-pack/enginemf-index-ue5.7.json`).
> Either way the paste target and checklist below are the same.

## Procedure (per file)

1. New Material in UE 5.7 (English editor), open the Material Editor.
2. Paste the file's T3D into the graph.
3. **One documented manual step** (the root node can't travel on the clipboard):
   - **Direct file:** find the pasted **MakeMaterialAttributes** node, connect its
     **Output** to the material root's **Material Attributes** pin, and enable
     **Use Material Attributes** on the material. (Our exporter prints this exact
     instruction as a warning; it is by design, one connection total.)
   - **UseAttrs file:** find the terminal **SetMaterialAttributes** node, connect
     its output to the root's **Material Attributes** pin, and enable **Use
     Material Attributes**.
4. Run the checklist; capture a screenshot of the pasted graph.

## Pass/fail checklist — Direct file (`M_OfficialStress_RoundTrip`)

Expect ~14 expression nodes + the MakeMaterialAttributes. Verify:

- [ ] No nodes paste with **orphaned/red input pins** (every wire below lands).
- [ ] **Transform** node has its **Input** wired (from a Constant). *(This is the
      `Input` vs `VectorInput` fix — the input must NOT be empty.)*
- [ ] **CustomRotator** (MaterialFunctionCall) has **two distinct inputs** wired:
      **UVs** (from TextureCoordinate) and **Rotation Angle (0-1)** (from a
      Constant). *(The MF-pin-suffix fix — they must not both collapse onto the
      first input.)*
- [ ] **TextureSample**, **Multiply**, **Lerp**, **Add** chain is intact.
- [ ] The **Named Reroute** Usage still resolves to its Declaration (no "unlinked
      reroute" warning).
- [ ] The **Comment** box pasted.
- [ ] After the one manual connection, **MakeMaterialAttributes** feeds the root:
      BaseColor ← Lerp, Roughness ← Add, **Normal ← Transform**.
- [ ] Material **compiles** (no shader errors).

## Pass/fail checklist — UseAttrs file (`M_OfficialStress_UseAttrs_RoundTrip`)

Expect ~9 nodes. Verify:

- [ ] **GetMaterialAttributes** and **SetMaterialAttributes** nodes paste with
      their attribute pins wired (BaseColor / Roughness / Normal etc.), no
      orphaned pins.
- [ ] The Multiply/Add tweak chain between Get and Set is intact.
- [ ] After connecting the terminal SetMaterialAttributes → root and enabling Use
      Material Attributes, the material **compiles**.

## What to report back

For each file: the checklist with pass/fail, a screenshot, and — if anything is
broken — the exact node + pin that failed and what it should have been. A broken
item points at a specific exporter bug we can then fix against the same fixture.

## Note (carried over from Phase 1)

If you looked into why the reflection commandlet reported Transform's input as
`VectorInput` (it should be `Input`), include the finding — if the extraction is
wrong for a *class* of nodes, list them so we can correct the metadata at the
source instead of one entry at a time.

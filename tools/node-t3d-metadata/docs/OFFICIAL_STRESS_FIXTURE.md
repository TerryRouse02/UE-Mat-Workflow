# Codex hand-off — build the official-only round-trip stress material

**Goal.** Produce one small UE 5.7 material, built **only from official engine
nodes + official `/Engine/Functions` Material Functions**, exported as T3D, to be
committed as the ground-truth fixture for import↔export round-trip tests
(including the material-output "收口" path). Keep it small (~15–25 nodes) so it
pastes back into UE without crashing.

This fixture is what lets us prove the official path round-trips losslessly and,
in phase 2, that our tool's *export* pastes back into UE with zero broken links.

## Hard constraints

1. **Official content only.** No `/Game/...` assets. Every MaterialFunctionCall
   must reference an `/Engine/Functions/...` MF that exists in
   `agent-pack/enginemf-index-ue5.7.json`. No custom/project nodes.
2. **English editor locale.** Set the editor language to English before copying,
   so material-output and pin names come out as `BaseColor`/`Normal`/… (not
   localized). Localization is a separate task; this fixture must be locale-clean.
3. **UE 5.7**, default (non-Substrate) material is fine.
4. Keep it compact — no giant subgraphs. One screen of nodes.

## Required coverage (each maps to a bug we just fixed or a gap we must verify)

Include at least one of each, wired so the wires actually carry data:

- **Transform** (Vector Transform) — input fed by something; output used.
  (Regression for the `Input` vs `VectorInput` property fix.)
- **A multi-input official MF**, e.g. `CustomRotator`
  (`/Engine/Functions/Engine_MaterialFunctions02/Texturing/CustomRotator.CustomRotator`)
  with **at least two inputs wired** (e.g. `UVs` and `Rotation Angle (0-1)`).
  (Regression for MF pin-name type-suffix collapse.)
- **GetMaterialAttributes** and **SetMaterialAttributes** with a couple of
  attributes each (BaseColor / Roughness / Normal).
- **An anonymous reroute (Knot)** on one wire, plus **a Named Reroute**
  (Declaration + Usage) on another.
- **A Comment box** grouping a few nodes.
- Standard math/texture nodes to pad it out (Multiply, Lerp, TextureSample…).

## The output "收口" — wire BOTH paths

This is the part we most need ground truth for:

1. **Direct path:** wire results straight into the main material node's pins
   (e.g. `BaseColor`, `Roughness`, `Normal`).
2. **Use Material Attributes path:** in a second copy (or a clearly separated
   region), enable **Use Material Attributes** on the material and feed the root's
   single **Material Attributes** pin from a `SetMaterialAttributes` chain.

If one material can't show both cleanly, make **two** small materials and export
two fixtures (`*_direct.t3d`, `*_useattrs.t3d`).

## How to export

1. Build the graph in the UE 5.7 Material Editor.
2. **Select all** nodes (Ctrl+A) including the main output node.
3. **Copy** (Ctrl+C).
4. Paste the clipboard text into a file and commit it (see below). Do **not**
   hand-edit the T3D.

## Where to put it

- Commit the raw T3D as a test fixture:
  `viewer/tests/fixtures/ue-official-stress.t3d`
  (and `ue-official-stress-useattrs.t3d` if you split it).
- Add a one-line note in the PR/commit body listing the exact official MF asset
  paths used, so we can confirm they're all in `enginemf-index-ue5.7.json`.

## While you're in UE — quick reflection sanity check (optional but valuable)

The export-metadata commandlet previously reported
`UMaterialExpressionTransform`'s input as **`VectorInput`**, but the real
serialized clipboard property is **`Input`** (we just corrected the committed
metadata by hand). Please confirm from reflection what name the commandlet
extracts for `Transform`'s `FExpressionInput`, and whether any **other** node's
input-name extraction disagrees with its T3D `=(Expression=…)` property key. If
the commandlet's extraction is systematically off for a class of nodes, capture
which ones — that's a metadata-source bug, not a per-node typo.

## Phase 2 (after we wire the fixture into tests)

We'll hand you our tool's **export** of the same graph and ask you to paste it
back into a fresh UE material and confirm: no broken links, no orphaned pins,
the output node connects, and (for the attributes path) "Use Material Attributes"
is set. That closes the loop on "perfect official round-trip".

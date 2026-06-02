# UE Material Workflow

**HARD RULE — ASK THE UE VERSION FIRST.** Before authoring or editing ANY material graph, you MUST ask the user which UE version they are targeting, and confirm that version is supported (a `nodes-ue<version>.json` DB pair exists in `agent-pack/`). Do not write any `.matgraph.json` until the UE version is confirmed and supported. Set the graph's `ueVersion` to that confirmed version. The node DB is version-scoped (`nodes-ue<major.minor>.json` + `nodes-ue<major.minor>.export.json`); read the pair that matches the confirmed version.

When asked to design or modify a UE5 material, follow the spec:

@SPEC.md
@nodes-ue5.7.json

Examples: @examples/01_basic_pbr/01_basic_pbr.matgraph.json, @examples/02_with_function/02_with_function.matgraph.json

Write output to `graphs/<project>/`: one folder per project, containing the Material and any MaterialFunctions it uses. By convention the folder name matches the material name.

**Material Functions:** if a material calls an MF by UE asset path, look it up under `functions[<assetPath>]` and use its `inputs[].name` / `outputs[].name` for connections — same rule as built-in pin names. Official `/Engine/...` MFs live in the committed `agent-pack/enginemf-index-ue5.7.json`; the user's own `/Game/...` MFs in `agent-pack/workmf-index.json`. If it isn't in the matching index, stop and ask the user to run the matching crawl (Engine MF for `/Engine/...`, WorkMF for `/Game/...`); don't invent pin names. Full rule in SPEC.md → "Work-project Material Functions".

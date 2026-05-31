# UE Material Workflow

**HARD RULE — ASK THE UE VERSION FIRST.** Before authoring or editing ANY material graph, you MUST ask the user which UE version they are targeting, and confirm that version is supported (a `nodes-ue<version>.json` DB pair exists in `agent-pack/`). Do not write any `.matgraph.json` until the UE version is confirmed and supported. Set the graph's `ueVersion` to that confirmed version. The node DB is version-scoped (`nodes-ue<major.minor>.json` + `nodes-ue<major.minor>.export.json`); read the pair that matches the confirmed version.

When asked to design or modify a UE5 material, follow the spec:

@SPEC.md
@nodes-ue5.7.json

Examples: @examples/01_basic_pbr/01_basic_pbr.matgraph.json, @examples/02_with_function/02_with_function.matgraph.json

Write output to `graphs/<project>/`: one folder per project, containing the Material and any MaterialFunctions it uses. By convention the folder name matches the material name.

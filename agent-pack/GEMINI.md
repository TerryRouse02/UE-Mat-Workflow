# UE Material Workflow

**HARD RULE — ASK THE UE VERSION FIRST.** Before authoring or editing ANY material graph, you MUST ask the user which UE version they are targeting, and confirm that version is supported (a `nodes-ue<version>.json` DB pair exists in `agent-pack/`). Do not write any `.matgraph.json` until the UE version is confirmed and supported. Set the graph's `ueVersion` to that confirmed version.

For UE5 material tasks: read `agent-pack/SPEC.md` and the version-matched DB pair `agent-pack/nodes-ue<version>.json` (+ `nodes-ue<version>.export.json`) first. Write `.matgraph.json` files to `graphs/<project>/` per the spec (one folder per project: Material + its MFs).

**Material Functions:** if a material calls an MF by UE asset path, look it up under `functions[<assetPath>]` and use its `inputs[].name` / `outputs[].name` for connections — official `/Engine/...` MFs in the committed `agent-pack/enginemf-index-ue5.7.json`, the user's own `/Game/...` MFs in `agent-pack/workmf-index.json`. If it isn't in the matching index, stop and ask the user to run the matching crawl (Engine MF for `/Engine/...`, WorkMF for `/Game/...`) — don't invent pin names. See SPEC.md → "Work-project Material Functions".

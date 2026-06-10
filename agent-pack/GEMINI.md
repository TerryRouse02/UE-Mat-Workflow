# UE Material Workflow

**HARD RULE — ASK THE UE VERSION FIRST.** Before authoring or editing ANY material graph, you MUST ask the user which UE version they are targeting, and confirm that version is supported (a `nodes-ue<version>.index.json` exists in `agent-pack/`). Do not write any `.matgraph.json` until the UE version is confirmed and supported. Set the graph's `ueVersion` to that confirmed version.

For UE5 material tasks: read `agent-pack/SPEC.md` and use the progressive-disclosure protocol below first. Write `.matgraph.json` files to `graphs/<project>/` per the spec (one folder per project: Material + its MFs).

**NEVER read `nodes-ue*.json`, `nodes-ue*.export.json`, or `enginemf-index-ue*.json` wholesale — they are 45K–120K tokens each.** `nodes-ue*.export.json` is consumed by the viewer's export/import code only; an authoring agent never needs it. MF indexes are point-query only.

**Node DB — progressive-disclosure protocol:**

1. Read `agent-pack/nodes-ue<version>.index.json` (~12K tokens) to choose nodes.
2. For nodes you will use, run `node agent-pack/query.js node <version> <Name> [<Name> ...]` to fetch full entries (inputs, outputs, params).
3. For MF asset paths, run `node agent-pack/query.js mf "<assetPath>"` to get pin signatures.

**Material Functions:** if a material calls an MF by UE asset path, use `node agent-pack/query.js mf "<assetPath>"` to get its `inputs[].name` / `outputs[].name` for connections — official `/Engine/...` MFs are in the engine MF index; the user's own `/Game/...` MFs are in `workmf-index.json`. If the query returns "not found", stop and ask the user to run the matching crawl (Engine MF for `/Engine/...`, WorkMF for `/Game/...`) — don't invent pin names. See SPEC.md → "Work-project Material Functions".

# UE Material Workflow

**HARD RULE — ASK THE UE VERSION FIRST.** Before authoring or editing ANY material graph, you MUST ask the user which UE version they are targeting, and confirm that version is supported (a `nodes-ue<version>.index.json` exists in `agent-pack/`). Do not write any `.matgraph.json` until the UE version is confirmed and supported. Set the graph's `ueVersion` to that confirmed version.

When asked to design or modify a UE5 material, follow the spec:

@SPEC.md

## How to read the node DB (token discipline)

**NEVER read `nodes-ue*.json`, `nodes-ue*.export.json`, or `enginemf-index-ue*.json` wholesale.** These files are 45K–120K tokens each and must never be loaded in full. `nodes-ue*.export.json` is consumed exclusively by the viewer's export/import code — an authoring agent never needs it. MF indexes are point-query only.

Use the three-step progressive-disclosure protocol instead:

1. **Choose nodes** — read `agent-pack/nodes-ue<version>.index.json` (~12K tokens, safe to read whole). It lists every node name with category, one-line description, and flags (`verified`, `dynamicPins`, `deprecated`). Use it to decide which nodes fit the design.
2. **Fetch full entries** — for any node you will actually use, run:
   `node agent-pack/query.js node <version> <Name> [<Name> ...]`
   This prints the full DB entry (inputs, outputs, params, pinInfo) for exactly those nodes — only what you need.
3. **Look up Material Functions** — for any `/Engine/...` or `/Game/...` MF asset path, run:
   `node agent-pack/query.js mf "<assetPath>"`
   This returns the MF's pin signature from the matching index.

Write output to `graphs/<project>/`: one folder per project, containing the Material and any MaterialFunctions it uses. By convention the folder name matches the material name.

**Material Functions:** if a material calls an MF by UE asset path, use `node agent-pack/query.js mf "<assetPath>"` to get its `inputs[].name` / `outputs[].name` for connections — official `/Engine/...` MFs are in `enginemf-index-ue5.7.json`; the user's own `/Game/...` MFs are in `workmf-index.json`. If the query returns "not found", stop and ask the user to run the matching crawl (Engine MF for `/Engine/...`, WorkMF for `/Game/...`); don't invent pin names. Full rule in SPEC.md → "Work-project Material Functions".

# UE Material Workflow

**HARD RULE — ASK THE UE VERSION FIRST.** Before authoring or editing ANY material graph, you MUST ask the user which UE version they are targeting, and confirm that version is supported (a `nodes-ue<version>.json` DB pair exists in `agent-pack/`). Do not write any `.matgraph.json` until the UE version is confirmed and supported. Set the graph's `ueVersion` to that confirmed version.

For UE5 material work: read `agent-pack/SPEC.md` and the version-matched DB pair `agent-pack/nodes-ue<version>.json` (+ `nodes-ue<version>.export.json`) before writing any `.matgraph.json` file.

Output location: `graphs/<project>/`. Each project folder contains one Material and any MaterialFunctions it references. By convention the folder name matches the material name.

**Work-project Material Functions:** if a material calls one of the user's own project MFs by UE asset path (`/Game/...`), look it up in `agent-pack/workmf-index.json` (`functions[<assetPath>]`) and use its `inputs[].name` / `outputs[].name` for connections. If it isn't in the index, stop and ask the user to run the WorkMF crawl — don't invent pin names. (`/Engine/...` built-ins are the exception: not indexed.) See SPEC.md → "Work-project Material Functions".

Examples in `agent-pack/examples/`.

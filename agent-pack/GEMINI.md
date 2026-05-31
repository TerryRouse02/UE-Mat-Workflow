# UE Material Workflow

**HARD RULE — ASK THE UE VERSION FIRST.** Before authoring or editing ANY material graph, you MUST ask the user which UE version they are targeting, and confirm that version is supported (a `nodes-ue<version>.json` DB pair exists in `agent-pack/`). Do not write any `.matgraph.json` until the UE version is confirmed and supported. Set the graph's `ueVersion` to that confirmed version.

For UE5 material tasks: read `agent-pack/SPEC.md` and the version-matched DB pair `agent-pack/nodes-ue<version>.json` (+ `nodes-ue<version>.export.json`) first. Write `.matgraph.json` files to `graphs/<project>/` per the spec (one folder per project: Material + its MFs).

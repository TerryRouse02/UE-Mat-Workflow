# UE Material Workflow

When asked to design or modify a UE5 material, follow the spec:

@SPEC.md
@nodes-ue5.7.json

Examples: @examples/01_basic_pbr.matgraph.json, @examples/02_with_function.matgraph.json

Write output to `graphs/<project>/`: one folder per project, containing the Material and any MaterialFunctions it uses. By convention the folder name matches the material name.

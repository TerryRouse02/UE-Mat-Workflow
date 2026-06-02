# UEMatExportMetadata

Editor-only UE plugin for maintaining `agent-pack/nodes-ue5.7.export.json`.

The plugin exposes a commandlet:

```powershell
UnrealEditor-Cmd.exe <Path\To\Project.uproject> -run=UEMatExportMetadata -NodeDb=<nodes-ue5.7.json> -Out=<nodes-ue5.7.export.json>
```

The same commandlet also has a **WorkMF mode** that crawls the project's own Material
Functions into the local, gitignored `agent-pack/workmf-index.json` (see `../docs/WORKMF.md`):

```powershell
UnrealEditor-Cmd.exe <Path\To\Project.uproject> -run=UEMatExportMetadata -WorkMfOut=<workmf-index.json> [-ContentRoots=/Game]
```

Recommended repo-level wrapper:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\Invoke-NodeT3DMetadataMaintenance.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine>
```

`Package-Plugin.ps1` creates a compiled Win64 package under
`tools\node-t3d-metadata\compiled\UEMatExportMetadata` for reuse.

To capture the ground-truth MakeMaterialAttributes clipboard fixture:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Capture-MakeMaterialAttributesSample.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine>
```

This writes `viewer\tests\fixtures\ue-make-material-attributes.t3d` by creating
the nodes inside UE and exporting them through UE's native graph clipboard path.

To capture the ground-truth core clipboard fixture:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Capture-CoreClipboardSample.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine> `
  -TextureAsset /Game/Textures/T_Mask.T_Mask
```

This writes `viewer\tests\fixtures\ue-clipboard-core.t3d` by constructing the
core calibration graph inside UE and exporting it through UE's native graph
clipboard path.

To capture the ground-truth texture reference syntax for `TextureSample` and
`TextureSampleParameter2D`:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Capture-TextureSampleSources.ps1 `
  -ProjectPath <Path\To\Project.uproject> `
  -EngineRoot <Path\To\UnrealEngine> `
  -TextureAsset /Game/Textures/T_Mask.T_Mask
```

This writes `viewer\tests\fixtures\ue-texture-sample-sources.t3d` through UE's
native graph clipboard path.

The normal workflow uses the compiled external plugin and writes logs under
`Logs\UE`. Do not leave a duplicate
`<ProjectDir>\Plugins\UEMatExportMetadata\UEMatExportMetadata.uplugin` project
plugin copy in place when using the packaged plugin, because UE will prefer the
project copy.

For project-plugin iteration, pass `-UseProjectPlugin` to
`Run-UEMatExportMetadata.ps1` and provide `-ProjectPath` / `-EngineRoot`.

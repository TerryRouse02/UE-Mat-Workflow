# UEMatExportMetadata

Editor-only UE plugin for maintaining `agent-pack/nodes-ue5.7.export.json`.

The plugin exposes a commandlet:

```powershell
UnrealEditor-Cmd.exe G1_Project.uproject -run=UEMatExportMetadata -NodeDb=<nodes-ue5.7.json> -Out=<nodes-ue5.7.export.json>
```

Recommended wrapper:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Run-UEMatExportMetadata.ps1
```

`Package-Plugin.ps1` creates a compiled Win64 package under
`tools\node-t3d-metadata\compiled\UEMatExportMetadata` for reuse.

To capture the ground-truth MakeMaterialAttributes clipboard fixture:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Capture-MakeMaterialAttributesSample.ps1 -G1Root D:\SDGF_G1_Project
```

This writes `viewer\tests\fixtures\ue-make-material-attributes.t3d` by creating
the nodes inside UE and exporting them through UE's native graph clipboard path.

Default maintenance flow:

```powershell
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Package-Plugin.ps1
powershell -ExecutionPolicy Bypass -File .\tools\node-t3d-metadata\plugin-src\Scripts\Run-UEMatExportMetadata.ps1
```

The run wrapper uses the compiled package from
`tools\node-t3d-metadata\compiled\UEMatExportMetadata` and writes logs under
`Logs\UE`. Do not leave a duplicate
`D:\SDGF_G1_Project\G1_Project\Plugins\UEMatExportMetadata` project-plugin copy in
place when using the packaged plugin, because UE will prefer the project copy.

For project-plugin iteration, pass `-UseProjectPlugin`. That mode syncs the plugin
into the G1 project, builds `G1_ProjectEditor`, and then runs the commandlet.

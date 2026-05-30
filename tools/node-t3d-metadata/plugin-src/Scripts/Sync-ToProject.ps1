param(
    [string]$ProjectPath = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    throw "ProjectPath is required. Pass -ProjectPath <path-to-.uproject>."
}

$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
$PluginRoot = Split-Path -Parent $PSScriptRoot
$ProjectDir = (Resolve-Path -LiteralPath (Split-Path -Parent $ProjectPath)).Path
$TargetRoot = Join-Path $ProjectDir "Plugins\UEMatExportMetadata"
$TargetRootFull = [System.IO.Path]::GetFullPath($TargetRoot)
$ProjectDirFull = [System.IO.Path]::GetFullPath($ProjectDir)
$ExpectedRootFull = [System.IO.Path]::GetFullPath((Join-Path $ProjectDir "Plugins\UEMatExportMetadata"))

if (-not (Test-Path $PluginRoot)) {
    throw "Plugin root not found: $PluginRoot"
}
if (-not $TargetRootFull.Equals($ExpectedRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to sync plugin to unexpected target: $TargetRootFull"
}
if (-not $TargetRootFull.StartsWith(($ProjectDirFull.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to sync plugin outside project directory: $TargetRootFull"
}

$TargetParent = Split-Path -Parent $TargetRoot
New-Item -ItemType Directory -Force -Path $TargetParent | Out-Null

if (Test-Path $TargetRoot) {
    Get-ChildItem -LiteralPath $TargetRoot -Force |
        Where-Object {
            $ChildFull = [System.IO.Path]::GetFullPath($_.FullName)
            if (-not $ChildFull.StartsWith(($TargetRootFull.TrimEnd('\') + '\'), [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to remove path outside plugin target: $ChildFull"
            }
            $_.Name -notin @("Binaries", "Intermediate", "Saved")
        } |
        Remove-Item -Recurse -Force
} else {
    New-Item -ItemType Directory -Force -Path $TargetRoot | Out-Null
}

$itemsToCopy = @(
    "UEMatExportMetadata.uplugin",
    "Source"
)

foreach ($item in $itemsToCopy) {
    $source = Join-Path $PluginRoot $item
    $target = Join-Path $TargetRoot $item
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
}

Write-Host "Synced UEMatExportMetadata plugin to $TargetRoot"

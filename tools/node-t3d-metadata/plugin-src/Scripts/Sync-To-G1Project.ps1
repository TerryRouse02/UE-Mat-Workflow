param(
    [string]$G1Root = "D:\SDGF_G1_Project"
)

$ErrorActionPreference = "Stop"

$PluginRoot = Split-Path -Parent $PSScriptRoot
$TargetRoot = Join-Path $G1Root "G1_Project\Plugins\UEMatExportMetadata"

if (-not (Test-Path $PluginRoot)) {
    throw "Plugin root not found: $PluginRoot"
}

$TargetParent = Split-Path -Parent $TargetRoot
New-Item -ItemType Directory -Force -Path $TargetParent | Out-Null

if (Test-Path $TargetRoot) {
    Get-ChildItem -LiteralPath $TargetRoot -Force |
        Where-Object { $_.Name -notin @("Binaries", "Intermediate", "Saved") } |
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

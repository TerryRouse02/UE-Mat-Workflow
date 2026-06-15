param(
    [string]$ProjectPath = "",
    [string]$EngineRoot = "",
    [string]$WorkflowRoot = "",
    [string]$PackageDir = "",
    [string]$EditorTarget = "",
    [string]$StagingDir = "",
    # Comma-separated project content roots to crawl for UMaterial assets.
    # Default is /Game. Example: /Game/Materials limits the crawl to that subtree.
    [string]$ContentRoots = "/Game",
    # Single-asset mode: a UE object path (e.g. /Game/Materials/M_Foo.M_Foo). When set,
    # the commandlet re-dumps ONLY that asset and the Material Functions it references
    # (transitively) into staging - the importer then overwrites just those
    # graphs/_project/<name> graphs, leaving the rest of _project untouched. Empty ->
    # full crawl of -ContentRoots.
    [string]$Asset = "",
    [switch]$ForcePackage,
    [switch]$UseProjectPlugin
)

$ErrorActionPreference = "Stop"

function Find-RepoRoot([string]$StartPath) {
    $Current = (Resolve-Path -LiteralPath $StartPath).Path
    while ($true) {
        if (Test-Path (Join-Path $Current "agent-pack\nodes-ue5.7.json")) {
            return $Current
        }
        $Parent = Split-Path -Parent $Current
        if ([string]::IsNullOrWhiteSpace($Parent) -or $Parent -eq $Current) {
            throw "Could not find repo root from: $StartPath"
        }
        $Current = $Parent
    }
}

function Get-NewestWriteTime([string]$Path) {
    $latest = [DateTime]::MinValue
    if (Test-Path $Path) {
        Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.LastWriteTimeUtc -gt $latest) { $latest = $_.LastWriteTimeUtc }
        }
    }
    return $latest
}

# Per-machine tooling config. Reads tools/node-t3d-metadata/local.config.json (the
# gitignored real file, two levels up from plugin-src/Scripts - NOT the committed
# local.config.example.json template) and returns the requested property, or $null if the
# file or property is absent. A missing config file is tolerated silently.
function Get-LocalConfigValue([string]$BundleRoot, [string]$Name) {
    $ConfigPath = Join-Path $BundleRoot "local.config.json"
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        return $null
    }
    $Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if ($null -eq $Config) {
        return $null
    }
    $Property = $Config.PSObject.Properties[$Name]
    if ($null -eq $Property) {
        return $null
    }
    return $Property.Value
}

$PluginRoot = Split-Path -Parent $PSScriptRoot
$BundleRoot = Split-Path -Parent $PluginRoot
if ([string]::IsNullOrWhiteSpace($WorkflowRoot)) {
    $WorkflowRoot = Find-RepoRoot $BundleRoot
}

if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    $ProjectPath = Get-LocalConfigValue $BundleRoot "ProjectPath"
}
if ([string]::IsNullOrWhiteSpace($EngineRoot)) {
    $EngineRoot = Get-LocalConfigValue $BundleRoot "EngineRoot"
}
if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    throw "ProjectPath is required. Pass -ProjectPath <path-to-.uproject> or set it in local.config.json."
}
if ([string]::IsNullOrWhiteSpace($EngineRoot)) {
    throw "EngineRoot is required. Pass -EngineRoot <path-to-UnrealEngine> or set it in local.config.json."
}

$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
$EngineRoot = (Resolve-Path -LiteralPath $EngineRoot).Path
$ProjectDir = Split-Path -Parent $ProjectPath
if ($IsMacOS -eq $true) {
    $EditorCmd = Join-Path $EngineRoot "Engine/Binaries/Mac/UnrealEditor-Cmd"
} else {
    $EditorCmd = Join-Path $EngineRoot "Engine\Binaries\Win64\UnrealEditor-Cmd.exe"
}
if ([string]::IsNullOrWhiteSpace($StagingDir)) {
    $StagingDir = Join-Path $WorkflowRoot "tools\node-t3d-metadata\projectmat-staging"
}
$StagingDir = [System.IO.Path]::GetFullPath($StagingDir)
if ([string]::IsNullOrWhiteSpace($PackageDir)) {
    $PackageDir = Join-Path $BundleRoot "compiled\UEMatExportMetadata"
}
$PackagedPlugin = Join-Path $PackageDir "UEMatExportMetadata.uplugin"
if ($IsMacOS -eq $true) {
    $PackagedDll = Join-Path $PackageDir "Binaries/Mac/UnrealEditor-UEMatExportMetadata.dylib"
} else {
    $PackagedDll = Join-Path $PackageDir "Binaries\Win64\UnrealEditor-UEMatExportMetadata.dll"
}
$ProjectPlugin = Join-Path $ProjectDir "Plugins\UEMatExportMetadata\UEMatExportMetadata.uplugin"
$LogRoot = Join-Path $WorkflowRoot "Logs\UE"
$CommandletLog = Join-Path $LogRoot "UEMatExportMetadata_ProjectMat.log"
if ([string]::IsNullOrWhiteSpace($EditorTarget)) {
    $EditorTarget = "$([System.IO.Path]::GetFileNameWithoutExtension($ProjectPath))Editor"
}

foreach ($required in @($ProjectPath, $EditorCmd)) {
    if (-not (Test-Path $required)) {
        throw "Required path not found: $required"
    }
}

New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null
Get-ChildItem -LiteralPath $StagingDir -Filter "*.t3d" -File -ErrorAction SilentlyContinue | Remove-Item -Force

if (-not $UseProjectPlugin) {
    $sourceStamp = Get-NewestWriteTime $PluginRoot
    $packageStamp = if (Test-Path $PackagedDll) { (Get-Item -LiteralPath $PackagedDll).LastWriteTimeUtc } else { [DateTime]::MinValue }
    if ($ForcePackage -or -not (Test-Path $PackagedPlugin) -or -not (Test-Path $PackagedDll) -or $sourceStamp -gt $packageStamp) {
        Write-Host "Compiled plugin missing or stale -> packaging..."
        & (Join-Path $PluginRoot "Scripts\Package-Plugin.ps1") `
            -ProjectPath $ProjectPath -EngineRoot $EngineRoot -PackageDir $PackageDir -WorkflowRoot $WorkflowRoot
        if ($LASTEXITCODE -ne 0) { throw "Package-Plugin.ps1 failed with exit code $LASTEXITCODE." }
    }
    if (Test-Path $ProjectPlugin) {
        throw "Project plugin copy exists and will shadow the packaged plugin: $ProjectPlugin. Remove that generated copy, or pass -UseProjectPlugin after building the project plugin."
    }
}

$args = @(
    $ProjectPath,
    "-plugin=$PackagedPlugin",
    "-run=UEMatExportMetadata",
    "-ProjectMatStaging=$StagingDir",
    "-ContentRoots=$ContentRoots",
    "-Unattended",
    "-NoSplash",
    "-NoP4",
    "-NoSourceControl",
    "-SCCProvider=None",
    "-DDC-ForceMemoryCache",
    "-log",
    "-stdout",
    "-FullStdOutLogOutput",
    "-AbsLog=$CommandletLog"
)
if (-not [string]::IsNullOrWhiteSpace($Asset)) {
    # Single-asset mode: dump only this asset (and its referenced MFs, transitively).
    $args += "-Asset=$Asset"
}
if ($UseProjectPlugin) {
    $args = $args | Where-Object { $_ -ne "-plugin=$PackagedPlugin" }
}

& $EditorCmd @args
if ($LASTEXITCODE -ne 0) {
    throw "Project material crawl failed with exit code $LASTEXITCODE. Log: $CommandletLog"
}

Write-Host "Project material staging written to $StagingDir"
if (-not [string]::IsNullOrWhiteSpace($Asset)) {
    Write-Host "Single-asset mode: $Asset (plus its referenced MFs; other _project graphs untouched)"
} else {
    Write-Host "Content roots crawled: $ContentRoots"
}
Write-Host "Commandlet log: $CommandletLog"
Write-Host "NOTE: $StagingDir is gitignored staging - do not commit generated T3D files."

param(
    [string]$ProjectPath = "",
    [string]$EngineRoot = "",
    [string]$WorkflowRoot = "",
    [string]$PackageDir = "",
    [string]$EditorTarget = "",
    # Where to write the discovery report. Default lives under the tool folder so it
    # is easy to review; it is not bundled into the web build (the dbRegistry glob
    # only matches nodes-ue*.json). Commit it or not as you like.
    [string]$Out = "",
    # DB to diff against. When set, the report marks which engine expressions the DB
    # already covers vs which are missing. Defaults to the shipped 5.7 authoring DB.
    [string]$NodeDb = "",
    [switch]$ForcePackage,
    # Some installs have broken/incompatible default engine plugins (Metasound,
    # Interchange, …) that abort the commandlet on load. This fallback boots a bare
    # editor with only this plugin. NOTE: it then sees ONLY Engine-module material
    # expressions — plugin-provided expressions (Paper2D, etc.) are excluded.
    [switch]$NoEnginePlugins,
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

# Newest mtime under a directory — used to detect a stale compiled plugin.
function Get-NewestWriteTime([string]$Path) {
    $latest = [DateTime]::MinValue
    if (Test-Path $Path) {
        Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.LastWriteTimeUtc -gt $latest) { $latest = $_.LastWriteTimeUtc }
        }
    }
    return $latest
}

$PluginRoot = Split-Path -Parent $PSScriptRoot          # ...\plugin-src
$BundleRoot = Split-Path -Parent $PluginRoot            # ...\node-t3d-metadata
if ([string]::IsNullOrWhiteSpace($WorkflowRoot)) {
    $WorkflowRoot = Find-RepoRoot $BundleRoot
}
if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    throw "ProjectPath is required. Pass -ProjectPath <path-to-.uproject>."
}
if ([string]::IsNullOrWhiteSpace($EngineRoot)) {
    throw "EngineRoot is required. Pass -EngineRoot <path-to-UnrealEngine>."
}

$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
$EngineRoot = (Resolve-Path -LiteralPath $EngineRoot).Path
$ProjectDir = Split-Path -Parent $ProjectPath
$EditorCmd = Join-Path $EngineRoot "Engine\Binaries\Win64\UnrealEditor-Cmd.exe"
if ([string]::IsNullOrWhiteSpace($Out)) {
    $Out = Join-Path $WorkflowRoot "tools\node-t3d-metadata\node-discovery.json"
}
if ([string]::IsNullOrWhiteSpace($NodeDb)) {
    $NodeDb = Join-Path $WorkflowRoot "agent-pack\nodes-ue5.7.json"
}
if ([string]::IsNullOrWhiteSpace($PackageDir)) {
    $PackageDir = Join-Path $BundleRoot "compiled\UEMatExportMetadata"
}
$PackagedPlugin = Join-Path $PackageDir "UEMatExportMetadata.uplugin"
$PackagedDll = Join-Path $PackageDir "Binaries\Win64\UnrealEditor-UEMatExportMetadata.dll"
$ProjectPlugin = Join-Path $ProjectDir "Plugins\UEMatExportMetadata\UEMatExportMetadata.uplugin"
$LogRoot = Join-Path $WorkflowRoot "Logs\UE"
$CommandletLog = Join-Path $LogRoot "UEMatExportMetadata_NodeDiscovery.log"
if ([string]::IsNullOrWhiteSpace($EditorTarget)) {
    $EditorTarget = "$([System.IO.Path]::GetFileNameWithoutExtension($ProjectPath))Editor"
}

foreach ($required in @($ProjectPath, $EditorCmd)) {
    if (-not (Test-Path $required)) {
        throw "Required path not found: $required"
    }
}

New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

# Rebuild the compiled plugin when it is missing or older than plugin-src (same
# staleness rule Invoke-NodeT3DMetadataMaintenance.ps1 uses). This is what makes
# "edit C++ -> run discovery" work without a manual package step.
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
    "-DiscoverNodesOut=$Out",
    "-NodeDb=$NodeDb",
    "-Unattended",
    "-NoSplash",
    "-NoP4",
    "-NoSourceControl",
    "-SCCProvider=None",
    "-DDC-ForceMemoryCache",   # discovery needs no persistent DDC; avoids Zen/DDC stalls
    "-log",
    "-stdout",
    "-FullStdOutLogOutput",
    "-AbsLog=$CommandletLog"
)
if ($UseProjectPlugin) {
    $args = $args | Where-Object { $_ -ne "-plugin=$PackagedPlugin" }
}
if ($NoEnginePlugins) {
    # Bare-editor fallback for installs whose default engine plugins fail to load.
    $args += "-NoEnginePlugins"
    $args += "-EnablePlugins=UEMatExportMetadata"
}

& $EditorCmd @args
$editorExit = $LASTEXITCODE

# UE often returns a non-zero code from a late DDC/warning summary even after the
# commandlet has already written its report. Treat "report exists + success line
# in the log" as success-with-warnings rather than a hard failure.
$reportWritten = (Test-Path $Out) -and (
    (Test-Path $CommandletLog) -and (Select-String -LiteralPath $CommandletLog -SimpleMatch "Wrote node discovery report" -Quiet)
)
if ($editorExit -ne 0) {
    if ($reportWritten) {
        Write-Warning "UnrealEditor returned exit code $editorExit, but the report was written (likely a trailing DDC/warning summary). Treating as success."
    } else {
        throw "Node discovery failed with exit code $editorExit and no report was written. Log: $CommandletLog"
    }
}

Write-Host "Node discovery report written to $Out"
Write-Host "Diffed against: $NodeDb"
Write-Host "Commandlet log: $CommandletLog"
Write-Host "Review the report's `"missing`" array, then add entries to agent-pack\nodes-ue5.7.json (verified:false) and regenerate the export metadata."

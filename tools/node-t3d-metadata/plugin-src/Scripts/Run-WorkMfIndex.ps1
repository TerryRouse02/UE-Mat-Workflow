param(
    [string]$ProjectPath = "",
    [string]$EngineRoot = "",
    [string]$WorkflowRoot = "",
    [string]$PackageDir = "",
    [string]$EditorTarget = "",
    # Comma-separated UE content roots to crawl for the project's own Material Functions.
    # Default is /Game (the project's Content/). Engine/official MFs are intentionally NOT indexed.
    [string]$ContentRoots = "/Game",
    [string]$UeVersion = "5.7",
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

$PluginRoot = Split-Path -Parent $PSScriptRoot
$BundleRoot = Split-Path -Parent $PluginRoot
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
# Local, gitignored output — the user's own project MF signatures, never committed.
$Out = Join-Path $WorkflowRoot "agent-pack\workmf-index.json"
if ([string]::IsNullOrWhiteSpace($PackageDir)) {
    $PackageDir = Join-Path $BundleRoot "compiled\UEMatExportMetadata"
}
$PackagedPlugin = Join-Path $PackageDir "UEMatExportMetadata.uplugin"
$ProjectPlugin = Join-Path $ProjectDir "Plugins\UEMatExportMetadata\UEMatExportMetadata.uplugin"
$LogRoot = Join-Path $WorkflowRoot "Logs\UE"
$CommandletLog = Join-Path $LogRoot "UEMatExportMetadata_WorkMF.log"
if ([string]::IsNullOrWhiteSpace($EditorTarget)) {
    $EditorTarget = "$([System.IO.Path]::GetFileNameWithoutExtension($ProjectPath))Editor"
}

foreach ($required in @($ProjectPath, $EditorCmd)) {
    if (-not (Test-Path $required)) {
        throw "Required path not found: $required"
    }
}

if (-not $UseProjectPlugin) {
    if (-not (Test-Path $PackagedPlugin)) {
        throw "Packaged plugin not found: $PackagedPlugin. Run Package-Plugin.ps1 first, or pass -UseProjectPlugin."
    }
    if (Test-Path $ProjectPlugin) {
        throw "Project plugin copy exists and will shadow the packaged plugin: $ProjectPlugin. Remove that generated copy, or pass -UseProjectPlugin after building the project plugin."
    }
}

New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

$args = @(
    $ProjectPath,
    "-plugin=$PackagedPlugin",
    "-run=UEMatExportMetadata",
    "-WorkMfOut=$Out",
    "-ContentRoots=$ContentRoots",
    "-UeVersion=$UeVersion",
    "-Unattended",
    "-NoSplash",
    "-NoP4",
    "-NoSourceControl",
    "-SCCProvider=None",
    "-log",
    "-stdout",
    "-FullStdOutLogOutput",
    "-AbsLog=$CommandletLog"
)
if ($UseProjectPlugin) {
    $args = $args | Where-Object { $_ -ne "-plugin=$PackagedPlugin" }
}

& $EditorCmd @args
if ($LASTEXITCODE -ne 0) {
    throw "WorkMF crawl failed with exit code $LASTEXITCODE. Log: $CommandletLog"
}

Write-Host "Work-MF index written to $Out"
Write-Host "Content roots crawled: $ContentRoots"
Write-Host "Commandlet log: $CommandletLog"
Write-Host "NOTE: $Out is gitignored (local to this machine) — do not commit it."

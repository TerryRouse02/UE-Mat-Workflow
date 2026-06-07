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
# Per-machine path fallback: an explicit CLI arg always wins; otherwise fall back to
# local.config.json (this lets the viewer crawl button invoke the script with no args).
# A real game project is required here - workmf indexes the project's OWN Material
# Functions, so the bundled minimal host used by engine/discovery crawls is not viable.
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
# Local, gitignored output - the user's own project MF signatures, never committed.
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
Write-Host "NOTE: $Out is gitignored (local to this machine) - do not commit it."

param(
    [string]$G1Root = "D:\SDGF_G1_Project",
    [string]$WorkflowRoot = "",
    [string]$Out = ""
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
if ([string]::IsNullOrWhiteSpace($Out)) {
    $Out = Join-Path $WorkflowRoot "viewer\tests\fixtures\ue-make-material-attributes.t3d"
}

$ProjectPath = Join-Path $G1Root "G1_Project\G1_Project.uproject"
$EditorCmd = Join-Path $G1Root "UnrealEngine\Engine\Binaries\Win64\UnrealEditor-Cmd.exe"
$PackagedPlugin = Join-Path $BundleRoot "compiled\UEMatExportMetadata\UEMatExportMetadata.uplugin"
$ProjectPlugin = Join-Path $G1Root "G1_Project\Plugins\UEMatExportMetadata\UEMatExportMetadata.uplugin"
$LogRoot = Join-Path $WorkflowRoot "Logs\UE"
$CommandletLog = Join-Path $LogRoot "UEMatExportMetadata_MakeMaterialAttributesSample.log"

foreach ($required in @($ProjectPath, $EditorCmd)) {
    if (-not (Test-Path $required)) {
        throw "Required path not found: $required"
    }
}
if (-not (Test-Path $PackagedPlugin)) {
    throw "Packaged plugin not found: $PackagedPlugin. Run Package-Plugin.ps1 first."
}
if (Test-Path $ProjectPlugin) {
    throw "Project plugin copy exists and will shadow the packaged plugin: $ProjectPlugin. Remove that generated copy before using the packaged plugin."
}

New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null

$args = @(
    $ProjectPath,
    "-plugin=$PackagedPlugin",
    "-run=UEMatExportMetadata",
    "-MakeMaterialAttributesSampleOut=$Out",
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

& $EditorCmd @args
if ($LASTEXITCODE -ne 0) {
    throw "Commandlet failed with exit code $LASTEXITCODE. Log: $CommandletLog"
}

Write-Host "MakeMaterialAttributes sample written to $Out"
Write-Host "Commandlet log: $CommandletLog"

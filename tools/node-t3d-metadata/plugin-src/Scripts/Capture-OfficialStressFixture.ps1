param(
    [string]$ProjectPath = "",
    [string]$EngineRoot = "",
    [string]$WorkflowRoot = "",
    [string]$Out = "",
    [string]$UseAttrsOut = "",
    [string]$PackageDir = ""
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
if ([string]::IsNullOrWhiteSpace($Out)) {
    $Out = Join-Path $WorkflowRoot "viewer\tests\fixtures\ue-official-stress.t3d"
}
if ([string]::IsNullOrWhiteSpace($UseAttrsOut)) {
    $UseAttrsOut = Join-Path $WorkflowRoot "viewer\tests\fixtures\ue-official-stress-useattrs.t3d"
}

$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
$EngineRoot = (Resolve-Path -LiteralPath $EngineRoot).Path
$ProjectDir = Split-Path -Parent $ProjectPath
$EditorCmd = Join-Path $EngineRoot "Engine\Binaries\Win64\UnrealEditor-Cmd.exe"
if ([string]::IsNullOrWhiteSpace($PackageDir)) {
    $PackageDir = Join-Path $BundleRoot "compiled\UEMatExportMetadata"
}
$PackagedPlugin = Join-Path $PackageDir "UEMatExportMetadata.uplugin"
$ProjectPlugin = Join-Path $ProjectDir "Plugins\UEMatExportMetadata\UEMatExportMetadata.uplugin"
$LogRoot = Join-Path $WorkflowRoot "Logs\UE"
$DirectLog = Join-Path $LogRoot "UEMatExportMetadata_OfficialStressDirect.log"
$UseAttrsLog = Join-Path $LogRoot "UEMatExportMetadata_OfficialStressUseAttrs.log"

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
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $UseAttrsOut) | Out-Null

function Invoke-Commandlet([string]$OutputPath, [string]$SwitchName, [string]$LogPath) {
    $args = @(
        $ProjectPath,
        "-plugin=$PackagedPlugin",
        "-run=UEMatExportMetadata",
        "-$SwitchName=$OutputPath",
        "-Unattended",
        "-NoSplash",
        "-NoP4",
        "-NoSourceControl",
        "-SCCProvider=None",
        "-culture=en",
        "-language=en",
        "-NoEnginePlugins",
        "-EnablePlugins=UEMatExportMetadata",
        "-DDC-ForceMemoryCache",
        "-log",
        "-stdout",
        "-FullStdOutLogOutput",
        "-AbsLog=$LogPath"
    )

    & $EditorCmd @args
    $editorExit = $LASTEXITCODE
    $sampleName = if ($SwitchName -eq "OfficialStressUseAttrsOut") { "OfficialStressUseAttrs" } else { "OfficialStressDirect" }
    $sampleWritten = (Test-Path $OutputPath) -and (
        (Test-Path $LogPath) -and (Select-String -LiteralPath $LogPath -SimpleMatch "Wrote $sampleName clipboard sample" -Quiet)
    )
    if ($editorExit -ne 0) {
        if ($sampleWritten) {
            Write-Warning "UnrealEditor returned exit code $editorExit, but $sampleName was written. Treating as success."
        } else {
            throw "Commandlet failed with exit code $editorExit. Log: $LogPath"
        }
    }
}

Invoke-Commandlet -OutputPath $Out -SwitchName "OfficialStressOut" -LogPath $DirectLog
Invoke-Commandlet -OutputPath $UseAttrsOut -SwitchName "OfficialStressUseAttrsOut" -LogPath $UseAttrsLog

Write-Host "Official stress direct fixture written to $Out"
Write-Host "Official stress Use Material Attributes fixture written to $UseAttrsOut"
Write-Host "Official MF: /Engine/Functions/Engine_MaterialFunctions02/Texturing/CustomRotator.CustomRotator"
Write-Host "Commandlet logs: $DirectLog ; $UseAttrsLog"

param(
    [string]$G1Root = "D:\SDGF_G1_Project",
    [string]$WorkflowRoot = "",
    [switch]$SkipSync,
    [switch]$SkipBuild,
    [switch]$UseProjectPlugin,
    [switch]$Strict
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

$ProjectPath = Join-Path $G1Root "G1_Project\G1_Project.uproject"
$EngineRoot = Join-Path $G1Root "UnrealEngine"
$BuildBat = Join-Path $EngineRoot "Engine\Build\BatchFiles\Build.bat"
$EditorCmd = Join-Path $EngineRoot "Engine\Binaries\Win64\UnrealEditor-Cmd.exe"
$NodeDb = Join-Path $WorkflowRoot "agent-pack\nodes-ue5.7.json"
$Out = Join-Path $WorkflowRoot "agent-pack\nodes-ue5.7.export.json"
$PackagedPlugin = Join-Path $BundleRoot "compiled\UEMatExportMetadata\UEMatExportMetadata.uplugin"
$ProjectPlugin = Join-Path $G1Root "G1_Project\Plugins\UEMatExportMetadata\UEMatExportMetadata.uplugin"
$LogRoot = Join-Path $WorkflowRoot "Logs\UE"
$BuildLog = Join-Path $LogRoot "UEMatExportMetadata_Build.log"
$CommandletLog = Join-Path $LogRoot "UEMatExportMetadata_Commandlet.log"

foreach ($required in @($ProjectPath, $BuildBat, $EditorCmd, $NodeDb)) {
    if (-not (Test-Path $required)) {
        throw "Required path not found: $required"
    }
}

New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

if ($UseProjectPlugin) {
    if (-not $SkipSync) {
        & (Join-Path $PSScriptRoot "Sync-To-G1Project.ps1") -G1Root $G1Root
    }

    if (-not $SkipBuild) {
        $lockingProcesses = Get-Process UnrealEditor, LiveCodingConsole -ErrorAction SilentlyContinue
        if ($lockingProcesses) {
            $details = ($lockingProcesses | ForEach-Object { "$($_.ProcessName)($($_.Id))" }) -join ", "
            throw "Close UnrealEditor/LiveCodingConsole before building the project plugin. Running: $details"
        }

        & $BuildBat G1_ProjectEditor Win64 Development "-Project=$ProjectPath" -WaitMutex -NoUBA -DisableAdaptiveUnity 2>&1 |
            Tee-Object -FilePath $BuildLog
        if ($LASTEXITCODE -ne 0) {
            throw "Build failed with exit code $LASTEXITCODE. Log: $BuildLog"
        }
    }
}
else {
    if (-not (Test-Path $PackagedPlugin)) {
        throw "Packaged plugin not found: $PackagedPlugin. Run Package-Plugin.ps1 first, or pass -UseProjectPlugin."
    }
    if (Test-Path $ProjectPlugin) {
        throw "Project plugin copy exists and will shadow the packaged plugin: $ProjectPlugin. Remove that generated copy, or pass -UseProjectPlugin after building the project plugin."
    }
}

$args = @(
    $ProjectPath,
    "-plugin=$PackagedPlugin",
    "-run=UEMatExportMetadata",
    "-NodeDb=$NodeDb",
    "-Out=$Out",
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
if ($Strict) {
    $args += "-Strict"
}

& $EditorCmd @args
if ($LASTEXITCODE -ne 0) {
    throw "Commandlet failed with exit code $LASTEXITCODE. Log: $CommandletLog"
}

Write-Host "Metadata written to $Out"
Write-Host "Commandlet log: $CommandletLog"

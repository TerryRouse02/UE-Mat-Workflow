param(
    [string]$G1Root = "D:\SDGF_G1_Project",
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
$WorkflowRoot = Find-RepoRoot $BundleRoot
if ([string]::IsNullOrWhiteSpace($PackageDir)) {
    $PackageDir = Join-Path $BundleRoot "compiled\UEMatExportMetadata"
}

$RunUAT = Join-Path $G1Root "UnrealEngine\Engine\Build\BatchFiles\RunUAT.bat"
$PluginFile = Join-Path $PluginRoot "UEMatExportMetadata.uplugin"
$LogRoot = Join-Path $WorkflowRoot "Logs\UE"
$PackageLog = Join-Path $LogRoot "UEMatExportMetadata_Package.log"

foreach ($required in @($RunUAT, $PluginFile)) {
    if (-not (Test-Path $required)) {
        throw "Required path not found: $required"
    }
}

$lockingProcesses = Get-Process UnrealEditor, LiveCodingConsole -ErrorAction SilentlyContinue
if ($lockingProcesses) {
    $details = ($lockingProcesses | ForEach-Object { "$($_.ProcessName)($($_.Id))" }) -join ", "
    Write-Warning "UnrealEditor/LiveCodingConsole is running: $details. BuildPlugin usually still works, but close them if UBT reports locked files."
}

New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $PackageDir) | Out-Null

& $RunUAT BuildPlugin "-Plugin=$PluginFile" "-Package=$PackageDir" -TargetPlatforms=Win64 2>&1 |
    Tee-Object -FilePath $PackageLog
if ($LASTEXITCODE -ne 0) {
    throw "BuildPlugin failed with exit code $LASTEXITCODE. Log: $PackageLog"
}

$IntermediateDir = Join-Path $PackageDir "Intermediate"
if (Test-Path $IntermediateDir) {
    Remove-Item -LiteralPath $IntermediateDir -Recurse -Force
}

Write-Host "Packaged plugin to $PackageDir"
Write-Host "Package log: $PackageLog"

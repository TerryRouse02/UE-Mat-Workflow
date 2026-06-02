param(
    [string]$ProjectPath = "",
    [string]$EngineRoot = "",
    [string]$PackageDir = "",
    [string]$WorkflowRoot = ""
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
if ([string]::IsNullOrWhiteSpace($EngineRoot)) {
    throw "EngineRoot is required. Pass -EngineRoot <path-to-UnrealEngine>."
}
if ([string]::IsNullOrWhiteSpace($PackageDir)) {
    $PackageDir = Join-Path $BundleRoot "compiled\UEMatExportMetadata"
}

$EngineRoot = (Resolve-Path -LiteralPath $EngineRoot).Path
$RunUAT = Join-Path $EngineRoot "Engine\Build\BatchFiles\RunUAT.bat"
$PluginFile = Join-Path $PluginRoot "UEMatExportMetadata.uplugin"
$LogRoot = Join-Path $WorkflowRoot "Logs\UE"
$PackageLog = Join-Path $LogRoot "UEMatExportMetadata_Package.log"

if (-not [string]::IsNullOrWhiteSpace($ProjectPath) -and -not (Test-Path $ProjectPath)) {
    throw "ProjectPath not found: $ProjectPath"
}
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

$PackagedPluginFile = Join-Path $PackageDir "UEMatExportMetadata.uplugin"
if (Test-Path $PackagedPluginFile) {
    $Descriptor = Get-Content -Raw -LiteralPath $PackagedPluginFile | ConvertFrom-Json
    if ($Descriptor.PSObject.Properties.Name -contains "EngineVersion") {
        $Descriptor.PSObject.Properties.Remove("EngineVersion")
        $Descriptor |
            ConvertTo-Json -Depth 16 |
            Set-Content -LiteralPath $PackagedPluginFile -Encoding UTF8
    }
}

Write-Host "Packaged plugin to $PackageDir"
Write-Host "Package log: $PackageLog"

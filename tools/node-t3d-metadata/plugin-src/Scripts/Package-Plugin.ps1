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

# Per-machine tooling config: read tools/node-t3d-metadata/local.config.json (the
# gitignored real file, NOT the committed local.config.example.json template) and
# return the requested property, or $null when the file or property is absent.
# Mirrors the helper in Invoke-NodeT3DMetadataMaintenance.ps1 so this script can run
# standalone (the web "compile plugin" button spawns it with no path args).
function Get-LocalConfigValue([string]$Name, [string]$BundleDir) {
    $ConfigPath = Join-Path $BundleDir "local.config.json"
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
# An explicit -EngineRoot CLI arg always wins; otherwise fall back to
# local.config.json so the web compile button can run this script with no args.
if ([string]::IsNullOrWhiteSpace($EngineRoot)) {
    $EngineRoot = Get-LocalConfigValue "EngineRoot" $BundleRoot
}
if ([string]::IsNullOrWhiteSpace($EngineRoot)) {
    throw "EngineRoot is required. Pass -EngineRoot <path-to-UnrealEngine>, or set EngineRoot in tools/node-t3d-metadata/local.config.json."
}
if ([string]::IsNullOrWhiteSpace($PackageDir)) {
    $PackageDir = Join-Path $BundleRoot "compiled\UEMatExportMetadata"
}

$EngineRoot = (Resolve-Path -LiteralPath $EngineRoot).Path
if ($IsMacOS -eq $true) {
    $RunUAT = Join-Path $EngineRoot "Engine/Build/BatchFiles/RunUAT.sh"
} else {
    $RunUAT = Join-Path $EngineRoot "Engine\Build\BatchFiles\RunUAT.bat"
}
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

if ($IsMacOS -eq $true) {
    # macOS: "RunUAT BuildPlugin -Package=<dir>" is a CLEAN package -- it wipes
    # everything in <dir> not rebuilt for the requested platform. Pointed at the
    # committed compiled/ dir with -TargetPlatforms=Mac it would delete the
    # committed Binaries/Win64 and rewrite the committed .uplugin. So build to a
    # temp dir and copy only the Mac binaries into PackageDir, leaving the
    # committed Win64 binaries and .uplugin untouched.
    $TempPackage = Join-Path ([System.IO.Path]::GetTempPath()) "uemat-pkg-mac"
    if (Test-Path $TempPackage) { Remove-Item -LiteralPath $TempPackage -Recurse -Force }
    & $RunUAT BuildPlugin "-Plugin=$PluginFile" "-Package=$TempPackage" "-TargetPlatforms=Mac" 2>&1 |
        Tee-Object -FilePath $PackageLog
    if ($LASTEXITCODE -ne 0) {
        throw "BuildPlugin failed with exit code $LASTEXITCODE. Log: $PackageLog"
    }
    $MacBinDst = Join-Path $PackageDir "Binaries/Mac"
    New-Item -ItemType Directory -Force -Path $MacBinDst | Out-Null
    Copy-Item -Path (Join-Path $TempPackage "Binaries/Mac/*") -Destination $MacBinDst -Recurse -Force
    Remove-Item -LiteralPath $TempPackage -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "Built macOS plugin binary into $MacBinDst"
    Write-Host "Committed Binaries/Win64 and .uplugin left intact."
    Write-Host "Package log: $PackageLog"
} else {
    & $RunUAT BuildPlugin "-Plugin=$PluginFile" "-Package=$PackageDir" "-TargetPlatforms=Win64" 2>&1 |
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
            $Json = $Descriptor | ConvertTo-Json -Depth 16
            $Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
            [System.IO.File]::WriteAllText($PackagedPluginFile, $Json, $Utf8NoBom)
        }
    }

    Write-Host "Packaged plugin to $PackageDir"
    Write-Host "Package log: $PackageLog"
}

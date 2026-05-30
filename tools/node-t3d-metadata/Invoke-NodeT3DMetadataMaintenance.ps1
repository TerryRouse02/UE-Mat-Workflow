param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectPath,
    [Parameter(Mandatory = $true)]
    [string]$EngineRoot,
    [string]$WorkflowRoot = "",
    [string]$PackageDir = "",
    [switch]$ForcePackage,
    [switch]$CaptureFixtures,
    [switch]$SkipViewerTests
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

function Get-LatestWriteTimeUtc([string]$Path) {
    if (-not (Test-Path $Path)) {
        return [DateTime]::MinValue
    }
    $latest = (Get-Item -LiteralPath $Path).LastWriteTimeUtc
    Get-ChildItem -LiteralPath $Path -Recurse -File | ForEach-Object {
        if ($_.LastWriteTimeUtc -gt $latest) {
            $latest = $_.LastWriteTimeUtc
        }
    }
    return $latest
}

function Invoke-Step([string]$Name, [scriptblock]$Action) {
    Write-Host ""
    Write-Host "== $Name =="
    & $Action
}

function Invoke-External([string]$Name, [scriptblock]$Action) {
    & $Action
    $ExitCode = $LASTEXITCODE
    if ($null -ne $ExitCode -and $ExitCode -ne 0) {
        throw "$Name failed with exit code $ExitCode"
    }
}

$BundleRoot = $PSScriptRoot
$PluginSrc = Join-Path $BundleRoot "plugin-src"
if ([string]::IsNullOrWhiteSpace($WorkflowRoot)) {
    $WorkflowRoot = Find-RepoRoot $BundleRoot
}
if ([string]::IsNullOrWhiteSpace($PackageDir)) {
    $PackageDir = Join-Path $BundleRoot "compiled\UEMatExportMetadata"
}

$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
$EngineRoot = (Resolve-Path -LiteralPath $EngineRoot).Path
$WorkflowRoot = (Resolve-Path -LiteralPath $WorkflowRoot).Path
$ProjectDir = Split-Path -Parent $ProjectPath

$RunUAT = Join-Path $EngineRoot "Engine\Build\BatchFiles\RunUAT.bat"
$EditorCmd = Join-Path $EngineRoot "Engine\Binaries\Win64\UnrealEditor-Cmd.exe"
$NodeDb = Join-Path $WorkflowRoot "agent-pack\nodes-ue5.7.json"
$ExportMeta = Join-Path $WorkflowRoot "agent-pack\nodes-ue5.7.export.json"
$PackagedPlugin = Join-Path $PackageDir "UEMatExportMetadata.uplugin"
$PackagedDll = Join-Path $PackageDir "Binaries\Win64\UnrealEditor-UEMatExportMetadata.dll"
$ProjectPlugin = Join-Path $ProjectDir "Plugins\UEMatExportMetadata\UEMatExportMetadata.uplugin"

Invoke-Step "Preflight" {
    foreach ($required in @($ProjectPath, $EngineRoot, $RunUAT, $EditorCmd, $NodeDb, $ExportMeta, $PluginSrc)) {
        if (-not (Test-Path $required)) {
            throw "Required path not found: $required"
        }
    }
    if (Test-Path $ProjectPlugin) {
        throw "Project plugin copy exists and will shadow the packaged plugin: $ProjectPlugin. Remove that generated copy before running this external-plugin workflow."
    }
    Write-Host "ProjectPath: $ProjectPath"
    Write-Host "EngineRoot:  $EngineRoot"
    Write-Host "WorkflowRoot: $WorkflowRoot"
    Write-Host "PackageDir:  $PackageDir"
}

$sourceStamp = Get-LatestWriteTimeUtc $PluginSrc
$packageStamp = if (Test-Path $PackagedDll) { (Get-Item -LiteralPath $PackagedDll).LastWriteTimeUtc } else { [DateTime]::MinValue }
$needsPackage = $ForcePackage -or -not (Test-Path $PackagedPlugin) -or -not (Test-Path $PackagedDll) -or $sourceStamp -gt $packageStamp

if ($needsPackage) {
    Invoke-Step "Package plugin" {
        Invoke-External "Package-Plugin.ps1" {
            & (Join-Path $PluginSrc "Scripts\Package-Plugin.ps1") `
                -ProjectPath $ProjectPath `
                -EngineRoot $EngineRoot `
                -WorkflowRoot $WorkflowRoot `
                -PackageDir $PackageDir
        }
    }
} else {
    Write-Host ""
    Write-Host "== Package plugin =="
    Write-Host "Packaged plugin is up to date: $PackagedPlugin"
}

Invoke-Step "Generate metadata" {
    Invoke-External "Run-UEMatExportMetadata.ps1" {
        & (Join-Path $PluginSrc "Scripts\Run-UEMatExportMetadata.ps1") `
            -ProjectPath $ProjectPath `
            -EngineRoot $EngineRoot `
            -WorkflowRoot $WorkflowRoot `
            -PackageDir $PackageDir `
            -Strict
    }
}

if ($CaptureFixtures) {
    Invoke-Step "Capture calibration fixtures" {
        Invoke-External "Capture-MakeMaterialAttributesSample.ps1" {
            & (Join-Path $PluginSrc "Scripts\Capture-MakeMaterialAttributesSample.ps1") `
                -ProjectPath $ProjectPath `
                -EngineRoot $EngineRoot `
                -WorkflowRoot $WorkflowRoot `
                -PackageDir $PackageDir
        }
    }
}

Invoke-Step "Validate tooling layout" {
    Invoke-External "validate-tooling.js" {
        node (Join-Path $BundleRoot "validate-tooling.js")
    }
    Invoke-External "validate-plugin.js" {
        node (Join-Path $PluginSrc "validate-plugin.js")
    }
}

Invoke-Step "Audit export metadata" {
    Invoke-External "audit-export-meta.js" {
        node (Join-Path $BundleRoot "audit-export-meta.js") --workflow-root $WorkflowRoot
    }
}

if (-not $SkipViewerTests) {
    Invoke-Step "Run target viewer tests" {
        $Vitest = Join-Path $WorkflowRoot "viewer\node_modules\.bin\vitest.cmd"
        if (-not (Test-Path $Vitest)) {
            throw "Vitest not found: $Vitest. Restore viewer dependencies or rerun with -SkipViewerTests."
        }
        Invoke-External "vitest target tests" {
            & $Vitest run "viewer\tests\export-meta.test.ts" "viewer\tests\ueT3D.test.ts"
        }
    }
}

Write-Host ""
Write-Host "Node T3D metadata maintenance completed."
Write-Host "Metadata: $ExportMeta"

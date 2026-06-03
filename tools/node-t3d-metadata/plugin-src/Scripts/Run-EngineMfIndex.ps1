param(
    # Optional: discovery/engine crawls don't need a real game project. When omitted,
    # the bundled minimal host is used (it also disables the fragile default engine
    # plugins that abort the unattended commandlet on some installs).
    [string]$ProjectPath = "",
    [string]$EngineRoot = "",
    [string]$WorkflowRoot = "",
    [string]$PackageDir = "",
    [string]$EditorTarget = "",
    # Engine content roots to crawl for official Material Functions. The default covers the
    # shipped /Engine/Functions library; widen it if you depend on plugin-provided MFs.
    [string]$ContentRoots = "/Engine/Functions",
    [string]$UeVersion = "5.7",
    [string]$Out = "",
    [switch]$ForcePackage,
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

# Per-machine tooling config. Reads tools/node-t3d-metadata/local.config.json (the
# gitignored real file, two levels up from plugin-src/Scripts — NOT the committed
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

$PluginRoot = Split-Path -Parent $PSScriptRoot          # ...\plugin-src
$BundleRoot = Split-Path -Parent $PluginRoot            # ...\node-t3d-metadata
if ([string]::IsNullOrWhiteSpace($WorkflowRoot)) {
    $WorkflowRoot = Find-RepoRoot $BundleRoot
}
# Per-machine path fallback: an explicit CLI arg always wins; otherwise fall back to
# local.config.json. EngineRoot is required (enforced below); ProjectPath stays optional
# and, when still empty after this, defaults to the bundled minimal host.
if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    $ProjectPath = Get-LocalConfigValue $BundleRoot "ProjectPath"
}
if ([string]::IsNullOrWhiteSpace($EngineRoot)) {
    $EngineRoot = Get-LocalConfigValue $BundleRoot "EngineRoot"
}
# The engine-MF crawl reads /Engine assets, which are mounted regardless of project, so a
# real game project is not required. Default to the bundled minimal host (see Run-NodeDiscovery).
if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    $ProjectPath = Join-Path $BundleRoot "host\NodeDiscoveryHost.uproject"
    if (-not (Test-Path $ProjectPath)) {
        throw "ProjectPath not given and bundled host project is missing: $ProjectPath"
    }
    Write-Host "No -ProjectPath given; using bundled minimal host: $ProjectPath"
}
if ([string]::IsNullOrWhiteSpace($EngineRoot)) {
    throw "EngineRoot not provided and not found in local.config.json. Pass -EngineRoot <path-to-UnrealEngine> or copy local.config.example.json to local.config.json and fill it in."
}

$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
$EngineRoot = (Resolve-Path -LiteralPath $EngineRoot).Path
$ProjectDir = Split-Path -Parent $ProjectPath
$EditorCmd = Join-Path $EngineRoot "Engine\Binaries\Win64\UnrealEditor-Cmd.exe"
# Committed output — official engine MFs are stable shipped data shared by all users.
if ([string]::IsNullOrWhiteSpace($Out)) {
    $Out = Join-Path $WorkflowRoot "agent-pack\enginemf-index-ue5.7.json"
}
if ([string]::IsNullOrWhiteSpace($PackageDir)) {
    $PackageDir = Join-Path $BundleRoot "compiled\UEMatExportMetadata"
}
$PackagedPlugin = Join-Path $PackageDir "UEMatExportMetadata.uplugin"
$PackagedDll = Join-Path $PackageDir "Binaries\Win64\UnrealEditor-UEMatExportMetadata.dll"
$ProjectPlugin = Join-Path $ProjectDir "Plugins\UEMatExportMetadata\UEMatExportMetadata.uplugin"
$LogRoot = Join-Path $WorkflowRoot "Logs\UE"
$CommandletLog = Join-Path $LogRoot "UEMatExportMetadata_EngineMF.log"
if ([string]::IsNullOrWhiteSpace($EditorTarget)) {
    $EditorTarget = "$([System.IO.Path]::GetFileNameWithoutExtension($ProjectPath))Editor"
}

foreach ($required in @($ProjectPath, $EditorCmd)) {
    if (-not (Test-Path $required)) {
        throw "Required path not found: $required"
    }
}

New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null

# Rebuild the compiled plugin when it is missing or older than plugin-src (same rule as
# Run-NodeDiscovery / Invoke-NodeT3DMetadataMaintenance) so "edit C++ -> run" needs no manual step.
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
    "-WorkMfOut=$Out",
    "-ContentRoots=$ContentRoots",
    "-UeVersion=$UeVersion",
    "-Unattended",
    "-NoSplash",
    "-NoP4",
    "-NoSourceControl",
    "-SCCProvider=None",
    "-DDC-ForceMemoryCache",
    "-log",
    "-stdout",
    "-FullStdOutLogOutput",
    "-AbsLog=$CommandletLog"
)
if ($UseProjectPlugin) {
    $args = $args | Where-Object { $_ -ne "-plugin=$PackagedPlugin" }
}
if ($NoEnginePlugins) {
    $args += "-NoEnginePlugins"
    $args += "-EnablePlugins=UEMatExportMetadata"
}

& $EditorCmd @args
$editorExit = $LASTEXITCODE

# UE often returns non-zero from a trailing DDC/warning summary even after the index is
# written. Treat "index written + success line in log" as success-with-warnings.
$indexWritten = (Test-Path $Out) -and (
    (Test-Path $CommandletLog) -and (Select-String -LiteralPath $CommandletLog -SimpleMatch "Wrote work-MF index" -Quiet)
)
if ($editorExit -ne 0) {
    if ($indexWritten) {
        Write-Warning "UnrealEditor returned exit code $editorExit, but the index was written (likely a trailing DDC/warning summary). Treating as success."
    } else {
        throw "Engine-MF crawl failed with exit code $editorExit and no index was written. Log: $CommandletLog"
    }
}

Write-Host "Engine-MF index written to $Out"
Write-Host "Content roots crawled: $ContentRoots"
Write-Host "Commandlet log: $CommandletLog"
Write-Host "This index IS committed (official engine MFs are stable shipped data). Review the diff and commit it."

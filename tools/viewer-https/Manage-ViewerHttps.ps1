[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('', 'install', 'status', 'restart', 'update', 'change-address', 'export-cert', 'uninstall')]
    [string]$Command = '',
    [switch]$DryRun,
    [switch]$Json,
    [ValidateSet('', 'ip', 'hostname')]
    [string]$AddressMode = '',
    [string]$Address = '',
    [string]$IPv4 = '',
    [string]$ExportPath = '',
    [string]$DataRoot = '',
    [string]$RepoRoot = '',
    [switch]$RemoveCa,
    [switch]$UninstallCaddy
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$script:OriginalBoundParameters = @{}
foreach ($entry in $PSBoundParameters.GetEnumerator()) { $script:OriginalBoundParameters[$entry.Key] = $entry.Value }

Import-Module (Join-Path $PSScriptRoot 'ViewerHttps.Core.psm1') -Force
[void](Initialize-ViewerHttpsConsole)

$script:TaskName = 'UE-Mat Viewer HTTPS'
$script:FirewallName = 'UE-Mat Viewer HTTPS'
$script:InstallerName = 'Install-UE-Mat-HTTPS.cmd'
$script:Actions = New-Object Collections.Generic.List[string]
$script:CleanupDryRunRoot = $false

if (-not $DataRoot) {
    if ($DryRun) {
        $DataRoot = Join-Path ([IO.Path]::GetTempPath()) ('UE-Mat-Caddy-DryRun-' + [Guid]::NewGuid().ToString('N'))
        $script:CleanupDryRunRoot = $true
    } else {
        $DataRoot = Join-Path $env:ProgramData 'UE-Mat-Caddy'
    }
}
if (-not $RepoRoot) { $RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..')) }
$DataRoot = [IO.Path]::GetFullPath($DataRoot)
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)

$configPath = Join-Path $DataRoot 'config.json'
$caddyfilePath = Join-Path $DataRoot 'Caddyfile'
$candidateCaddyfilePath = Join-Path $DataRoot 'Caddyfile.candidate'
$clientRoot = Join-Path $DataRoot 'client'
$installerPath = Join-Path $clientRoot $script:InstallerName
$dataPath = Join-Path $DataRoot 'data'
$configHome = Join-Path $DataRoot 'caddy-config'
$logsPath = Join-Path $DataRoot 'logs'
$runnerPath = Join-Path $DataRoot 'Run-Caddy.ps1'
$publicRootCertificatePath = Join-Path $clientRoot 'Caddy-Root-CA.crt'
$viewerConfigPath = Join-Path $RepoRoot 'tools\node-t3d-metadata\local.config.json'

function Add-Action([string]$Name) { $script:Actions.Add($Name) }

function Show-Step([string]$Number, [string]$Message) {
    if (-not $Json) { Write-Host "[$Number] $Message" -ForegroundColor Cyan }
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Request-Elevation {
    if ($DryRun -or (Test-IsAdministrator)) { return }
    $arguments = New-ViewerHttpsElevationArguments -ScriptPath $PSCommandPath -Command $Command -BoundParameters $script:OriginalBoundParameters
    Start-Process powershell.exe -Verb RunAs -ArgumentList ($arguments -join ' ')
    exit 0
}

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
}

function Write-Utf8Bom([string]$Path, [string]$Content) {
    $encoding = New-Object Text.UTF8Encoding($true)
    [IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
    # JSON consumed by the Node viewer (local.config.json) and the bootstrap reader must
    # be BOM-free: JSON.parse throws on a leading U+FEFF. RFC 8259 also disallows a BOM.
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Write-Ascii([string]$Path, [string]$Content) {
    [IO.File]::WriteAllText($Path, $Content, [Text.Encoding]::ASCII)
}

function Write-JsonAtomic([string]$Path, $Value) {
    $temp = $Path + '.tmp'
    $jsonText = $Value | ConvertTo-Json -Depth 8
    Write-Utf8NoBom $temp ($jsonText + "`r`n")
    Move-Item -LiteralPath $temp -Destination $Path -Force
}

function Get-FileSnapshot([string]$Path) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        return [pscustomobject]@{ Path = $Path; Exists = $true; Bytes = [IO.File]::ReadAllBytes($Path) }
    }
    return [pscustomobject]@{ Path = $Path; Exists = $false; Bytes = $null }
}

function Restore-FileSnapshot($Snapshot) {
    if ($Snapshot.Exists) {
        Ensure-Directory ([IO.Path]::GetDirectoryName([string]$Snapshot.Path))
        [IO.File]::WriteAllBytes([string]$Snapshot.Path, [byte[]]$Snapshot.Bytes)
    } else {
        Remove-Item -LiteralPath ([string]$Snapshot.Path) -Force -ErrorAction SilentlyContinue
    }
}

function Read-State {
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return $null }
    try { return Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json } catch { return $null }
}

function Find-Caddy {
    $command = Get-Command caddy.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\caddy.exe'),
        (Join-Path $env:ProgramFiles 'Caddy\caddy.exe')
    )
    foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate } }
    return $null
}

function Invoke-Caddy {
    param(
        [Parameter(Mandatory = $true)][string]$CaddyPath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [string]$DataHome = $dataPath,
        [string]$ConfigHome = $configHome
    )

    $oldData = $env:XDG_DATA_HOME
    $oldConfig = $env:XDG_CONFIG_HOME
    try {
        $env:XDG_DATA_HOME = $DataHome
        $env:XDG_CONFIG_HOME = $ConfigHome
        $previousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            $nativeOutput = @(& $CaddyPath @Arguments 2>&1)
            $nativeExitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if (-not $Json) {
            foreach ($line in $nativeOutput) { Write-Host ([string]$line) }
        }
        if ($nativeExitCode -ne 0) {
            $diagnostic = ($nativeOutput | ForEach-Object { [string]$_ } | Select-Object -Last 20) -join "`r`n"
            throw "Caddy 執行失敗（exit $nativeExitCode）：$($Arguments -join ' ')`r`n$diagnostic"
        }
        return
    } finally {
        $env:XDG_DATA_HOME = $oldData
        $env:XDG_CONFIG_HOME = $oldConfig
    }
}

function Invoke-CaddyValidation {
    param(
        [Parameter(Mandatory = $true)][string]$CaddyPath,
        [Parameter(Mandatory = $true)][string]$ConfigPath
    )

    $validationRoot = Join-Path ([IO.Path]::GetTempPath()) ('UE-Mat-Caddy-Validate-' + [Guid]::NewGuid().ToString('N'))
    $validationData = Join-Path $validationRoot 'data'
    $validationConfig = Join-Path $validationRoot 'config'
    try {
        Ensure-Directory $validationData
        Ensure-Directory $validationConfig
        Invoke-Caddy -CaddyPath $CaddyPath -Arguments @('validate', '--config', $ConfigPath, '--adapter', 'caddyfile') -DataHome $validationData -ConfigHome $validationConfig
    } finally {
        Remove-Item -LiteralPath $validationRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Ensure-Caddy {
    $path = Find-Caddy
    if ($path) {
        if (-not $Json) { Write-Host "已找到 Caddy：$path" }
        return [string]$path
    }
    Add-Action 'InstallCaddyWithWinget'
    if ($DryRun) { return 'caddy.exe' }
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw '找不到 winget，無法自動安裝 Caddy。請先安裝 App Installer。' }
    Write-Host '未找到 Caddy，正在透過 winget 安裝。下載可能需要數分鐘，請勿關閉視窗。' -ForegroundColor Yellow
    $wingetResult = Invoke-ViewerHttpsNativeCommand -ShowOutput (-not $Json) -Command { & winget.exe install --id CaddyServer.Caddy -e --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity }
    $wingetExitCode = [int]$wingetResult.ExitCode
    if ($wingetExitCode -ne 0) { throw "winget 安裝 Caddy 失敗（exit $wingetExitCode）。" }
    $path = Find-Caddy
    if (-not $path) { throw 'Caddy 已安裝，但目前程序找不到 caddy.exe。請重新開啟 PowerShell 後再試。' }
    return [string]$path
}

function Get-AddressSelection {
    if (-not $AddressMode) {
        Write-Host '請選擇 HTTPS 位址類型：'
        Write-Host '  1. WLAN IP（例如 192.168.71.92）'
        Write-Host '  2. 自訂主機名（例如 ue-mat.local）'
        $choice = Read-Host '輸入 1 或 2'
        $script:AddressMode = if ($choice -eq '2') { 'hostname' } else { 'ip' }
    }
    if ($AddressMode -eq 'ip') {
        if (-not $Address) { $script:Address = Read-Host '請輸入 WLAN IPv4 位址' }
        if (-not (Test-ViewerHttpsIPv4 $Address)) { throw "WLAN IPv4 位址無效：$Address" }
        return [pscustomobject]@{ mode = 'ip'; address = $Address; ipv4 = $Address; hostname = ''; httpsUrl = "https://$Address/" }
    }
    if (-not $Address) { $script:Address = Read-Host '請輸入主機名（例如 ue-mat.local）' }
    if (-not $IPv4) { $script:IPv4 = Read-Host '請輸入此伺服器的 WLAN IPv4 位址' }
    if (-not (Test-ViewerHttpsHostname $Address)) { throw "主機名無效：$Address" }
    if (-not (Test-ViewerHttpsIPv4 $IPv4)) { throw "WLAN IPv4 位址無效：$IPv4" }
    return [pscustomobject]@{ mode = 'hostname'; address = $Address; ipv4 = $IPv4; hostname = $Address; httpsUrl = "https://$Address/" }
}

function Test-ViewerHttp {
    if ($DryRun) { return $true }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:5790/api/auth/status' -TimeoutSec 5
        return $response.StatusCode -eq 200
    } catch { return $false }
}

function Set-ServerHosts([string]$Ip, [string]$HostName) {
    if (-not $HostName) { return }
    Add-Action 'UpdateServerHostsMapping'
    if ($DryRun) { return }
    $path = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    $content = if (Test-Path -LiteralPath $path) { [IO.File]::ReadAllText($path) } else { '' }
    Write-Ascii $path (Set-ViewerHttpsHostsBlock -Content $content -IPv4 $Ip -Hostname $HostName)
}

function Remove-ServerHostsBlock {
    $path = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    if (-not (Test-Path -LiteralPath $path)) { return }
    $content = [IO.File]::ReadAllText($path) -replace "`r?`n", "`n"
    $pattern = '(?ms)^# BEGIN UE-MAT HTTPS.*?^# END UE-MAT HTTPS\s*'
    $updated = [regex]::Replace($content, $pattern, '').TrimEnd("`n") + "`n"
    Write-Ascii $path ($updated -replace "`n", "`r`n")
}

function RestorePreviousCaddyDeployment {
    param(
        [Parameter(Mandatory = $true)]$Snapshots,
        [bool]$TaskExisted,
        [bool]$TaskWasRunning,
        [bool]$FirewallExisted
    )

    Add-Action 'RestorePreviousCaddyDeployment'
    Remove-Item -LiteralPath $candidateCaddyfilePath -Force -ErrorAction SilentlyContinue
    foreach ($snapshot in $Snapshots) { Restore-FileSnapshot $snapshot }

    if ($TaskExisted) {
        Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
        if ($TaskWasRunning) { Start-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue }
    } else {
        Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    if (-not $FirewallExisted) {
        Remove-NetFirewallRule -DisplayName $script:FirewallName -ErrorAction SilentlyContinue
    }
}

function New-Runner([string]$CaddyPath) {
    $escapedCaddy = $CaddyPath.Replace("'", "''")
    $escapedData = $dataPath.Replace("'", "''")
    $escapedConfigHome = $configHome.Replace("'", "''")
    $escapedConfig = $caddyfilePath.Replace("'", "''")
    $escapedStdoutLog = (Join-Path $logsPath 'caddy.stdout.log').Replace("'", "''")
    $escapedStderrLog = (Join-Path $logsPath 'caddy.stderr.log').Replace("'", "''")
    $escapedInternalRoot = (Get-CaddyInternalRootCertificatePath).Replace("'", "''")
    $escapedPublicRoot = (Get-RootCertificatePath).Replace("'", "''")
    return @"
`$ErrorActionPreference = 'Stop'
`$env:XDG_DATA_HOME = '$escapedData'
`$env:XDG_CONFIG_HOME = '$escapedConfigHome'
Remove-Item -LiteralPath '$escapedStdoutLog', '$escapedStderrLog' -Force -ErrorAction SilentlyContinue
`$argumentLine = 'run --config "' + '$escapedConfig' + '" --adapter caddyfile'
`$caddyProcess = Start-Process -FilePath '$escapedCaddy' -ArgumentList `$argumentLine -RedirectStandardOutput '$escapedStdoutLog' -RedirectStandardError '$escapedStderrLog' -WindowStyle Hidden -PassThru
`$deadline = (Get-Date).AddSeconds(30)
while (-not (Test-Path -LiteralPath '$escapedInternalRoot' -PathType Leaf) -and -not `$caddyProcess.HasExited -and (Get-Date) -lt `$deadline) {
    Start-Sleep -Milliseconds 250
    `$caddyProcess.Refresh()
}
if (-not (Test-Path -LiteralPath '$escapedInternalRoot' -PathType Leaf)) {
    if (-not `$caddyProcess.HasExited) { Stop-Process -Id `$caddyProcess.Id -Force -ErrorAction SilentlyContinue }
    `$caddyProcess.WaitForExit()
    exit 1
}
`$bytes = [IO.File]::ReadAllBytes('$escapedInternalRoot')
Remove-Item -LiteralPath '$escapedPublicRoot' -Force -ErrorAction SilentlyContinue
[IO.File]::WriteAllBytes('$escapedPublicRoot', `$bytes)
`$caddyProcess.WaitForExit()
exit 1
"@
}

function Get-CaddyFailureDiagnostics {
    $sections = New-Object Collections.Generic.List[string]
    foreach ($logName in @('caddy.stderr.log', 'caddy.stdout.log', 'caddy.log')) {
        $logPath = Join-Path $logsPath $logName
        if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) { continue }
        $lines = @(Get-Content -LiteralPath $logPath -Tail 40 -ErrorAction SilentlyContinue)
        if ($lines.Count -gt 0) {
            $sections.Add("[$logName]`r`n" + ($lines -join "`r`n"))
        }
    }
    try {
        $taskInfo = Get-ScheduledTaskInfo -TaskName $script:TaskName -ErrorAction Stop
        $sections.Add("[排程工作] LastTaskResult=$($taskInfo.LastTaskResult); LastRunTime=$($taskInfo.LastRunTime)")
    } catch {}
    return ($sections -join "`r`n`r`n")
}

function Register-CaddyTask {
    Add-Action 'RegisterSystemScheduledTask'
    if ($DryRun) { return }
    $taskCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$runnerPath`""
    & schtasks.exe /Create /TN $script:TaskName /SC ONSTART /RU SYSTEM /RL HIGHEST /TR $taskCommand /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '建立 Caddy 開機排程工作失敗。' }
}

function Ensure-Firewall {
    Add-Action 'CreatePrivateFirewallRule443'
    if ($DryRun) { return }
    $rule = Get-NetFirewallRule -DisplayName $script:FirewallName -ErrorAction SilentlyContinue
    if (-not $rule) {
        New-NetFirewallRule -DisplayName $script:FirewallName -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Private | Out-Null
    }
}

function Protect-CaddyPrivateData {
    Add-Action 'ProtectCaddyPrivateKeyAcl'
    if ($DryRun) { return }
    & icacls.exe $dataPath /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '無法限制 Caddy 私鑰目錄權限。' }
}

function Protect-CaddyDeploymentAcl {
    Add-Action 'ProtectCaddyDeploymentAcl'
    if ($DryRun) { return }
    & icacls.exe $DataRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '無法保護 Caddy 設定與成員安裝器目錄權限。' }
    foreach ($publicAclPath in @($configHome, $clientRoot, $logsPath)) {
        if (-not (Test-Path -LiteralPath $publicAclPath)) { continue }
        & icacls.exe $publicAclPath /reset /T /C | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "無法重設公開部署目錄的繼承權限：$publicAclPath" }
    }
}

function Assert-ViewerHttpsReadableFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }

    $stream = $null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    } catch {
        throw "舊版部署檔案權限修復後仍無法讀取：$Path。請確認此 BAT 已用系統管理員權限執行。"
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

function Test-ViewerHttpsPathEntryExists {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (Test-Path -LiteralPath $Path) { return $true }
    try {
        $parent = [IO.Path]::GetDirectoryName($Path)
        $name = [IO.Path]::GetFileName($Path)
        $entries = [IO.Directory]::EnumerateFileSystemEntries($parent, $name, [IO.SearchOption]::TopDirectoryOnly)
        return $entries.GetEnumerator().MoveNext()
    } catch {
        return $false
    }
}

function Repair-ViewerHttpsLegacyFileAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-ViewerHttpsPathEntryExists $Path)) { return }

    & takeown.exe /F $Path /A | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "無法接管舊版部署檔案（takeown exit $LASTEXITCODE）：$Path" }
    & icacls.exe $Path /reset | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "無法重設舊版部署檔案權限（icacls reset exit $LASTEXITCODE）：$Path" }
    & icacls.exe $Path /inheritance:e /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' '*S-1-5-32-545:R' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "無法套用舊版部署檔案權限（icacls grant exit $LASTEXITCODE）：$Path" }
    Assert-ViewerHttpsReadableFile $Path
}

function Remove-ViewerHttpsPartialInstallFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-ViewerHttpsPathEntryExists $Path)) { return }

    & takeown.exe /F $Path /A | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "無法接管未完成的舊版部署檔案：$Path" }
    & icacls.exe $Path /reset | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "無法重設未完成的舊版部署檔案權限：$Path" }
    & icacls.exe $Path /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "無法取得未完成的舊版部署檔案控制權：$Path" }
    Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (Test-ViewerHttpsPathEntryExists $Path) { throw "無法移除未完成的舊版部署檔案：$Path" }
}

function Reset-IncompleteCaddyPrivateData {
    Add-Action 'ResetIncompleteCaddyPrivateData'
    if ($DryRun) { return }
    if (-not (Test-Path -LiteralPath $dataPath -PathType Container)) {
        Ensure-Directory $dataPath
        return
    }

    & takeown.exe /F $dataPath /A /R /D Y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "無法接管未完成的 Caddy 私鑰目錄：$dataPath" }
    & icacls.exe $dataPath /reset /T /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "無法重設未完成的 Caddy 私鑰目錄權限：$dataPath" }
    & icacls.exe $dataPath /inheritance:e /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T /C | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "無法取得未完成的 Caddy 私鑰目錄控制權：$dataPath" }
    Remove-Item -LiteralPath $dataPath -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $dataPath) { throw "無法移除未完成的 Caddy 私鑰目錄：$dataPath" }
    Ensure-Directory $dataPath
}

function RepairLegacyCaddyDeploymentAcl {
    if ($DryRun -or -not (Test-Path -LiteralPath $DataRoot)) { return }
    Add-Action 'RepairLegacyCaddyDeploymentAcl'

    & takeown.exe /F $DataRoot /A /R /D Y | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "無法接管舊版 Caddy 部署檔案（takeown exit $LASTEXITCODE）：$DataRoot"
    }

    & icacls.exe $DataRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "無法修復舊版 Caddy 部署檔案權限（icacls exit $LASTEXITCODE）：$DataRoot"
    }

    Repair-ViewerHttpsLegacyFileAcl $configPath
    $previousState = Read-State
    $existingCaddyTask = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
    $taskHealthy = $existingCaddyTask -and [string]$existingCaddyTask.State -eq 'Running'
    $deploymentComplete = $previousState -and $taskHealthy
    if ($deploymentComplete) {
        foreach ($legacyFile in @($caddyfilePath, $runnerPath, $installerPath)) {
            Repair-ViewerHttpsLegacyFileAcl $legacyFile
        }
    } else {
        # Remove the stale partial files and rebuild the unreadable private CA dir FIRST,
        # and only then drop the old trusted root. If a file/ACL step throws, the previous
        # CA is still trusted (recoverable) instead of being removed with no rollback;
        # this cert removal runs before the protective try-block in Invoke-Install.
        foreach ($partialFile in @($candidateCaddyfilePath, $caddyfilePath, $runnerPath, $configPath, $installerPath)) {
            Remove-ViewerHttpsPartialInstallFile $partialFile
        }
        Reset-IncompleteCaddyPrivateData
        if ($previousState -and -not $deploymentComplete) {
            RemoveTrustedRootCertificate -State $previousState
        }
        $previousState = $null
    }

    foreach ($publicDirectory in @($configHome, $clientRoot, $logsPath)) {
        if (-not (Test-Path -LiteralPath $publicDirectory -PathType Container)) { continue }
        & takeown.exe /F $publicDirectory /A /R /D Y | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "無法接管舊版部署目錄：$publicDirectory" }
        & icacls.exe $publicDirectory /reset /T | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "無法重設舊版部署目錄權限：$publicDirectory" }
        & icacls.exe $publicDirectory /inheritance:e | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "無法套用舊版部署目錄權限：$publicDirectory" }
    }

    if ($deploymentComplete -and (Test-Path -LiteralPath $dataPath -PathType Container)) {
        & takeown.exe /F $dataPath /A | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "無法接管舊版 Caddy 私鑰目錄：$dataPath" }
        & icacls.exe $dataPath /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "無法修復舊版 Caddy 私鑰目錄權限：$dataPath" }
    }
    return $previousState
}

function Stop-OrphanedViewerHttpsCaddy {
    if ($DryRun) { return }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 443 -ErrorAction SilentlyContinue)
    foreach ($listener in $listeners) {
        $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
        if ($process -and $process.ProcessName -eq 'caddy') {
            Stop-Process -Id $process.Id -Force -ErrorAction Stop
        }
    }
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-NetTCPConnection -State Listen -LocalPort 443 -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 250
    }
}

function Restart-CaddyTask {
    Add-Action 'RestartCaddyScheduledTask'
    if ($DryRun) { return }
    Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
    Stop-OrphanedViewerHttpsCaddy
    Start-ScheduledTask -TaskName $script:TaskName
}

function Wait-ForFile([string]$Path, [int]$Seconds = 20) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        if (Test-Path -LiteralPath $Path -PathType Leaf) { return $true }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Test-HttpsHealth([string]$Url) {
    if ($DryRun) { return $true }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri ($Url.TrimEnd('/') + '/api/auth/status') -TimeoutSec 10
        return $response.StatusCode -eq 200
    } catch { return $false }
}

function Wait-ForHttpsHealth([string]$Url, [int]$Seconds = 20) {
    if ($DryRun) { return $true }
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        if (Test-HttpsHealth $Url) { return $true }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $false
}

function Update-SecureCookie([bool]$Enabled) {
    Add-Action $(if ($Enabled) { 'EnableViewerSecureCookiesAfterHealthCheck' } else { 'DisableViewerSecureCookies' })
    if ($DryRun) { return }
    $root = @{}
    if (Test-Path -LiteralPath $viewerConfigPath) {
        $loaded = Get-Content -LiteralPath $viewerConfigPath -Raw | ConvertFrom-Json
        foreach ($property in $loaded.PSObject.Properties) { $root[$property.Name] = $property.Value }
    }
    $team = @{}
    if ($root.ContainsKey('Team') -and $root.Team) {
        foreach ($property in $root.Team.PSObject.Properties) { $team[$property.Name] = $property.Value }
    }
    $team.secureCookies = $Enabled
    $root.Team = $team
    Write-JsonAtomic $viewerConfigPath $root
}

function Get-CaddyInternalRootCertificatePath {
    return Join-Path $dataPath 'caddy\pki\authorities\local\root.crt'
}

function Get-RootCertificatePath {
    return $publicRootCertificatePath
}

function Install-ViewerHttpsRootCertificate {
    param([Parameter(Mandatory = $true)][string]$CertificatePath)

    Add-Action 'InstallServerRootCertificate'
    if ($DryRun) { return [pscustomobject]@{ Thumbprint = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; NewlyImported = $false } }

    $storePath = 'Cert:\LocalMachine\Root'
    $certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($CertificatePath)
    $certificateThumbprint = $certificate.Thumbprint.ToUpperInvariant()
    if ($certificateThumbprint -notmatch '^[A-F0-9]{40,64}$') {
        throw 'Caddy 根憑證沒有有效的指紋。'
    }

    $existingCertificate = Get-ChildItem -LiteralPath $storePath -ErrorAction Stop |
        Where-Object { $_.Thumbprint -eq $certificateThumbprint } |
        Select-Object -First 1
    if (-not $existingCertificate) {
        Import-Certificate -FilePath $CertificatePath -CertStoreLocation $storePath -ErrorAction Stop | Out-Null
    }

    $trustedCertificate = Get-ChildItem -LiteralPath $storePath -ErrorAction Stop |
        Where-Object { $_.Thumbprint -eq $certificateThumbprint } |
        Select-Object -First 1
    if (-not $trustedCertificate) {
        throw "無法在本機電腦的受信任根憑證存放區確認 Caddy 根憑證：$certificateThumbprint"
    }

    return [pscustomobject]@{ Thumbprint = $certificateThumbprint; NewlyImported = (-not $existingCertificate) }
}

function Write-GeneratedFiles($selection, [string]$CaddyPath, [bool]$Configured) {
    Ensure-Directory $DataRoot; Ensure-Directory $clientRoot; Ensure-Directory $dataPath; Ensure-Directory $configHome; Ensure-Directory $logsPath
    Write-Utf8Bom $caddyfilePath (New-ViewerHttpsCaddyfile -Address $selection.address)
    Write-Utf8Bom $runnerPath (New-Runner -CaddyPath $CaddyPath)

    $version = (Get-Date).ToString('yyyyMMdd-HHmmss')
    $rootCertPath = Get-RootCertificatePath
    if ($DryRun) {
        $certificateBase64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('dry-run-root-certificate'))
        $thumbprint = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    } else {
        if (-not (Wait-ForFile $rootCertPath 20)) { throw "找不到 Caddy 根憑證：$rootCertPath" }
        $certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($rootCertPath)
        $certificateBase64 = [Convert]::ToBase64String($certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
        $thumbprint = $certificate.Thumbprint.ToUpperInvariant()
    }
    $installer = New-ViewerHttpsClientInstaller -CertificateBase64 $certificateBase64 -CertificateThumbprint $thumbprint -HttpsUrl $selection.httpsUrl -IPv4 $selection.ipv4 -Hostname $selection.hostname -Version $version
    Write-Ascii $installerPath $installer
    $state = [ordered]@{
        schemaVersion = 1
        configured = $Configured
        addressMode = $selection.mode
        ipv4 = $selection.ipv4
        hostname = $selection.hostname
        httpsUrl = $selection.httpsUrl
        installerVersion = $version
        installerFile = 'client/Install-UE-Mat-HTTPS.cmd'
        certificateThumbprint = $thumbprint
        caddyPath = $CaddyPath
        repoRoot = $RepoRoot
    }
    Write-JsonAtomic $configPath $state
    return $state
}

function Invoke-Install {
    Request-Elevation
    $selection = Get-AddressSelection
    Show-Step '1/8' '檢查 Viewer 是否正在 127.0.0.1:5790 執行...'
    if (-not (Test-ViewerHttp)) { throw 'Viewer 尚未在 http://127.0.0.1:5790 正常執行。請先啟動 Viewer。' }
    Show-Step '2/8' '檢查 Caddy；首次使用時會自動安裝...'
    $caddyPath = Ensure-Caddy
    Show-Step '3/8' '準備 Caddy 設定與受保護的憑證目錄...'
    Add-Action 'ValidateCaddyConfiguration'
    if ($DryRun) {
        Ensure-Directory $DataRoot; Ensure-Directory $clientRoot; Ensure-Directory $dataPath; Ensure-Directory $configHome; Ensure-Directory $logsPath
        Protect-CaddyDeploymentAcl
        Protect-CaddyPrivateData
        $state = Write-GeneratedFiles $selection $caddyPath $false
        Ensure-Firewall; Register-CaddyTask; Restart-CaddyTask
        [void](Install-ViewerHttpsRootCertificate -CertificatePath (Get-RootCertificatePath))
        Add-Action 'EnableViewerSecureCookiesAfterHealthCheck'
        return $state
    }

    Ensure-Directory $DataRoot; Ensure-Directory $clientRoot; Ensure-Directory $dataPath; Ensure-Directory $configHome; Ensure-Directory $logsPath
    $previousState = RepairLegacyCaddyDeploymentAcl
    Protect-CaddyDeploymentAcl
    Protect-CaddyPrivateData
    $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
    $snapshots = @(
        (Get-FileSnapshot $caddyfilePath),
        (Get-FileSnapshot $runnerPath),
        (Get-FileSnapshot $configPath),
        (Get-FileSnapshot $installerPath),
        (Get-FileSnapshot $publicRootCertificatePath),
        (Get-FileSnapshot $hostsPath)
    )
    $existingTask = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
    $taskExisted = $null -ne $existingTask
    $taskWasRunning = $taskExisted -and [string]$existingTask.State -eq 'Running'
    $firewallExisted = $null -ne (Get-NetFirewallRule -DisplayName $script:FirewallName -ErrorAction SilentlyContinue)
    $newlyTrustedThumbprint = $null

    try {
        Write-Utf8Bom $candidateCaddyfilePath (New-ViewerHttpsCaddyfile -Address $selection.address)
        Show-Step '4/8' '驗證候選 Caddy 設定...'
        Invoke-CaddyValidation -CaddyPath $caddyPath -ConfigPath $candidateCaddyfilePath
        Move-Item -LiteralPath $candidateCaddyfilePath -Destination $caddyfilePath -Force
        Write-Utf8Bom $runnerPath (New-Runner -CaddyPath $caddyPath)
        Set-ServerHosts $selection.ipv4 $selection.hostname
        Show-Step '5/8' '建立防火牆規則與開機排程工作...'
        Remove-Item -LiteralPath $publicRootCertificatePath -Force -ErrorAction SilentlyContinue
        Ensure-Firewall; Register-CaddyTask; Restart-CaddyTask
        $rootCertPath = Get-RootCertificatePath
        Show-Step '6/8' '等待 Caddy 匯出公開根憑證（最長 30 秒）...'
        if (-not (Wait-ForFile $rootCertPath 30)) { throw "Caddy 未匯出公開根憑證，請查看 $logsPath。" }
        Show-Step '7/8' '信任本機根憑證並檢查 HTTPS...'
        $rootTrust = Install-ViewerHttpsRootCertificate -CertificatePath $rootCertPath
        $trustedRootThumbprint = $rootTrust.Thumbprint
        if ($rootTrust.NewlyImported) { $newlyTrustedThumbprint = $rootTrust.Thumbprint }
        if (-not (Wait-ForHttpsHealth $selection.httpsUrl 20)) { throw "HTTPS 健康檢查失敗：$($selection.httpsUrl)" }
        Show-Step '8/8' '產生成員安裝器並更新 Viewer 安全設定...'
        $state = Write-GeneratedFiles $selection $caddyPath $true
        if ($state.certificateThumbprint -ne $trustedRootThumbprint) {
            throw '伺服器信任的根憑證與成員安裝器內的根憑證不一致。'
        }
        Update-SecureCookie $true
        return $state
    } catch {
        $failure = $_
        $failureDiagnostics = Get-CaddyFailureDiagnostics
        try {
            RestorePreviousCaddyDeployment -Snapshots $snapshots -TaskExisted $taskExisted -TaskWasRunning $taskWasRunning -FirewallExisted $firewallExisted
        } catch {
            Write-Warning ('自動復原失敗：' + $_.Exception.Message)
        }
        if ($newlyTrustedThumbprint) {
            try { RemoveTrustedRootCertificate -State ([pscustomobject]@{ certificateThumbprint = $newlyTrustedThumbprint }) }
            catch { Write-Warning ('無法移除安裝失敗時新增的根憑證：' + $_.Exception.Message) }
        }
        if ($failureDiagnostics) {
            $failureLogPath = Join-Path $logsPath 'last-failure.log'
            try {
                Write-Utf8Bom $failureLogPath ((Get-Date).ToString('o') + "`r`n" + $failure.Exception.Message + "`r`n`r`n" + $failureDiagnostics)
            } catch {}
            throw ($failure.Exception.Message + "`r`n`r`nCaddy 診斷：`r`n" + $failureDiagnostics + "`r`n`r`n完整診斷：" + $failureLogPath)
        }
        throw $failure
    }
}

function Invoke-Status {
    $state = Read-State
    $caddyPath = Find-Caddy
    $task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(443, 5790) } | Select-Object LocalAddress, LocalPort, OwningProcess)
    $partialInstall = (Test-Path -LiteralPath $DataRoot) -and $null -eq $state
    return [ordered]@{
        command = 'status'
        configPresent = $null -ne $state
        partialInstall = $partialInstall
        httpsUrl = if ($state) { $state.httpsUrl } else { $null }
        configured = if ($state) { [bool]$state.configured } else { $false }
        caddyInstalled = $null -ne $caddyPath
        caddyPath = $caddyPath
        taskState = if ($task) { [string]$task.State } else { 'NotInstalled' }
        listeners = $listeners
        dataRoot = $DataRoot
        nextAction = if ($partialInstall) { '重新雙擊 tools\viewer-https\Manage-ViewerHttps.bat，選擇 1 以安全修復未完成的安裝。' } else { $null }
    }
}

function Invoke-Restart {
    Request-Elevation
    $state = Read-State
    if (-not $state) { throw '尚未安裝 UE-Mat HTTPS。' }
    $caddyPath = if ($state.caddyPath) { [string]$state.caddyPath } else { Find-Caddy }
    if (-not $caddyPath) { throw '找不到 Caddy。' }
    Add-Action 'ValidateCaddyConfiguration'
    if (-not $DryRun) { Invoke-CaddyValidation -CaddyPath $caddyPath -ConfigPath $caddyfilePath }
    Restart-CaddyTask
    if (-not $DryRun -and -not (Wait-ForHttpsHealth ([string]$state.httpsUrl) 20)) { throw '重新啟動後 HTTPS 健康檢查失敗。' }
    return $state
}

function Invoke-Update {
    Request-Elevation
    Add-Action 'UpdateCaddyWithWinget'
    if (-not $DryRun) {
        if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) { throw '找不到 winget。' }
        $wingetResult = Invoke-ViewerHttpsNativeCommand -ShowOutput (-not $Json) -Command { & winget.exe upgrade --id CaddyServer.Caddy -e --source winget --accept-source-agreements --accept-package-agreements --disable-interactivity }
        $wingetExitCode = [int]$wingetResult.ExitCode
        if (-not (Test-ViewerHttpsWingetUpgradeSuccess $wingetExitCode)) { throw "winget 更新 Caddy 失敗（exit $wingetExitCode）。" }
        if ($wingetExitCode -eq -1978335189 -and -not $Json) { Write-Host 'Caddy 已是最新版。' -ForegroundColor Green }
    }
    return Invoke-Restart
}

function Invoke-ExportCert {
    $state = Read-State
    if (-not $state -or -not (Test-Path -LiteralPath $installerPath)) { throw '尚未產生成員安裝器。' }
    if (-not $ExportPath) { $script:ExportPath = Read-Host '請輸入輸出資料夾' }
    Ensure-Directory $ExportPath
    $target = Join-Path ([IO.Path]::GetFullPath($ExportPath)) $script:InstallerName
    Copy-Item -LiteralPath $installerPath -Destination $target -Force
    return [ordered]@{ exported = $true; path = $target; httpsUrl = $state.httpsUrl }
}

function Invoke-Uninstall {
    Request-Elevation
    $state = Read-State
    $caddyUninstalled = $false
    Add-Action 'RemoveCaddyScheduledTask'
    Add-Action 'RemovePrivateFirewallRule443'
    Add-Action 'DisableViewerSecureCookies'
    if ($DryRun -and $RemoveCa) { RemoveTrustedRootCertificate -State $state }
    if (-not $DryRun) {
        Stop-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction SilentlyContinue
        Remove-NetFirewallRule -DisplayName $script:FirewallName -ErrorAction SilentlyContinue
        Remove-ServerHostsBlock
        Update-SecureCookie $false
        if (Test-Path -LiteralPath $configPath) {
            $state.configured = $false
            Write-JsonAtomic $configPath $state
        }
        if ($RemoveCa) {
            RemoveTrustedRootCertificate -State $state
            Remove-Item -LiteralPath $dataPath -Recurse -Force -ErrorAction SilentlyContinue
        }
        if ($UninstallCaddy) {
            $caddyUninstallResult = Invoke-ViewerHttpsNativeCommand -ShowOutput (-not $Json) -Command { & winget.exe uninstall --id CaddyServer.Caddy -e --source winget --disable-interactivity }
            $caddyUninstalled = [int]$caddyUninstallResult.ExitCode -eq 0
            if (-not $caddyUninstalled -and -not $Json) {
                Write-Host "Caddy 解除安裝未成功（exit $($caddyUninstallResult.ExitCode)），已保留 Caddy 程式。" -ForegroundColor Yellow
            }
        }
    }
    $caddyPreserved = if ($DryRun) { -not $UninstallCaddy } else { -not $caddyUninstalled }
    return [ordered]@{ uninstalled = $true; caPreserved = -not $RemoveCa; caddyPreserved = $caddyPreserved }
}

function RemoveTrustedRootCertificate {
    param($State)
    Add-Action 'RemoveTrustedRootCertificate'
    if ($DryRun) { return }

    $thumbprint = if ($State -and $State.certificateThumbprint) { [string]$State.certificateThumbprint } else { '' }
    if (-not $thumbprint -and (Test-Path -LiteralPath (Get-RootCertificatePath))) {
        $certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2((Get-RootCertificatePath))
        $thumbprint = $certificate.Thumbprint
    }
    if ($thumbprint -notmatch '^[A-Fa-f0-9]{40,64}$') { throw '找不到可安全移除的 UE-Mat 根憑證指紋。' }

    foreach ($store in @('Cert:\LocalMachine\Root', 'Cert:\CurrentUser\Root')) {
        Get-ChildItem -LiteralPath $store -ErrorAction SilentlyContinue |
            Where-Object { $_.Thumbprint -eq $thumbprint } |
            Remove-Item -Force -ErrorAction Stop
    }
}

function Remove-DryRunArtifacts {
    if ($script:CleanupDryRunRoot -and (Test-Path -LiteralPath $DataRoot)) {
        Remove-Item -LiteralPath $DataRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Show-Menu {
    Write-Host ''
    Write-Host 'UE-Mat Viewer HTTPS 管理工具' -ForegroundColor Cyan
    Write-Host '1. 首次安裝／重新設定'
    Write-Host '2. 查看狀態'
    Write-Host '3. 重新啟動 Caddy'
    Write-Host '4. 更新 Caddy'
    Write-Host '5. 修改 HTTPS 位址'
    Write-Host '6. 匯出成員安裝器'
    Write-Host '7. 解除安裝'
    $choice = Read-Host '請輸入 1-7'
    $selected = switch ($choice) {
        '1' { 'install' }
        '2' { 'status' }
        '3' { 'restart' }
        '4' { 'update' }
        '5' { 'change-address' }
        '6' { 'export-cert' }
        '7' { 'uninstall' }
        default { throw '選項無效。' }
    }
    return $selected
}

try {
    if (-not $Command) { $Command = Show-Menu }
    $result = switch ($Command) {
        'install' { Invoke-Install }
        'status' { Invoke-Status }
        'restart' { Invoke-Restart }
        'update' { Invoke-Update }
        'change-address' { Invoke-Install }
        'export-cert' { Invoke-ExportCert }
        'uninstall' { Invoke-Uninstall }
    }

    if ($Command -eq 'install' -or $Command -eq 'change-address') {
        $result = [ordered]@{
            command = $Command
            dryRun = [bool]$DryRun
            httpsUrl = $result.httpsUrl
            dataRoot = $DataRoot
            actions = @($script:Actions)
        }
    } elseif ($result -is [Collections.IDictionary]) {
        $result.actions = @($script:Actions)
    }

    if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
    else {
        if ($Command -eq 'status') { $result | Format-List }
        elseif ($Command -eq 'install' -or $Command -eq 'change-address') {
            Write-Host "HTTPS 設定完成：$($result.httpsUrl)" -ForegroundColor Green
            if ($DryRun) { Write-Host '這是 DryRun，未修改系統設定。' -ForegroundColor Yellow }
        } else { $result | Format-List }
    }
    Remove-DryRunArtifacts
} catch {
    Remove-DryRunArtifacts
    if ($Json) { [ordered]@{ ok = $false; error = $_.Exception.Message; actions = @($script:Actions) } | ConvertTo-Json -Depth 6 -Compress }
    else { Write-Host ('操作失敗：' + $_.Exception.Message) -ForegroundColor Red }
    exit 1
}

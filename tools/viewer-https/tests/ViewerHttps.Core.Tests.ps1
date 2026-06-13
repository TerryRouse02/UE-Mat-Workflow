$ErrorActionPreference = 'Stop'

$modulePath = Join-Path $PSScriptRoot '..\ViewerHttps.Core.psm1'
Import-Module $modulePath -Force

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw "ASSERT TRUE FAILED: $Message" }
}

function Assert-False {
    param([bool]$Condition, [string]$Message)
    if ($Condition) { throw "ASSERT FALSE FAILED: $Message" }
}

function Assert-Equal {
    param($Expected, $Actual, [string]$Message)
    if ($Expected -ne $Actual) {
        throw "ASSERT EQUAL FAILED: $Message`nExpected: $Expected`nActual:   $Actual"
    }
}

Assert-True (Test-ViewerHttpsIPv4 '192.168.71.92') 'valid private IPv4'
Assert-False (Test-ViewerHttpsIPv4 '192.168.71.999') 'invalid IPv4 octet'
Assert-False (Test-ViewerHttpsIPv4 '198.18.0.1') 'benchmark/virtual range is not a WLAN address'

Assert-True (Test-ViewerHttpsHostname 'ue-mat.local') 'valid local hostname'
Assert-False (Test-ViewerHttpsHostname 'https://ue-mat.local') 'URL is not a hostname'
Assert-False (Test-ViewerHttpsHostname 'ue mat.local') 'spaces are rejected'

$fontCandidates = @(Get-ViewerHttpsConsoleFontCandidates)
Assert-True ($fontCandidates -contains '細明體') 'Traditional Chinese console font is preferred when available'
Assert-True ($fontCandidates -contains '新宋体') 'Simplified Chinese console font is available as a fallback'

Assert-True (Test-ViewerHttpsWingetUpgradeSuccess 0) 'winget upgrade success exit code'
Assert-True (Test-ViewerHttpsWingetUpgradeSuccess -1978335189) 'winget no-applicable-update is a successful maintenance outcome'
Assert-False (Test-ViewerHttpsWingetUpgradeSuccess 1) 'other winget failures remain failures'

$nativeResultItems = @(Invoke-ViewerHttpsNativeCommand -Command { & cmd.exe /d /c 'echo fake-progress & exit /b 23' } -ShowOutput $false)
Assert-Equal 1 $nativeResultItems.Count 'native command progress never leaks into the function return stream'
Assert-Equal 23 $nativeResultItems[0].ExitCode 'native command exit code is preserved'
Assert-True (($nativeResultItems[0].Output -join "`n") -match 'fake-progress') 'native command output remains available for diagnostics'

$ipConfig = New-ViewerHttpsCaddyfile -Address '192.168.71.92'
Assert-True ($ipConfig -match [regex]::Escape('https://192.168.71.92')) 'IP site address'
Assert-True ($ipConfig -match [regex]::Escape('reverse_proxy 127.0.0.1:5790')) 'viewer upstream'
Assert-True ($ipConfig -match 'tls internal') 'internal CA'
Assert-False ($ipConfig -match '(?m)^    (tls|reverse_proxy)') 'generated Caddyfile uses Caddy native tab indentation'

$hostConfig = New-ViewerHttpsCaddyfile -Address 'ue-mat.local'
Assert-True ($hostConfig -match [regex]::Escape('https://ue-mat.local')) 'hostname site address'

$originalHosts = "127.0.0.1 localhost`r`n10.0.0.2 old.local`r`n"
$withBlock = Set-ViewerHttpsHostsBlock -Content $originalHosts -IPv4 '192.168.71.92' -Hostname 'ue-mat.local'
Assert-True ($withBlock -match '192\.168\.71\.92 ue-mat\.local') 'hosts mapping inserted'
Assert-True ($withBlock -match '10\.0\.0\.2 old\.local') 'unrelated hosts content preserved'
$updatedBlock = Set-ViewerHttpsHostsBlock -Content $withBlock -IPv4 '192.168.71.93' -Hostname 'ue-mat.local'
Assert-Equal 1 ([regex]::Matches($updatedBlock, '# BEGIN UE-MAT HTTPS').Count) 'hosts marker remains idempotent'
Assert-True ($updatedBlock -match '192\.168\.71\.93 ue-mat\.local') 'hosts mapping updated'

$fakeCert = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes('fake-root-cert'))
$installer = New-ViewerHttpsClientInstaller -CertificateBase64 $fakeCert -CertificateThumbprint 'ABC123' -HttpsUrl 'https://ue-mat.local/' -IPv4 '192.168.71.92' -Hostname 'ue-mat.local' -Version '20260613-1'
Assert-True ($installer -match [regex]::Escape($fakeCert)) 'certificate embedded'
Assert-True ($installer -match [regex]::Escape('https://ue-mat.local/')) 'target URL embedded'
Assert-True ($installer -match 'Start-Process.+RunAs') 'installer requests elevation'
Assert-True ($installer -match '__UE_MAT_POWERSHELL_PAYLOAD__') 'installer carries a self-read payload marker'
Assert-True ($installer -match 'ReadAllText') 'installer reads its payload from itself'
Assert-False ($installer -match 'PRIVATE KEY') 'installer contains no private key marker'
$payloadMarker = '__UE_MAT_POWERSHELL_PAYLOAD__'
$payloadBase64 = $installer.Substring($installer.LastIndexOf($payloadMarker) + $payloadMarker.Length).Trim()
$payloadSource = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($payloadBase64))
$payloadTokens = $null
$payloadErrors = $null
[Management.Automation.Language.Parser]::ParseInput($payloadSource, [ref]$payloadTokens, [ref]$payloadErrors) | Out-Null
Assert-Equal 0 $payloadErrors.Count 'generated member installer PowerShell payload parses under Windows PowerShell 5.1'
Assert-True ($payloadSource -match 'Import-Certificate') 'generated member installer imports the public root certificate'
Assert-True ($payloadSource -match [regex]::Escape('192.168.71.92 ue-mat.local')) 'hostname installer writes the requested hosts mapping'

# Guard the shipped self-extraction against regressing to IndexOf. The marker appears
# TWICE in the generated .cmd (once inside the extraction command, once as the real
# delimiter), so the runtime MUST use LastIndexOf; the first IndexOf match is invalid
# base64 and crashes every member install. This test exercises the actual extraction
# algorithm rather than reimplementing a correct one.
Assert-Equal 2 ([regex]::Matches($installer, [regex]::Escape($payloadMarker)).Count) 'installer embeds the payload marker exactly twice (command + delimiter)'
Assert-True ($installer -match 'LastIndexOf\(\$m\)') 'shipped installer extracts its payload with LastIndexOf, not the first IndexOf match'
$firstMatchPayload = $installer.Substring($installer.IndexOf($payloadMarker) + $payloadMarker.Length).Trim()
$indexOfWouldFail = $false
try { [void][Convert]::FromBase64String($firstMatchPayload) } catch { $indexOfWouldFail = $true }
Assert-True $indexOfWouldFail 'first-match (IndexOf) extraction is invalid base64; proves LastIndexOf is required'

$elevationArgs = New-ViewerHttpsElevationArguments -ScriptPath 'D:\Repo\tools\viewer-https\Manage-ViewerHttps.ps1' -Command 'install' -BoundParameters @{ AddressMode = 'ip'; Address = '192.168.71.92'; DryRun = [Management.Automation.SwitchParameter]::new($true) }
Assert-Equal '-NoProfile' $elevationArgs[0] 'elevation starts without profile'
Assert-True ($elevationArgs -contains 'install') 'elevation preserves command'
Assert-True ($elevationArgs -contains '-AddressMode') 'elevation preserves named parameter'
Assert-True ($elevationArgs -contains '192.168.71.92') 'elevation preserves parameter value'
Assert-True ($elevationArgs -contains '-DryRun') 'elevation preserves switches'

$managerPath = Join-Path $PSScriptRoot '..\Manage-ViewerHttps.ps1'
$launcherPath = Join-Path $PSScriptRoot '..\Manage-ViewerHttps.bat'
$managerSource = [IO.File]::ReadAllText($managerPath)
$launcherSource = [IO.File]::ReadAllText($launcherPath)

# These tool scripts deliberately ship as UTF-8 WITH a BOM so Windows PowerShell 5.1 decodes
# their Traditional Chinese UX strings correctly (the CLAUDE.md rule 4 BOM exception). Guard the
# BOM: an editor or tool that strips it would silently corrupt every CJK string on PS 5.1.
foreach ($bomFile in @($managerPath, $modulePath, $PSCommandPath)) {
    $head = [IO.File]::ReadAllBytes($bomFile)
    Assert-True ($head.Length -ge 3 -and $head[0] -eq 0xEF -and $head[1] -eq 0xBB -and $head[2] -eq 0xBF) "tool script keeps its UTF-8 BOM: $bomFile"
}

Assert-False ($launcherSource -match '(?im)^\s*start\s') 'BAT must not leave a detached launcher window'
Assert-False ($launcherSource -match '(?i)-NoExit') 'BAT must close after the user acknowledges the result'
Assert-True ($launcherSource -match '(?i)Start-Process.+RunAs') 'BAT requests elevation itself before starting PowerShell'
Assert-True ($launcherSource -match '(?s)Start-Process.+RunAs.+if errorlevel 1.+pause') 'BAT keeps UAC cancellation errors visible'
Assert-True ($launcherSource -match '(?im)^\s*pause\s*$') 'BAT keeps the final result visible for beginners'
Assert-True ($managerSource -match 'Invoke-ViewerHttpsNativeCommand.+winget\.exe\s+install') 'winget install uses the output-isolating native command wrapper'
Assert-True ($managerSource -match 'Invoke-ViewerHttpsNativeCommand.+winget\.exe\s+upgrade') 'winget update uses the output-isolating native command wrapper'
Assert-True ($managerSource -match '(?s)function Invoke-Caddy.+\$nativeOutput\s*=\s*@\(& \$CaddyPath @Arguments 2>&1\).+Write-Host.+return') 'Caddy diagnostics are displayed without contaminating the success output stream'
Assert-True ($managerSource -match '(?s)function Invoke-Caddy.+\$previousErrorActionPreference.+\$ErrorActionPreference\s*=\s*''Continue''.+\$nativeOutput.+finally.+\$ErrorActionPreference\s*=\s*\$previousErrorActionPreference') 'Caddy stderr is non-terminating only during the native command on Windows PowerShell 5.1'
Assert-True ($managerSource -match "Show-Step\s+'1/8'") 'interactive install reports progress immediately after address input'
Assert-True ($managerSource -match 'Initialize-ViewerHttpsConsole') 'manager initializes a CJK-capable font for the current console window'
Assert-True ($managerSource -match 'ProtectCaddyDeploymentAcl') 'deployment root ACL is explicitly protected'
Assert-False ($managerSource -match 'icacls\.exe\s+\$DataRoot\s+/inheritance:r\s+/grant:r[^\r\n]+/T') 'deployment directory inheritance ACEs are never recursively written onto ordinary files'
Assert-False ($managerSource -match 'icacls\.exe\s+\$dataPath\s+/inheritance:r\s+/grant:r[^\r\n]+/T') 'private-data directory inheritance ACEs are never recursively written onto CA files'
Assert-True ($managerSource -match '(?s)Protect-CaddyDeploymentAcl.+publicAclPath.+/reset.+/T') 'public deployment children are reset to inherit the protected root ACL'
Assert-True ($managerSource -match 'RepairLegacyCaddyDeploymentAcl') 'legacy child files with unreadable ACLs are migrated'
Assert-True ($managerSource -match '(?s)RepairLegacyCaddyDeploymentAcl.+Get-FileSnapshot\s+\$caddyfilePath') 'legacy ACL repair runs before reading the existing Caddyfile snapshot'
Assert-True ($managerSource -match '(?s)Repair-ViewerHttpsLegacyFileAcl.+icacls\.exe\s+\$Path\s+/reset.+Assert-ViewerHttpsReadableFile') 'legacy explicit file ACLs are reset and verified before final grants'
Assert-True ($managerSource -match 'Assert-ViewerHttpsReadableFile') 'legacy ACL repair verifies real file readability instead of trusting icacls exit code'
Assert-True ($managerSource -match '(?s)RepairLegacyCaddyDeploymentAcl.+\$caddyfilePath.+\$runnerPath.+Repair-ViewerHttpsLegacyFileAcl\s+\$legacyFile') 'known legacy files are repaired and verified individually'
Assert-True ($managerSource -match 'Remove-ViewerHttpsPartialInstallFile') 'incomplete legacy generated files are discarded instead of snapshotted'
Assert-True ($managerSource -match 'Reset-IncompleteCaddyPrivateData') 'incomplete first installs rebuild an unreadable private CA directory'
Assert-True ($managerSource -match '(?s)\$existingCaddyTask\s*=.+Get-ScheduledTask.+\$taskHealthy\s*=.+State.+Running.+\$deploymentComplete\s*=\s*\$previousState\s+-and\s+\$taskHealthy.+if \(\$deploymentComplete\).+else \{.+Reset-IncompleteCaddyPrivateData') 'private CA is preserved only when saved state and a running SYSTEM task both exist'
Assert-True ($managerSource -match '(?s)if \(\$previousState\s+-and\s+-not\s+\$deploymentComplete\).+RemoveTrustedRootCertificate') 'stale trusted roots are removed when saved state has no service task'
Assert-True ($managerSource -match '(?s)function Reset-IncompleteCaddyPrivateData.+takeown\.exe.+icacls\.exe.+Remove-Item.+Ensure-Directory') 'incomplete CA reset takes ownership, removes stale ACLs, deletes, and recreates the data directory'
Assert-True ($managerSource -match '(?s)\$previousState\s*=\s*RepairLegacyCaddyDeploymentAcl.+Get-FileSnapshot\s+\$caddyfilePath') 'legacy state is classified before snapshots are read'
Assert-True ($managerSource -match 'RemoveTrustedRootCertificate') 'RemoveCa also removes the trusted root certificate'
Assert-False ($managerSource -match "Invoke-Caddy\s+\$caddyPath\s+@\('trust'") 'install does not depend on the Caddy admin API for trust'
Assert-True ($managerSource -match 'Install-ViewerHttpsRootCertificate') 'server root certificate is imported directly into Windows trust'
Assert-True ($managerSource -match '(?s)Install-ViewerHttpsRootCertificate.+Cert:\\LocalMachine\\Root.+certificateThumbprint') 'direct trust import verifies and returns the root certificate thumbprint'
Assert-True ($managerSource -match "Caddyfile\.candidate") 'Caddy configuration is validated as a candidate before activation'
Assert-True ($managerSource -match '(?s)function Invoke-CaddyValidation.+GetTempPath.+Invoke-Caddy.+DataHome.+finally.+Remove-Item') 'candidate validation uses an isolated temporary Caddy data directory'
Assert-True ($managerSource -match 'Get-CaddyInternalRootCertificatePath') 'SYSTEM-owned internal CA path is kept separate from the exported public root certificate'
Assert-True ($managerSource -match '(?s)Get-CaddyFailureDiagnostics.+caddy\.stderr\.log.+caddy\.stdout\.log') 'failed startup reports preserved Caddy stderr and stdout diagnostics'
Assert-True ($managerSource -match '(?s)catch\s*\{.+Get-CaddyFailureDiagnostics.+RestorePreviousCaddyDeployment') 'failure diagnostics are captured before rollback removes generated files'
Assert-True ($managerSource -match '(?s)function Wait-ForHttpsHealth.+Test-HttpsHealth.+Start-Sleep') 'HTTPS readiness is polled instead of checked only once'
Assert-True ($managerSource -match '(?s)function Stop-OrphanedViewerHttpsCaddy.+Get-NetTCPConnection.+LocalPort.+443.+ProcessName.+caddy.+Stop-Process') 'restart removes only orphaned Caddy processes that own port 443'
Assert-True ($managerSource -match '(?s)function Restart-CaddyTask.+Stop-ScheduledTask.+Stop-OrphanedViewerHttpsCaddy.+Start-ScheduledTask') 'scheduled-task restart clears stale Caddy before starting the new task'
Assert-True ($managerSource -match 'RestorePreviousCaddyDeployment') 'failed install or address change restores the previous deployment'

$dryRoot = Join-Path ([IO.Path]::GetTempPath()) ('ue-mat-https-test-' + [Guid]::NewGuid().ToString('N'))
$originalLocalAppData = $env:LOCALAPPDATA
$isolatedLocalAppData = Join-Path $dryRoot 'local-app-data'
try {
    $env:LOCALAPPDATA = $isolatedLocalAppData
    $json = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $managerPath install -DryRun -Json -AddressMode ip -Address '192.168.71.92' -DataRoot $dryRoot
    if ($LASTEXITCODE -ne 0) { throw "manager dry-run failed with exit $LASTEXITCODE" }
    $plan = ($json -join "`n") | ConvertFrom-Json
    Assert-Equal 'install' $plan.command 'dry-run command'
    Assert-True $plan.dryRun 'dry-run flag'
    Assert-Equal 'https://192.168.71.92/' $plan.httpsUrl 'dry-run HTTPS URL'
    Assert-True ($plan.actions -contains 'InstallCaddyWithWinget') 'winget action planned'
    Assert-True ($plan.actions -contains 'CreatePrivateFirewallRule443') 'firewall action planned'
    Assert-True ($plan.actions -contains 'RegisterSystemScheduledTask') 'scheduled task action planned'
    Assert-True ($plan.actions -contains 'ProtectCaddyPrivateKeyAcl') 'private CA data ACL action planned'
    Assert-True ($plan.actions -contains 'ProtectCaddyDeploymentAcl') 'bootstrap config and client installer ACL action planned'
    Assert-True ($plan.actions -contains 'InstallServerRootCertificate') 'server root certificate trust action planned'
    Assert-True ($plan.actions -contains 'EnableViewerSecureCookiesAfterHealthCheck') 'secure cookie action planned'
    Assert-True (Test-Path -LiteralPath (Join-Path $dryRoot 'Caddyfile')) 'dry-run Caddyfile generated'
    Assert-True (Test-Path -LiteralPath (Join-Path $dryRoot 'config.json')) 'dry-run config generated'
    Assert-True (Test-Path -LiteralPath (Join-Path $dryRoot 'client\Install-UE-Mat-HTTPS.cmd')) 'dry-run installer generated'
    $runnerSource = Get-Content -LiteralPath (Join-Path $dryRoot 'Run-Caddy.ps1') -Raw
    Assert-False ($runnerSource -match 'Start-Job') 'SYSTEM runner avoids background PowerShell jobs'
    Assert-True ($runnerSource -match '(?s)Start-Process.+RedirectStandardOutput.+RedirectStandardError.+PassThru') 'SYSTEM runner starts Caddy as one observable child process'
    Assert-True ($runnerSource -match [regex]::Escape('caddy\pki\authorities\local\root.crt')) 'SYSTEM runner reads the protected internal root certificate'
    Assert-True ($runnerSource -match [regex]::Escape('client\Caddy-Root-CA.crt')) 'SYSTEM runner writes a public certificate copy outside the private CA directory'
    Assert-True ($runnerSource -match 'WriteAllBytes') 'public certificate copy is recreated with destination directory ACLs'
    Assert-True ($runnerSource -match '(?s)WaitForExit\(\).+exit 1') 'SYSTEM runner treats any unexpected Caddy exit as a task failure'
    Assert-False ($runnerSource -match '\.ExitCode') 'SYSTEM runner does not depend on the blank redirected Process.ExitCode in Windows PowerShell 5.1'

    $statusJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $managerPath status -Json -DataRoot $dryRoot
    if ($LASTEXITCODE -ne 0) { throw "manager status failed with exit $LASTEXITCODE" }
    $status = ($statusJson -join "`n") | ConvertFrom-Json
    Assert-True $status.configPresent 'status sees generated config'
    Assert-Equal 'https://192.168.71.92/' $status.httpsUrl 'status returns configured URL'

    foreach ($maintenanceCommand in @('restart', 'update', 'uninstall')) {
        $maintenanceJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $managerPath $maintenanceCommand -DryRun -Json -DataRoot $dryRoot
        if ($LASTEXITCODE -ne 0) { throw "$maintenanceCommand dry-run failed with exit $LASTEXITCODE" }
        $maintenance = ($maintenanceJson -join "`n") | ConvertFrom-Json
        Assert-False ($maintenance.ok -eq $false) "$maintenanceCommand dry-run returns no error"
    }

    $removeCaJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $managerPath uninstall -DryRun -Json -RemoveCa -DataRoot $dryRoot
    if ($LASTEXITCODE -ne 0) { throw "uninstall -RemoveCa dry-run failed with exit $LASTEXITCODE" }
    $removeCaPlan = ($removeCaJson -join "`n") | ConvertFrom-Json
    Assert-True ($removeCaPlan.actions -contains 'RemoveTrustedRootCertificate') 'RemoveCa plans Windows trust-store cleanup'

    $changeJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $managerPath change-address -DryRun -Json -AddressMode hostname -Address 'ue-mat.local' -IPv4 '192.168.71.92' -DataRoot $dryRoot
    if ($LASTEXITCODE -ne 0) { throw "change-address dry-run failed with exit $LASTEXITCODE" }
    $change = ($changeJson -join "`n") | ConvertFrom-Json
    Assert-Equal 'https://ue-mat.local/' $change.httpsUrl 'hostname mode URL'
    $changedConfig = Get-Content -LiteralPath (Join-Path $dryRoot 'config.json') -Raw | ConvertFrom-Json
    Assert-Equal 'hostname' $changedConfig.addressMode 'hostname mode persisted'
    Assert-Equal '192.168.71.92' $changedConfig.ipv4 'hostname mode keeps WLAN IPv4'
    Assert-True ((Get-Content -LiteralPath (Join-Path $dryRoot 'client\Install-UE-Mat-HTTPS.cmd') -Raw) -match [regex]::Escape('https://ue-mat.local/')) 'hostname installer regenerated'
} finally {
    $env:LOCALAPPDATA = $originalLocalAppData
    Remove-Item -LiteralPath $dryRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$fakeProgramData = Join-Path ([IO.Path]::GetTempPath()) ('ue-mat-fake-programdata-' + [Guid]::NewGuid().ToString('N'))
$originalProgramData = $env:ProgramData
try {
    $env:ProgramData = $fakeProgramData
    $defaultDryJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $managerPath install -DryRun -Json -AddressMode ip -Address '192.168.71.92'
    if ($LASTEXITCODE -ne 0) { throw "default dry-run failed with exit $LASTEXITCODE" }
    $defaultDry = ($defaultDryJson -join "`n") | ConvertFrom-Json
    Assert-False (Test-Path -LiteralPath $defaultDry.dataRoot) 'default DryRun removes its temporary generated files'
    Assert-False (Test-Path -LiteralPath (Join-Path $fakeProgramData 'UE-Mat-Caddy')) 'default DryRun never writes ProgramData'
} finally {
    $env:ProgramData = $originalProgramData
    Remove-Item -LiteralPath $fakeProgramData -Recurse -Force -ErrorAction SilentlyContinue
}

$partialRoot = Join-Path ([IO.Path]::GetTempPath()) ('ue-mat-partial-install-' + [Guid]::NewGuid().ToString('N'))
try {
    New-Item -ItemType Directory -Path $partialRoot -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $partialRoot 'Caddyfile') -Value 'partial' -Encoding ASCII
    $partialJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $managerPath status -Json -DataRoot $partialRoot
    if ($LASTEXITCODE -ne 0) { throw "partial status failed with exit $LASTEXITCODE" }
    $partialStatus = ($partialJson -join "`n") | ConvertFrom-Json
    Assert-True $partialStatus.partialInstall 'status identifies files left by an interrupted first install'
    Assert-True ([string]$partialStatus.nextAction -match 'Manage-ViewerHttps\.bat') 'status gives a beginner-friendly repair action'
} finally {
    Remove-Item -LiteralPath $partialRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'ViewerHttps.Core.Tests.ps1: PASS'

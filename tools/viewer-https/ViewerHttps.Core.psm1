Set-StrictMode -Version 2.0

$script:TemplateRoot = Join-Path $PSScriptRoot 'templates'
$script:HostsBegin = '# BEGIN UE-MAT HTTPS'
$script:HostsEnd = '# END UE-MAT HTTPS'

function Get-ViewerHttpsConsoleFontCandidates {
    return @('MingLiU', '細明體', 'NSimSun', '新宋体', 'Microsoft JhengHei UI', 'Microsoft YaHei')
}

function Initialize-ViewerHttpsConsole {
    [CmdletBinding()]
    param()

    try {
        [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
        [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
        $global:OutputEncoding = New-Object Text.UTF8Encoding($false)

        if (-not ('ViewerHttpsConsoleFont' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ViewerHttpsConsoleFont
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CONSOLE_FONT_INFOEX
    {
        public uint cbSize;
        public uint nFont;
        public short dwFontSizeX;
        public short dwFontSizeY;
        public int FontFamily;
        public int FontWeight;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string FaceName;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool GetCurrentConsoleFontEx(
        IntPtr hConsoleOutput,
        bool maximumWindow,
        ref CONSOLE_FONT_INFOEX consoleCurrentFontEx);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool SetCurrentConsoleFontEx(
        IntPtr hConsoleOutput,
        bool maximumWindow,
        ref CONSOLE_FONT_INFOEX consoleCurrentFontEx);
}
'@
        }

        $handle = [ViewerHttpsConsoleFont]::GetStdHandle(-11)
        if ($handle -eq [IntPtr]::Zero -or $handle.ToInt64() -eq -1) { return $false }

        $info = New-Object ViewerHttpsConsoleFont+CONSOLE_FONT_INFOEX
        $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
        if (-not [ViewerHttpsConsoleFont]::GetCurrentConsoleFontEx($handle, $false, [ref]$info)) { return $false }

        foreach ($faceName in Get-ViewerHttpsConsoleFontCandidates) {
            $info.FaceName = $faceName
            if ([ViewerHttpsConsoleFont]::SetCurrentConsoleFontEx($handle, $false, [ref]$info)) { return $true }
        }
    } catch {
        return $false
    }
    return $false
}

function Test-ViewerHttpsIPv4 {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$IPv4)

    $parsed = $null
    if (-not [Net.IPAddress]::TryParse($IPv4, [ref]$parsed)) { return $false }
    if ($parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { return $false }

    $bytes = $parsed.GetAddressBytes()
    if ($bytes[0] -eq 0 -or $bytes[0] -eq 127) { return $false }
    if ($bytes[0] -eq 169 -and $bytes[1] -eq 254) { return $false }
    if ($bytes[0] -eq 198 -and ($bytes[1] -eq 18 -or $bytes[1] -eq 19)) { return $false }
    if ($bytes[0] -ge 224) { return $false }
    return $true
}

function Test-ViewerHttpsHostname {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Hostname)

    if ($Hostname.Length -lt 1 -or $Hostname.Length -gt 253) { return $false }
    if ($Hostname -match '[:/\\\s]') { return $false }
    if ($Hostname -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$') { return $false }
    foreach ($label in $Hostname.Split('.')) {
        if ($label.Length -lt 1 -or $label.Length -gt 63) { return $false }
        if ($label.StartsWith('-') -or $label.EndsWith('-')) { return $false }
    }
    return $true
}

function Test-ViewerHttpsWingetUpgradeSuccess {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][int]$ExitCode)

    # 0x8A15002B: APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE.
    return $ExitCode -eq 0 -or $ExitCode -eq -1978335189
}

function Invoke-ViewerHttpsNativeCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][scriptblock]$Command,
        [Parameter(Mandatory = $true)][bool]$ShowOutput
    )

    $lines = New-Object Collections.Generic.List[string]
    & $Command 2>&1 | ForEach-Object {
        $line = [string]$_
        [void]$lines.Add($line)
        if ($ShowOutput) { Write-Host $line }
    }
    $exitCode = $LASTEXITCODE
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $lines.ToArray() }
}

function Get-ViewerHttpsTemplate {
    param([Parameter(Mandatory = $true)][string]$Name)
    $path = Join-Path $script:TemplateRoot $Name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Template not found: $path"
    }
    return [IO.File]::ReadAllText($path)
}

function New-ViewerHttpsCaddyfile {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Address)

    if (-not (Test-ViewerHttpsIPv4 $Address) -and -not (Test-ViewerHttpsHostname $Address)) {
        throw "Invalid HTTPS address: $Address"
    }
    return (Get-ViewerHttpsTemplate 'Caddyfile.template').Replace('{{ADDRESS}}', $Address)
}

function Set-ViewerHttpsHostsBlock {
    [CmdletBinding()]
    param(
        [AllowEmptyString()][string]$Content,
        [Parameter(Mandatory = $true)][string]$IPv4,
        [Parameter(Mandatory = $true)][string]$Hostname
    )

    if (-not (Test-ViewerHttpsIPv4 $IPv4)) { throw "Invalid IPv4 address: $IPv4" }
    if (-not (Test-ViewerHttpsHostname $Hostname)) { throw "Invalid hostname: $Hostname" }

    $normalized = $Content -replace "`r?`n", "`n"
    $pattern = '(?ms)^' + [regex]::Escape($script:HostsBegin) + '.*?^' + [regex]::Escape($script:HostsEnd) + '\s*'
    $without = [regex]::Replace($normalized, $pattern, '').TrimEnd("`n")
    $block = "$script:HostsBegin`n$IPv4 $Hostname`n$script:HostsEnd"
    if ($without.Length -gt 0) { return ($without + "`n" + $block + "`n") -replace "`n", "`r`n" }
    return ($block + "`n") -replace "`n", "`r`n"
}

function New-ViewerHttpsClientInstaller {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$CertificateBase64,
        [Parameter(Mandatory = $true)][string]$CertificateThumbprint,
        [Parameter(Mandatory = $true)][string]$HttpsUrl,
        [Parameter(Mandatory = $true)][string]$IPv4,
        [AllowEmptyString()][string]$Hostname = '',
        [Parameter(Mandatory = $true)][string]$Version
    )

    if (-not (Test-ViewerHttpsIPv4 $IPv4)) { throw "Invalid IPv4 address: $IPv4" }
    if ($Hostname -and -not (Test-ViewerHttpsHostname $Hostname)) { throw "Invalid hostname: $Hostname" }
    $uri = $null
    if (-not [Uri]::TryCreate($HttpsUrl, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https') {
        throw "Invalid HTTPS URL: $HttpsUrl"
    }
    if ($CertificateThumbprint -notmatch '^[A-Fa-f0-9]+$') { throw 'Invalid certificate thumbprint' }

    $hostsCode = ''
    if ($Hostname) {
        $escapedHost = $Hostname.Replace("'", "''")
        $escapedIp = $IPv4.Replace("'", "''")
        $hostsCode = @"
`$hostsPath = Join-Path `$env:SystemRoot 'System32\drivers\etc\hosts'
`$content = if (Test-Path -LiteralPath `$hostsPath) { [IO.File]::ReadAllText(`$hostsPath) } else { '' }
`$begin = '# BEGIN UE-MAT HTTPS'
`$end = '# END UE-MAT HTTPS'
`$pattern = '(?ms)^' + [regex]::Escape(`$begin) + '.*?^' + [regex]::Escape(`$end) + '\s*'
`$content = [regex]::Replace((`$content -replace "``r?``n", "``n"), `$pattern, '').TrimEnd("``n")
`$block = "`$begin``n$escapedIp $escapedHost``n`$end``n"
if (`$content.Length -gt 0) { `$content += "``n" }
[IO.File]::WriteAllText(`$hostsPath, ((`$content + `$block) -replace "``n", "``r``n"), [Text.Encoding]::ASCII)
"@
    }

    $safeUrl = $HttpsUrl.Replace("'", "''")
    $safeThumbprint = $CertificateThumbprint.ToUpperInvariant()
    $safeCertificate = $CertificateBase64.Replace("'", "''")
    $payload = @"
`$ErrorActionPreference = 'Stop'
try {
    `$certBytes = [Convert]::FromBase64String('$safeCertificate')
    `$cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(,`$certBytes)
    if (`$cert.Thumbprint.ToUpperInvariant() -ne '$safeThumbprint') { throw '憑證指紋不符合，已停止安裝。' }
    `$existing = Get-ChildItem Cert:\LocalMachine\Root | Where-Object { `$_.Thumbprint -eq `$cert.Thumbprint }
    if (-not `$existing) {
        `$temp = Join-Path ([IO.Path]::GetTempPath()) ('ue-mat-' + [Guid]::NewGuid().ToString('N') + '.cer')
        try {
            [IO.File]::WriteAllBytes(`$temp, `$certBytes)
            Import-Certificate -FilePath `$temp -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
        } finally { Remove-Item -LiteralPath `$temp -Force -ErrorAction SilentlyContinue }
    }
$hostsCode
    Write-Host 'HTTPS 憑證安裝完成，正在開啟 UE-Mat Viewer。' -ForegroundColor Green
    Start-Process '$safeUrl'
} catch {
    Write-Host ('安裝失敗：' + `$_.Exception.Message) -ForegroundColor Red
    Read-Host '按 Enter 關閉'
    exit 1
}
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($payload))
    return (Get-ViewerHttpsTemplate 'ClientInstaller.cmd.template').Replace('{{VERSION}}', $Version).Replace('{{HTTPS_URL}}', $HttpsUrl).Replace('{{CERTIFICATE_BASE64}}', $CertificateBase64).Replace('{{ENCODED_COMMAND}}', $encoded)
}

function New-ViewerHttpsElevationArguments {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$ScriptPath,
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][Collections.IDictionary]$BoundParameters
    )

    function Quote-ElevationValue([string]$Value) {
        if ($Value -notmatch '[\s"]') { return $Value }
        return '"' + $Value.Replace('"', '\"') + '"'
    }

    $arguments = New-Object Collections.Generic.List[string]
    $arguments.Add('-NoProfile')
    $arguments.Add('-ExecutionPolicy')
    $arguments.Add('Bypass')
    $arguments.Add('-File')
    $arguments.Add((Quote-ElevationValue $ScriptPath))
    $arguments.Add((Quote-ElevationValue $Command))
    foreach ($key in @($BoundParameters.Keys | Sort-Object)) {
        if ($key -eq 'Command') { continue }
        $value = $BoundParameters[$key]
        if ($value -is [Management.Automation.SwitchParameter]) {
            if ($value.IsPresent) { $arguments.Add("-$key") }
        } else {
            $arguments.Add("-$key")
            $arguments.Add((Quote-ElevationValue ([string]$value)))
        }
    }
    return ,$arguments.ToArray()
}

Export-ModuleMember -Function Get-ViewerHttpsConsoleFontCandidates, Initialize-ViewerHttpsConsole, Test-ViewerHttpsIPv4, Test-ViewerHttpsHostname, Test-ViewerHttpsWingetUpgradeSuccess, Invoke-ViewerHttpsNativeCommand, New-ViewerHttpsCaddyfile, Set-ViewerHttpsHostsBlock, New-ViewerHttpsClientInstaller, New-ViewerHttpsElevationArguments

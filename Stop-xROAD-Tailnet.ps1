[CmdletBinding()]

param(
    [ValidateRange(1, 65535)]
    [int]$HttpsPort = 8445
)

$ErrorActionPreference = 'Stop'

$serverScript = Join-Path $PSScriptRoot "server.py"
$localPids = @(Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
foreach ($localPid in $localPids) { $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $localPid" -ErrorAction SilentlyContinue; $commandLine = [string]$proc.CommandLine; if ($commandLine -match "server\.py" -and $commandLine -match [regex]::Escape($serverScript)) { Stop-Process -Id $localPid -Force -ErrorAction Stop; Write-Host ("Local xROAD server PID " + $localPid + " was stopped.") } }
$tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $tailscale) {
    throw 'tailscale.exe was not found. Start Tailscale and try again.'
}

# Remove the xROAD local server and HTTPS listener. GenPDF port 8444 is not touched.
& $tailscale.Source serve "--https=$HttpsPort" off
if ($LASTEXITCODE -ne 0) {
    throw "Tailscale Serve stop failed (exit $LASTEXITCODE)."
}
Write-Host "xROAD Tailnet HTTPS port $HttpsPort was stopped. GenPDF port 8444 was not changed."

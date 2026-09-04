[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$HttpsPort = 8445
)

$ErrorActionPreference = 'Stop'
$tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $tailscale) {
    throw 'tailscale.exe was not found. Start Tailscale and try again.'
}

# This only removes the xROAD HTTPS listener. GenPDF port 8444 is not touched.
& $tailscale.Source serve "--https=$HttpsPort" off
if ($LASTEXITCODE -ne 0) {
    throw "Tailscale Serve stop failed (exit $LASTEXITCODE)."
}
Write-Host "xROAD Tailnet HTTPS port $HttpsPort was stopped. GenPDF port 8444 was not changed."

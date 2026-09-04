[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8080,
    [ValidateRange(1, 65535)]
    [int]$HttpsPort = 8445,
    [switch]$NoTailscaleServe
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot
Set-Location -LiteralPath $scriptDir

function Test-PortListening {
    param([int]$Number)
    try {
        return [bool](Get-NetTCPConnection -LocalPort $Number -State Listen -ErrorAction SilentlyContinue)
    } catch {
        return $false
    }
}

function Test-XroadServer {
    param([int]$Number)
    try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Number/" -UseBasicParsing -TimeoutSec 3
        return [int]$response.StatusCode -eq 200 -and [string]$response.Content -match 'xROAD|QGIS'
    } catch {
        $response = $_.Exception.Response
        return $null -ne $response -and [int]$response.StatusCode -eq 401
    }
}
$python = Get-Command python.exe -ErrorAction SilentlyContinue
if (-not $python) {
    throw 'python.exe was not found. Install Python and try again.'
}
if (-not (Test-Path -LiteralPath (Join-Path $scriptDir 'server.py') -PathType Leaf)) {
    throw "server.py was not found: $scriptDir"
}
$localServerAlreadyRunning = $false
if (Test-PortListening $Port) {
    if (Test-XroadServer $Port) {
        $localServerAlreadyRunning = $true
        Write-Host "An existing xROAD server is already running on local port $Port. It will be reused."
    } else {
        throw "Local port $Port is already in use by another service. Stop it or choose another -Port. GenPDF port 8444 is reserved."
    }
}

$tailscale = Get-Command tailscale.exe -ErrorAction SilentlyContinue
if (-not $NoTailscaleServe) {
    if (-not $tailscale) {
        throw 'tailscale.exe was not found. Start Tailscale and try again.'
    }

    $serveAlreadyConfigured = $false
    $statusText = (& $tailscale.Source serve status --json 2>$null) -join [Environment]::NewLine
    if ($statusText) {
        try {
            $serveConfig = $statusText | ConvertFrom-Json
            $webEntries = @()
            if ($serveConfig.Web) {
                $webEntries = @($serveConfig.Web.PSObject.Properties | Where-Object { $_.Name -match (':{0}$' -f [regex]::Escape([string]$HttpsPort)) })
            }
            $tcpEntries = @()
            if ($serveConfig.TCP) {
                $tcpEntries = @($serveConfig.TCP.PSObject.Properties | Where-Object { $_.Name -eq [string]$HttpsPort })
            }
            if ($webEntries.Count -gt 0) {
                $rootHandler = @($webEntries[0].Value.Handlers.PSObject.Properties | Where-Object { $_.Name -eq '/' }) | Select-Object -First 1
                $proxy = [string]$rootHandler.Value.Proxy
                if ($proxy -eq "http://127.0.0.1:$Port" -or $proxy -eq "http://localhost:$Port") {
                    $serveAlreadyConfigured = $true
                    Write-Host "Existing xROAD Tailscale Serve on HTTPS $HttpsPort will be reused."
                } else {
                    throw "Tailscale HTTPS port $HttpsPort is already mapped to $proxy. Nothing was overwritten. Use -HttpsPort 8446, for example. GenPDF port 8444 is reserved."
                }
            } elseif ($tcpEntries.Count -gt 0) {
                throw "Tailscale HTTPS port $HttpsPort is already configured as a TCP service. Nothing was overwritten. Use -HttpsPort 8446, for example. GenPDF port 8444 is reserved."
            }
        } catch [System.Management.Automation.RuntimeException] {
            throw
        } catch {
            Write-Warning 'Could not read the existing Tailscale Serve JSON. The requested port will be attempted.'
        }
    }

    if (-not $serveAlreadyConfigured) {
        & $tailscale.Source serve --bg --yes "--https=$HttpsPort" $Port
        if ($LASTEXITCODE -ne 0) {
            throw "Tailscale Serve setup failed (exit $LASTEXITCODE). GenPDF port 8444 was not changed."
        }
    }
    Write-Host "xROAD Tailnet: https://maejima.tail9ede56.ts.net:$HttpsPort/"
    Write-Host "iPhone map: https://maejima.tail9ede56.ts.net:$HttpsPort/mobile.html"
    Write-Host "GenPDF: https://maejima.tail9ede56.ts.net:8444/ (unchanged)"
} else {
    Write-Host "xROAD local test: http://127.0.0.1:$Port/"
}

$previousHost = $env:XRDS_BIND_HOST
$previousPort = $env:XRDS_PORT
$previousNoBrowser = $env:XRDS_NO_BROWSER
try {
    # Keep the local xROAD upstream on localhost regardless of appsettings.json.
    $env:XRDS_BIND_HOST = '127.0.0.1'
    $env:XRDS_PORT = [string]$Port
    $env:XRDS_NO_BROWSER = '1'
    $browserUrl = "http://127.0.0.1:$Port/"
    $browserCommand = "Start-Sleep -Seconds 2; Start-Process '$browserUrl'"
    $launcherPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $launcherPowerShell)) {
        $windowsPowerShell = Get-Command powershell.exe -ErrorAction SilentlyContinue
        if ($windowsPowerShell) { $launcherPowerShell = $windowsPowerShell.Source }
    }
    if (-not (Test-Path -LiteralPath $launcherPowerShell)) {
        $corePowerShell = Get-Command pwsh.exe -ErrorAction SilentlyContinue
        if ($corePowerShell) { $launcherPowerShell = $corePowerShell.Source }
    }
    if (Test-Path -LiteralPath $launcherPowerShell) {
        Start-Process -FilePath $launcherPowerShell -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $browserCommand) | Out-Null
    } else {
        Remove-Item Env:XRDS_NO_BROWSER -ErrorAction SilentlyContinue
        Write-Warning 'No PowerShell executable was found for the browser helper. The server will use its normal browser fallback.'
    }
    if ($localServerAlreadyRunning) {
        Write-Host "An existing xROAD server was found. Opening the local app browser."
        return
    }
    Write-Host "Starting xROAD and opening the local app browser."
    & $python.Source (Join-Path $scriptDir 'server.py')
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
} finally {
    if ($null -eq $previousHost) {
        Remove-Item Env:XRDS_BIND_HOST -ErrorAction SilentlyContinue
    } else {
        $env:XRDS_BIND_HOST = $previousHost
    }
    if ($null -eq $previousNoBrowser) {
        Remove-Item Env:XRDS_NO_BROWSER -ErrorAction SilentlyContinue
    } else {
        $env:XRDS_NO_BROWSER = $previousNoBrowser
    }
    if ($null -eq $previousPort) {
        Remove-Item Env:XRDS_PORT -ErrorAction SilentlyContinue
    } else {
        $env:XRDS_PORT = $previousPort
    }
}

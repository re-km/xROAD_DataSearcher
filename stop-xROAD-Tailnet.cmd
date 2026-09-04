@echo off
chcp 65001 >nul
set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL%" set "POWERSHELL=powershell.exe"
set "HTTPS_PORT=%~1"
if not defined HTTPS_PORT set "HTTPS_PORT=8445"
echo xROAD Tailnet stop port: %HTTPS_PORT%
echo GenPDF port 8444 is unchanged.
"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop-xROAD-Tailnet.ps1" -HttpsPort %HTTPS_PORT%
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" echo Stop failed. Exit code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
@echo off
chcp 65001 >nul
set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL%" set "POWERSHELL=powershell.exe"
set "HTTPS_PORT=%~1"
if not defined HTTPS_PORT set "HTTPS_PORT=8445"
echo xROAD DataSearcher Tailnet port: %HTTPS_PORT%
echo GenPDF port 8444 is unchanged.
echo iPhone map: https://maejima.tail9ede56.ts.net:%HTTPS_PORT%/mobile.html
set "LOG_DIR=%LOCALAPPDATA%\xROAD"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
set "LOG_FILE=%LOG_DIR%\Start-xROAD-Tailnet.cmd.log"
>"%LOG_FILE%" echo [%date% %time%] start-xROAD-Tailnet.cmd
"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-xROAD-Tailnet.ps1" -HttpsPort %HTTPS_PORT% >>"%LOG_FILE%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if "%EXIT_CODE%"=="0" (
    echo xROAD server process ended.
) else (
    echo xROAD startup failed. Exit code: %EXIT_CODE%
)
echo Log file: %LOG_FILE%
if exist "%LOG_FILE%" type "%LOG_FILE%"
echo.
pause
exit /b %EXIT_CODE%
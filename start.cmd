@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo サーバーを起動しています...
if exist "..\python\python.exe" (
    "..\python\python.exe" server.py
) else (
    python server.py
)
pause


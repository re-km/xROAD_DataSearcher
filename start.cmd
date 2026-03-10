@echo off
chcp 65001 > nul
cd /d "%~dp0"
echo サーバーを起動しています...
python server.py
pause

@echo off
cd /d "%~dp0"
where node >nul 2>&1 && (node src\server.js) || ("C:\Program Files\nodejs\node.exe" src\server.js)

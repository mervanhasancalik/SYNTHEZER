@echo off
setlocal
cd /d "%~dp0"
rem Ensure Electron runs in app mode even if env var is set globally
set "ELECTRON_RUN_AS_NODE="
echo Starting Synthezer desktop app...
npm run desktop


@echo off
REM ============================================================
REM  Agentically — Desktop. Double-click to run on this computer.
REM  Requires Node.js 20+ (nodejs.org). Your data stays local.
REM ============================================================
title Agentically HQ
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it free at https://nodejs.org then run this again.
  pause
  exit /b
)

if not exist "node_modules" (
  echo First run - installing components, one moment...
  call npm install --omit=dev
)

set AGENTICALLY_LOCAL=1
set PORT=4317
set DATA_DIR=%~dp0data

echo.
echo  Agentically HQ is starting on http://localhost:4317/app
echo  Keep this window open while you use it. Close it to stop.
echo.
start "" http://localhost:4317/app
node server.js
pause

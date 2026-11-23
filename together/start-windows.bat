@echo off
cd /d "%~dp0"
title Together For better
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Node.js not found. Please install the LTS version from https://nodejs.org
  echo     then double-click this file again.
  echo.
  pause
  exit /b
)
node server.js
echo.
echo Server stopped.
pause

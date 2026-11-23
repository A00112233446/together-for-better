@echo off
cd /d "%~dp0"
title Together For better - share
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [!] Node.js not found. Please install the LTS version from https://nodejs.org
  echo     then double-click this file again.
  echo.
  pause
  exit /b
)
if exist "cloudflared.exe" goto run
echo.
echo First time only: downloading the share tool "cloudflared" from Cloudflare (about 50 MB).
echo Press any key to start, or close this window to cancel.
pause >nul
curl -L --fail -o cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
if errorlevel 1 goto dlfail
goto run

:dlfail
del cloudflared.exe >nul 2>nul
echo.
echo [!] Download failed. Please download it by hand:
echo     https://github.com/cloudflare/cloudflared/releases/latest
echo     file: cloudflared-windows-amd64.exe
echo     rename it to cloudflared.exe and put it in this folder, then run this file again.
echo.
pause
exit /b

:run
node server.js --share
echo.
echo Server stopped. The share link no longer works.
pause

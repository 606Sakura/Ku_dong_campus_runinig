@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if not defined PORT set PORT=8787
set HOST=127.0.0.1

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [START FAILED] Node.js not found.
  echo  Install Node.js 18 or newer: https://nodejs.org/  ^(choose LTS^)
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 18 (
  echo.
  echo  [START FAILED] Node.js 18 or newer is required. Current:
  node --version
  echo  Download: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo  Campus Run Check-in
echo  URL       : http://127.0.0.1:%PORT%/
echo  First use : open the page, click  One-click read WeChat  (or run get-bind-code.cmd)
echo  Note      : a campus run now waits the full duration, then submits by itself.
echo              Keep this window open until the record appears.
echo  Stop      : Ctrl+C in this window
echo.
start "" http://127.0.0.1:%PORT%/
node server.js
if errorlevel 1 pause

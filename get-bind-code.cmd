@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
if not defined PORT set PORT=8787
echo.
echo  === Auto config + bind ===
echo  Prereq: PC WeChat logged in, campus-run mini program opened once.
echo.
node tools\auto-config.js
if errorlevel 2 goto manual
echo.
echo  === Get bind code ===
echo  1^) Windows WeChat must be logged in
echo  2^) Open the campus-run mini program, stay on its home page
echo.
node tools\get-bind-code.js --bind
if errorlevel 1 (echo. & echo [FAILED] Could not extract. See the manual steps printed above.) else (echo. & echo [OK] Bound. Go back to the web page.)
pause
exit /b 0
:manual
echo.
echo  [WARN] Could not auto-detect baseUrl / signSecret.
echo  Fill them in config.local.json manually, then rerun this file.
echo.
node tools\get-bind-code.js --bind
if errorlevel 1 (echo. & echo [FAILED] Bind failed.) else (echo. & echo [OK] Bound. Go back to the web page.)
pause

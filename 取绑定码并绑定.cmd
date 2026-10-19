@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
call "%~dp0get-bind-code.cmd"

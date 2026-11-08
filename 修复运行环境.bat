@echo off
chcp 936 >nul
title KimBoxPC 运行环境体检
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\修复运行环境.ps1"
echo.
pause
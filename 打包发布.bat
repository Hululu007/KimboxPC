@echo off
chcp 65001 >nul
title 打包 KimBoxPC 便携版
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\打包发布.ps1"
echo.
pause
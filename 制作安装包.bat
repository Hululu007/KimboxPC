@echo off
chcp 936 >nul
title 制作 KimBoxPC 安装包
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\build-installer.ps1"
echo.
pause

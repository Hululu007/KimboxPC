@echo off
chcp 936 >nul
title 创建 KimBoxPC 快捷方式
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\make_shortcut.ps1"
if errorlevel 1 (
  echo.
  echo [失败] 创建快捷方式出错，请查看上面的提示
  pause
  exit /b 1
)
echo.
ping -n 5 127.0.0.1 >nul
exit /b 0
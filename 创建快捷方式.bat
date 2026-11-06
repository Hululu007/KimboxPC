@echo off
chcp 65001 >nul
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
echo 提示：把 KimBoxPC 桌面版.lnk 拖到桌面或任务栏即可固定
timeout /t 4 >nul
exit /b 0
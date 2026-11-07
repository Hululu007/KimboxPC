@echo off
chcp 65001 >nul
title KimBoxPC 桌面版
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [错误] 未找到 Electron 运行库
  echo         请先执行: npm install
  pause
  exit /b 1
)

if not exist "native\build\Release\mpv_native.node" (
  echo [提示] 原生模块尚未编译，尝试自动编译...
  pushd native
  REM 用 Electron 内置的 Node 引擎跑 node-gyp，无需安装系统 Node
  set "ELECTRON_RUN_AS_NODE=1"
  "..\node_modules\electron\dist\electron.exe" "..\node_modules\node-gyp\bin\node-gyp.js" rebuild --target=45.2.3 --dist-url=https://electronjs.org/headers --arch=x64
  set "ELECTRON_RUN_AS_NODE="

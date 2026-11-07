@echo off
chcp 65001 >nul
title 编译 KimBoxPC 原生模块
cd /d "%~dp0.."

if not exist "node_modules\electron\dist\electron.exe" (
  echo [错误] 未找到 Electron
  pause
  exit /b 1
)
if not exist "node_modules\node-gyp\bin\node-gyp.js" (
  echo [错误] 未找到 node-gyp
  pause
  exit /b 1
)

echo [编译] 使用 Electron 内置 Node 编译原生模块...
set "ELECTRON_RUN_AS_NODE=1"
"node_modules\electron\dist\electron.exe" "node_modules\node-gyp\bin\node-gyp.js" rebuild --directory=native --target=45.2.3 --dist-url=https://electronjs.org/headers --arch=x64
set "ELECTRON_RUN_AS_NODE="

if exist "native\build\Release\mpv_native.node" (
  echo.
  echo [完成] 原生模块已生成
) else (
  echo.
  echo [失败] 编译未成功，请检查上方的错误信息
)
pause
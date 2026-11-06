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
  ..\node-v24.22.2-win-x64\node.exe ..\node_modules\node-gyp\bin\node-gyp.js rebuild --target=45.2.3 --dist-url=https://electronjs.org/headers --arch=x64
  popd
  if not exist "native\build\Release\mpv_native.node" (
    echo [错误] 编译失败，将无法使用 mpv 内核
    pause
  )
)

if not exist "native\lib\libmpv-2.dll" (
  echo [错误] 缺少 native\lib\libmpv-2.dll
  pause
  exit /b 1
)

echo [启动] KimBoxPC 桌面版...
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
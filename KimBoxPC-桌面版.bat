@echo off
chcp 936 >nul
setlocal
title KimBoxPC 桌面版
cd /d "%~dp0"

set "APP=%~dp0"
if "%APP:~-1%"=="\" set "APP=%APP:~0,-1%"
set "EXE=%~dp0node_modules\electron\dist\electron.exe"
set "DLL=%~dp0native\lib\libmpv-2.dll"
set "MOD=%~dp0native\build\Release\mpv_native.node"

if not exist "%EXE%" goto noelectron
if not exist "%DLL%" goto nodll

if not exist "%MOD%" (
  echo [提示] 原生模块缺失，尝试自动编译（需要 VS C++ 工具 + Python）...
  pushd "%~dp0native"
  set "ELECTRON_RUN_AS_NODE=1"
  "%~dp0node_modules\electron\dist\electron.exe" "%~dp0node_modules\node-gyp\bin\node-gyp.js" rebuild --target=45.2.3 --dist-url=https://electronjs.org/headers --arch=x64
  set "ELECTRON_RUN_AS_NODE="
  popd
)

echo [启动] KimBoxPC 桌面版...
start "" "%EXE%" "%APP%"

rem 等几秒确认真的起来了，避免静默失败一闪而过
timeout /t 3 >nul
tasklist /FI "IMAGENAME eq electron.exe" | find /I "electron.exe" >nul
if errorlevel 1 goto launchfail
exit /b 0

:noelectron
echo [错误] 未找到 Electron 运行库
echo        请确认 node_modules\electron\dist\electron.exe 存在
echo        若整个目录是从压缩包解压的，请重新完整解压
pause
exit /b 1

:nodll
echo [错误] 缺少 native\lib\libmpv-2.dll
echo        请重新完整解压压缩包，或双击「修复运行环境.bat」
pause
exit /b 1

:launchfail
echo.
echo [错误] Electron 没有成功启动
echo        请双击「修复运行环境.bat」检查缺少的组件
echo        若提示缺少 VC++ 运行库，请安装
echo        Microsoft Visual C++ 2015-2022 可再发行组件包 (x64)
pause
exit /b 1
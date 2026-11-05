@echo off
chcp 65001 >nul
title TVBox PC
cd /d "%~dp0"

echo ==================================================
echo            TVBox PC  (FongMi / TVBox 协议)
echo ==================================================
echo.

REM ---- 1. 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 goto NONODE

for /f "delims=" %%v in ('node -p "process.versions.node"') do set NODEVER=%%v
echo [OK] Node.js 版本: %NODEVER%

REM ---- 2. 检查版本 22.5+ ----
node -e "const p=process.versions.node.split('.').map(Number);process.exit(p[0]>22||(p[0]===22&&p[1]>=5)?0:1)"
if errorlevel 1 goto OLDNODE

node -e "require('node:sqlite')" >nul 2>nul
if errorlevel 1 goto NOSQLITE
echo [OK] 内置 SQLite 可用

REM ---- 3. 检查依赖 ----
if exist "node_modules\express" goto DEPSOK
echo [..] 首次运行，正在安装依赖，请稍候...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 goto DEPFAIL
:DEPSOK
echo [OK] 依赖已就绪
set PROBE=0

REM ---- 4. 是否已经在运行 ----
powershell -NoProfile -Command "try{$null=Invoke-WebRequest -Uri 'http://127.0.0.1:3980' -UseBasicParsing -TimeoutSec 2;exit 0}catch{exit 1}" >nul 2>nul
if not errorlevel 1 goto ALREADY

REM ---- 5. 启动 ----
echo.
echo [>>] 正在启动 http://127.0.0.1:3980
echo.
echo      服务运行期间本窗口会保持打开。
echo      关闭本窗口 = 停止服务。
echo.
start "" http://127.0.0.1:3980
node server.js

echo.
echo --------------------------------------------------
echo  服务已停止，关闭本窗口即可。
echo.
echo  如果上面出现报错，请对照处理：
echo    EADDRINUSE  端口被占用 - 关掉其他窗口，或 set PORT=8090 再运行
echo    MODULE_NOT_FOUND 依赖缺失 - 删除 node_modules 文件夹后重新双击
echo    EACCES      目录不可写 - 换到有权限的目录，或检查杀毒软件
echo --------------------------------------------------
echo.
pause
exit /b 0

:ALREADY
echo [OK] 检测到服务已经运行中（端口 3980 已被占用）
echo      已为你打开浏览器，本窗口可以关掉了。
echo.
start "" http://127.0.0.1:3980
echo      不想保留那个后台服务的话：任务管理器结束 node.exe，或重启电脑。
echo.
pause
exit /b 0

:NONODE
echo [X] 没有找到 Node.js
echo     请先安装 Node.js 22.5 或更高版本: https://nodejs.org
echo     安装保持默认选项，装完重新双击本文件即可。
echo.
pause
exit /b 1

:OLDNODE
echo [X] Node.js 版本过低: %NODEVER%
echo     需要 22.5 以上，请到 https://nodejs.org 下载新版。
echo.
pause
exit /b 1

:NOSQLITE
echo [X] 当前 Node.js 不支持内置 SQLite
echo     请升级到 23.4 或 24 以上版本。
echo.
pause
exit /b 1

:DEPFAIL
echo [X] 依赖安装失败，请检查网络后重试。
echo     也可以手动执行: npm install
echo.
pause
exit /b 1
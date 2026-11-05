@echo off
chcp 65001 >nul
title TVBox PC
cd /d "%~dp0"

echo ==================================================
echo            TVBox PC  (FongMi / TVBox 协议)
echo ==================================================
echo.

set "PIDFILE=data\.server.pid"

REM ---- 1. 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 goto NONODE

for /f "delims=" %%v in ('node -p "process.versions.node"') do set NODEVER=%%v
echo [OK] Node.js 版本: %NODEVER%

node -e "const p=process.versions.node.split('.').map(Number);process.exit(p[0]>22||(p[0]===22&&p[1]>=5)?0:1)"
if errorlevel 1 goto OLDNODE

node -e "require('node:sqlite')" >nul 2>nul
if errorlevel 1 goto NOSQLITE
echo [OK] 内置 SQLite 可用

REM ---- 2. 检查依赖 ----
if exist "node_modules\express" goto DEPSOK
echo [..] 首次运行，正在安装依赖，请稍候...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 goto DEPFAIL
:DEPSOK
echo [OK] 依赖已就绪

REM ---- 3. 是否已有实例在运行 ----
if not exist "%PIDFILE%" goto START
set /p OLDPID=<"%PIDFILE%"
tasklist /FI "PID eq %OLDPID%" | findstr "%OLDPID%" >nul
if errorlevel 1 (
    echo [..] 清理上次残留的进程记录
    del /q "%PIDFILE%" >nul 2>nul
    goto START
)

echo.
echo [!!] 检测到已有一个 TVBox PC 服务在后台运行（PID=%OLDPID%）
echo      它可能是之前窗口异常关闭后残留的，会占着数据库。
echo.
choice /C YN /N /M "      结束它并重新启动？(Y=重启  N=仅打开页面) "
if errorlevel 2 goto OPENONLY

echo [..] 正在结束旧进程 %OLDPID% ...
taskkill /F /PID %OLDPID% >nul 2>nul
del /q "%PIDFILE%" >nul 2>nul
ping -n 2 127.0.0.1 >nul
goto START

:OPENONLY
echo [OK] 已打开页面，本窗口可以关闭。
start "" http://127.0.0.1:3980
ping -n 2 127.0.0.1 >nul
exit /b 0

REM ---- 4. 启动 ----
:START
echo.
echo [启动] 正在启动 http://127.0.0.1:3980
echo.
echo      服务运行期间本窗口会保持打开。
echo      关闭本窗口 = 停止服务（数据库也会随之解锁）。
echo.
start "" http://127.0.0.1:3980
set TVBOX_WATCH_PARENT=1
node server.js

echo.
echo --------------------------------------------------
echo  服务已停止，数据库已解锁。
echo.
echo  若上面有报错：
echo    EADDRINUSE       端口被占用 - 先运行 stop.bat
echo    MODULE_NOT_FOUND 依赖缺失   - 删除 node_modules 后重试
echo    EACCES           目录不可写 - 换目录或检查杀毒软件
echo --------------------------------------------------
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

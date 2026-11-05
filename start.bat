@echo off
chcp 65001 >nul
title TVBox PC
cd /d "%~dp0"

echo ==================================================
echo            TVBox PC  (FongMi / TVBox 协议)
echo ==================================================
echo.

set "PIDFILE=data\.server.pid"

REM ---- 1. 检查 Node.js（缺失则尝试本地安装包静默安装）----
:NODECHECK
where node >nul 2>nul
if errorlevel 1 goto TRYINSTALL

for /f "delims=" %%v in ('node -p "process.versions.node"') do set NODEVER=%%v
echo [OK] Node.js 版本: %NODEVER%

node -e "const p=process.versions.node.split('.').map(Number);process.exit(p[0]>22||(p[0]===22&&p[1]>=5)?0:1)"
if errorlevel 1 goto OLDNODE

node -e "require('node:sqlite')" >nul 2>nul
if errorlevel 1 goto NOSQLITE
echo [OK] 内置 SQLite 可用
goto DEPSCHECK

REM ---- 1b. 未安装 Node：用 Setup 目录里的 msi 静默安装 ----
:TRYINSTALL
set "MSI="
for %%f in ("%~dp0Setup\node-*.msi") do if exist "%%~ff" set "MSI=%%~ff"
if not defined MSI goto NONODE

echo.
echo [!!] 未检测到 Node.js
echo      发现本地安装包: %MSI%
echo.
echo [..] 正在静默安装，约需 1 分钟
echo      会弹出一次 UAC 授权窗口，请点「是」
echo.
set "TVBOX_MSI=%MSI%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath msiexec.exe -ArgumentList @('/i', $env:TVBOX_MSI, '/qn', '/norestart') -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
set "INSTALLRC=%errorlevel%"

if "%INSTALLRC%"=="0" goto INSTALLOK
if "%INSTALLRC%"=="3010" goto INSTALLOK
echo.
echo [X] 安装失败（返回码 %INSTALLRC%）
echo     常见原因：
echo       1602/1625 - UAC 被取消或权限不足，请右键 start.bat 选「以管理员身份运行」
echo       1619      - 安装包无法打开，可能文件损坏
echo       1603      - 已有其它版本 Node，请先卸载
echo.
pause
exit /b 1

:INSTALLOK
echo [OK] Node.js 安装完成
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%PATH%;%ProgramFiles%\nodejs"
where node >nul 2>nul
if errorlevel 1 (
    echo [X] 安装完成但当前窗口仍找不到 node.exe
    echo     请关闭本窗口后重新双击 start.bat
    pause
    exit /b 1
)
echo.
goto NODECHECK

REM ---- 2. 依赖 ----
:DEPSCHECK
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
echo [启动] http://127.0.0.1:3980
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
echo [X] 没有找到 Node.js，且 Setup 目录里也没有安装包
echo.
echo     解决办法二选一：
echo       1) 把 node-vXX-x64.msi 放进 Setup 文件夹，再双击本文件
echo       2) 到 https://nodejs.org 下载 Node.js 22.5 或更高版本安装
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
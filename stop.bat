@echo off
chcp 65001 >nul
title 停止 KimBoxPC
cd /d "%~dp0"

echo ==================================================
echo              停止 KimBoxPC 服务
echo ==================================================
echo.

set "PIDFILE=data\.server.pid"

if not exist "%PIDFILE%" (
    echo 没有找到运行中的服务（未发现 %PIDFILE%）。
    echo 如果确实还有 node.exe 在跑，可按下面命令结束：
    echo     taskkill /F /IM node.exe
    echo.
    pause
    exit /b 0
)

set /p SERVERPID=<"%PIDFILE%"
echo 正在停止服务进程 PID=%SERVERPID% ...

tasklist /FI "PID eq %SERVERPID%" | findstr "%SERVERPID%" >nul
if errorlevel 1 (
    echo 该进程已经不在了，清理残留记录。
    del /q "%PIDFILE%" >nul 2>nul
    echo.
    pause
    exit /b 0
)

taskkill /F /PID %SERVERPID% >nul 2>nul
if errorlevel 1 (
    echo [X] 停止失败，可能是权限不足。请右键本文件「以管理员身份运行」。
    pause
    exit /b 1
)

del /q "%PIDFILE%" >nul 2>nul
echo.
echo [OK] 服务已停止，数据库文件已解锁，可以正常压缩/备份了。
echo.
ping -n 2 127.0.0.1 >nul
exit /b 0
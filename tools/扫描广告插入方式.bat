@echo off
chcp 936 >nul
title KimBoxPC 广告插入方式扫描
cd /d "%~dp0.."
echo 正在扫描所有站点的广告插入方式（约 20~60 秒）...
echo.
set "ELECTRON_RUN_AS_NODE=1"
"node_modules\electron\dist\electron.exe" "tools\adsurvey.js"
set "ELECTRON_RUN_AS_NODE="
echo.
echo 报告已生成：广告检测报告.md
pause
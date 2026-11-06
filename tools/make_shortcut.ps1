# 为 KimBoxPC 创建带自定义图标的快捷方式（可重复运行）
# 用法：双击「创建快捷方式.bat」，或执行：
#   powershell -ExecutionPolicy Bypass -File tools\make_shortcut.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $root 'node_modules\electron\dist\electron.exe'
$ico  = Join-Path $root 'icon.ico'
$lnk  = Join-Path $root 'KimBoxPC 桌面版.lnk'

if (-not (Test-Path $exe)) { Write-Host "[错误] 未找到 Electron，请先执行 npm install" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $ico)) { Write-Host "[错误] 未找到 icon.ico" -ForegroundColor Red; exit 1 }

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
# 直接指向 electron.exe：不弹黑框、任务栏图标更干净
$sc.TargetPath       = $exe
$sc.Arguments        = '"' + $root + '"'
$sc.WorkingDirectory = $root
$sc.IconLocation     = "$ico,0"
$sc.Description      = 'KimBoxPC 桌面版 - Electron + libmpv'
$sc.WindowStyle      = 1
$sc.Save()

Write-Host "[完成] 已创建快捷方式：" -ForegroundColor Green
Write-Host "       $lnk"
Write-Host "       可把该 .lnk 拖到桌面或任务栏固定"
# 为 KimBoxPC 创建带自定义图标的快捷方式，并复制到当前用户桌面
# 用法：双击「创建快捷方式.bat」，或执行：
#   powershell -ExecutionPolicy Bypass -File tools\make_shortcut.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$exe  = Join-Path $root 'node_modules\electron\dist\electron.exe'
$ico  = Join-Path $root 'icon.ico'
$lnk  = Join-Path $root 'KimBoxPC 桌面版.lnk'

if (-not (Test-Path $exe)) { Write-Host '[错误] 未找到 Electron，请先执行 npm install' -ForegroundColor Red; exit 1 }
if (-not (Test-Path $ico)) { Write-Host '[错误] 未找到 icon.ico' -ForegroundColor Red; exit 1 }

# 1) 在项目目录生成快捷方式（直接指向 electron.exe：不弹黑框、图标干净）
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath       = $exe
$sc.Arguments        = '"' + $root + '"'
$sc.WorkingDirectory = $root
$sc.IconLocation     = "$ico,0"
$sc.Description      = 'KimBoxPC 桌面版 - Electron + libmpv'
$sc.WindowStyle      = 1
$sc.Save()
Write-Host '[完成] 项目目录快捷方式：' -ForegroundColor Green
Write-Host "       $lnk"

# 2) 复制到当前用户桌面（用系统 API 取路径，兼容 OneDrive 重定向的桌面）
try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop -or -not (Test-Path $desktop)) {
        $desktop = Join-Path $env:USERPROFILE 'Desktop'
    }
    $dest = Join-Path $desktop 'KimBoxPC 桌面版.lnk'
    Copy-Item -LiteralPath $lnk -Destination $dest -Force
    Write-Host '[完成] 已复制到桌面：' -ForegroundColor Green
    Write-Host "       $dest"
} catch {
    Write-Host "[提示] 复制到桌面失败：$($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host '       可手动把上面那个 .lnk 拖到桌面'
}

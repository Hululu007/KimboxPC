# 打包 KimBoxPC 便携版 zip
# 用法：双击「打包发布.bat」，或执行：
#   powershell -ExecutionPolicy Bypass -File tools\打包发布.ps1

$ErrorActionPreference = 'Stop'

$root  = Split-Path -Parent $PSScriptRoot
$ver   = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$out   = Join-Path (Split-Path -Parent $root) "KimBoxPC_v$ver.zip"
$stage = Join-Path $env:TEMP "KimBoxPC_pkg_$ver"
$pkgDir = Join-Path $stage 'KimBoxPC'

Write-Host "[打包] 版本 $ver" -ForegroundColor Cyan

# 1) 清理并暂存
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Path $pkgDir -Force | Out-Null

$xd = @('.git', 'data', 'node_modules\.cache', 'native\build\Release\obj') | ForEach-Object { Join-Path $root $_ }
$xf = @('*.lnk', '_e.log', '_e.err', '*.pdb', '*.iobj', '*.ipdb', '*.lib', '*.exp', '*.vcxproj', '*.vcxproj.filters', '*.sln')

$rcArgs = @($root, $pkgDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/nc', '/ns', '/np', '/XD') + $xd + @('/XF') + $xf
& robocopy @rcArgs | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host '[错误] 复制失败' -ForegroundColor Red; exit 1 }

# 2) 完整性自检
$must = @(
  'node_modules\electron\dist\electron.exe',
  'native\lib\libmpv-2.dll',
  'native\build\Release\mpv_native.node',
  'public\index.html',
  'KimBoxPC-桌面版.bat',
  '创建快捷方式.bat',
  'icon.ico'
)
foreach ($m in $must) {
  if (-not (Test-Path (Join-Path $pkgDir $m))) {
    Write-Host "[错误] 缺少必要文件：$m" -ForegroundColor Red
    exit 1
  }
}

# 3) 压缩
if (Test-Path $out) { Remove-Item -Force $out }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $pkgDir, $out, [System.IO.Compression.CompressionLevel]::Optimal, $true)

# 4) 收尾
Remove-Item -Recurse -Force $stage
$f = Get-Item $out
$sha = (Get-FileHash $out -Algorithm SHA256).Hash
Write-Host ''
Write-Host '[完成] 打包成功' -ForegroundColor Green
Write-Host "  文件：$($f.FullName)"
Write-Host "  大小：$([math]::Round($f.Length/1MB,1)) MB"
Write-Host "  SHA256：$sha"
Write-Host ''
Write-Host '新机器上：解压 → 双击「创建快捷方式.bat」→ 双击桌面快捷方式'

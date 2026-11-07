# 打包 KimBoxPC 便携版 zip
# 用法：双击「打包发布.bat」，或执行：
#   powershell -ExecutionPolicy Bypass -File tools\打包发布.ps1

$ErrorActionPreference = 'Stop'

$root  = Split-Path -Parent $PSScriptRoot
# 显式按 UTF-8 读取：Windows PowerShell 5.1 的 Get-Content 默认按 ANSI/GBK 解码，
# 会把 package.json 里的中文读成乱码并破坏 JSON 结构
$pkgPath = Join-Path $root 'package.json'
$ver = ''
try {
    $pkgText = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8)
    $ver = ($pkgText | ConvertFrom-Json).version
} catch {
    $m = [regex]::Match([System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8), '"version"\s*:\s*"([^"]+)"')
    if ($m.Success) { $ver = $m.Groups[1].Value }
}
if (-not $ver) { Write-Host '[错误] 无法从 package.json 读取版本号' -ForegroundColor Red; exit 1 }
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

# 3) 压缩（手动逐条写入，确保路径分隔符是 / —— ZIP 规范要求，跨工具兼容）
if (Test-Path $out) { Remove-Item -Force $out }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$level = [System.IO.Compression.CompressionLevel]::Optimal
$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $baseLen = $pkgDir.Length + 1
    Get-ChildItem $pkgDir -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($baseLen).Replace('\', '/')
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, "KimBoxPC/$rel", $level)
    }
} finally {
    $zip.Dispose()
}

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

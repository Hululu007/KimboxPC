# KimBoxPC 运行环境体检 / 修复
# 用法：双击「修复运行环境.bat」

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot

Write-Host '=== KimBoxPC 运行环境体检 ===' -ForegroundColor Cyan
Write-Host "目录：$root"
Write-Host ''

# 1) 解除 Mark-of-the-Web（从网上下载的 zip 解压后，DLL 会被 Windows 标记为不可信）
$blocked = 0
try {
    Get-ChildItem $root -Recurse -File -ErrorAction SilentlyContinue |
        ForEach-Object {
            try {
                if (Get-Item $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue) {
                    Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue
                    $blocked++
                }
            } catch {}
        }
} catch {}
if ($blocked -gt 0) {
    Write-Host "[已修复] 解除了 $blocked 个文件的「来自网络」锁定" -ForegroundColor Green
} else {
    Write-Host '[正常] 没有被 Windows 锁定的文件'
}

# 2) 检查关键文件
$must = @(
    'node_modules\electron\dist\electron.exe',
    'native\lib\libmpv-2.dll',
    'native\lib\vulkan-1.dll',
    'native\build\Release\mpv_native.node',
    'public\index.html',
    'ffmpeg\ffmpeg.exe'
)
$missing = @()
foreach ($m in $must) {
    if (Test-Path (Join-Path $root $m)) {
        Write-Host "[正常] $m"
    } else {
        Write-Host "[缺失] $m" -ForegroundColor Red
        $missing += $m
    }
}

# 3) 检查系统依赖（Vulkan 加载器是 libmpv 的必需依赖）
$sysVulkan = Join-Path $env:SystemRoot 'System32\vulkan-1.dll'
if (Test-Path $sysVulkan) {
    Write-Host '[正常] 系统已有 vulkan-1.dll'
} else {
    Write-Host '[提示] 系统没有 vulkan-1.dll（已随包提供，位于 native\lib）' -ForegroundColor Yellow
}

# 4) VC++ 运行库
$vc = @('vcruntime140.dll', 'msvcp140.dll')
$vcMissing = @()
foreach ($d in $vc) {
    if (-not (Test-Path (Join-Path $env:SystemRoot "System32\$d"))) { $vcMissing += $d }
}
if ($vcMissing.Count -gt 0) {
    Write-Host "[提示] 可能缺少 VC++ 运行库：$($vcMissing -join ', ')" -ForegroundColor Yellow
    Write-Host '       下载「Microsoft Visual C++ 2015-2022 可再发行组件包 (x64)」安装后重试'
} else {
    Write-Host '[正常] VC++ 运行库齐全'
}

Write-Host ''
if ($missing.Count -gt 0) {
    Write-Host '【结论】有文件缺失，请重新解压完整压缩包（不要只拷部分文件）' -ForegroundColor Red
} else {
    Write-Host '【结论】文件齐全，可以直接双击「KimBoxPC 桌面版」启动' -ForegroundColor Green
}
Write-Host ''

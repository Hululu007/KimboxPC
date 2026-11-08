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
    $inst = Join-Path $root 'tools\VC_redist.x64.exe'
    if (-not (Test-Path $inst)) { $inst = Join-Path $root 'tools\VC_redist.x86.exe' }

    if (Test-Path $inst) {
        Write-Host "[可修复] 发现随包安装程序：$inst" -ForegroundColor Green
        Write-Host '         现在安装吗？（需要一次 UAC 管理员授权）'
        $ans = Read-Host '         输入 Y 安装，其它键跳过'
        if ($ans -eq 'Y' -or $ans -eq 'y') {
            Write-Host '[安装] 正在调用安装程序（静默，约 1 分钟）...' -ForegroundColor Cyan
            try {
                $proc = Start-Process -FilePath $inst -ArgumentList '/install', '/passive', '/norestart' -Verb RunAs -Wait -PassThru
                Write-Host "[安装] 结束，退出码 $($proc.ExitCode)（0 或 3010 表示成功）" -ForegroundColor Green
                $still = @('vcruntime140.dll', 'msvcp140.dll') | Where-Object { -not (Test-Path (Join-Path $env:SystemRoot "System32\$_")) }
                if ($still.Count -eq 0) {
                    Write-Host '[正常] VC++ 运行库已就绪，重启 KimBoxPC 即可' -ForegroundColor Green
                } else {
                    Write-Host '[提示] 仍未检测到，请重启电脑后再试' -ForegroundColor Yellow
                }
            } catch {
                Write-Host "[提示] 安装未完成：$($_.Exception.Message)" -ForegroundColor Yellow
                Write-Host '       用户取消授权或安装被拦截；可手动双击该 exe 安装'
            }
        } else {
            Write-Host '       已跳过。可稍后手动双击该 exe 安装。'
        }
    } else {
        Write-Host '       未找到随包安装程序，请下载安装「Microsoft Visual C++ 2015-2022 (x64)」：'
        Write-Host '         https://aka.ms/vs/17/release/vc_redist.x64.exe' -ForegroundColor Cyan
        Write-Host '       32 位系统：https://aka.ms/vs/17/release/vc_redist.x86.exe'
        Write-Host '       安装后重新启动 KimBoxPC 即可。'
    }
} else {
    Write-Host '[正常] VC++ 运行库齐全'
}

# 结论前再确认一次 VC++ 状态（可能刚刚装过）
$vcStillMissing = @('vcruntime140.dll', 'msvcp140.dll') |
    Where-Object { -not (Test-Path (Join-Path $env:SystemRoot "System32\$_")) }

Write-Host ''
if ($missing.Count -gt 0) {
    Write-Host '【结论】有文件缺失，请重新解压完整压缩包（不要只拷部分文件）' -ForegroundColor Red
} elseif ($vcStillMissing.Count -gt 0) {
    Write-Host '【结论】文件齐全，但还缺 VC++ 运行库——mpv 内核可能无法启动' -ForegroundColor Yellow
    Write-Host '       请运行 tools\VC_redist.x64.exe 安装后重试'
} else {
    Write-Host '【结论】文件齐全，可以直接双击「KimBoxPC 桌面版」启动' -ForegroundColor Green
}
Write-Host ''

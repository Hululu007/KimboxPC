# 从本地 xiugou-tv 构建产物拷入 JVM 站源运行时（jvm/ + runtime/jre）
# 用法：powershell -ExecutionPolicy Bypass -File tools\fetch-jvm.ps1 [-Source D:\Projects\Deepseek\xiugou-tv] [-CheckOnly]
#
# 这些是第三方 GPLv3 组件（android-bridge 编译产物 + jlink JRE），体积大，不入 git；
# 发布打包前必须先跑一遍本脚本。上游版本与哈希记录在 jvm-manifest.json。
param(
    [string]$Source = 'D:\Projects\Deepseek\xiugou-tv',
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$jvm = Join-Path $root 'jvm'
$jre = Join-Path $root 'runtime\jre'

# 1) 已就位则只做体检
$needJar = -not (Test-Path (Join-Path $jvm 'companion-service.jar'))
$needBc = -not (Test-Path (Join-Path $jvm 'bcprov-jdk18on-1.78.1.jar'))
$needUnidbg = -not (Test-Path (Join-Path $jvm 'lib-unidbg'))
$needJre = -not (Test-Path (Join-Path $jre 'bin\java.exe'))
$missing = @()
if ($needJar) { $missing += 'jvm\companion-service.jar' }
if ($needBc) { $missing += 'jvm\bcprov-jdk18on-1.78.1.jar' }
if ($needUnidbg) { $missing += 'jvm\lib-unidbg\' }
if ($needJre) { $missing += 'runtime\jre\bin\java.exe' }

if ($missing.Count -eq 0) {
    Write-Host '[OK] JVM 运行时已就位：' -ForegroundColor Green
    Get-ChildItem $jvm -Recurse -File | Measure-Object Length -Sum | ForEach-Object { Write-Host ("     jvm        {0,6:N1} MB" -f ($_.Sum / 1MB)) }
    Get-ChildItem $jre -Recurse -File | Measure-Object Length -Sum | ForEach-Object { Write-Host ("     runtime    {0,6:N1} MB" -f ($_.Sum / 1MB)) }
    exit 0
}

if ($CheckOnly) {
    Write-Host '[缺失] 以下运行时文件不存在：' -ForegroundColor Yellow
    $missing | ForEach-Object { Write-Host "     $_" }
    exit 1
}

# 2) 从上游构建产物拷入
$srcJar = Join-Path $Source 'companion\dist\companion-service.jar'
$srcBc = Join-Path $Source 'companion\dist\bcprov-jdk18on-1.78.1.jar'
$srcUnidbg = Join-Path $Source 'companion\dist\lib-unidbg'
$srcJre = Join-Path $Source 'runtime\jre'
foreach ($p in @($srcJar, $srcBc, $srcUnidbg, (Join-Path $srcJre 'bin\java.exe'))) {
    if (-not (Test-Path $p)) {
        Write-Host "[错误] 上游产物不存在：$p" -ForegroundColor Red
        Write-Host '       请先在 xiugou-tv 里构建 companion（companion\build.ps1），或指定 -Source。' -ForegroundColor Yellow
        exit 1
    }
}

Write-Host '[拷贝] 正在拷贝 JVM 运行时（约 120MB）...' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $jvm, (Split-Path -Parent $jre) | Out-Null
Copy-Item $srcJar (Join-Path $jvm 'companion-service.jar') -Force
Copy-Item $srcBc (Join-Path $jvm 'bcprov-jdk18on-1.78.1.jar') -Force
if (Test-Path (Join-Path $jvm 'lib-unidbg')) { Remove-Item -Recurse -Force (Join-Path $jvm 'lib-unidbg') }
Copy-Item $srcUnidbg (Join-Path $jvm 'lib-unidbg') -Recurse -Force
if (Test-Path $jre) { Remove-Item -Recurse -Force $jre }
Copy-Item $srcJre $jre -Recurse -Force

# 3) 校验（只核对主 jar 与 BouncyCastle 的 sha256，目录类组件看体积）
function Get-Sha256([string]$p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
$manifestPath = Join-Path $root 'jvm-manifest.json'
if (Test-Path $manifestPath) {
    $m = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $bad = 0
    foreach ($c in $m.components) {
        if ($c.sha256) {
            $p = Join-Path $root ($c.path -replace '/', '\')
            if ((Get-Sha256 $p) -ne $c.sha256) { Write-Host "[警告] 哈希不符：$($c.path)" -ForegroundColor Yellow; $bad++ }
        }
    }
    if ($bad -eq 0) { Write-Host '[OK] 哈希与 jvm-manifest.json 一致' -ForegroundColor Green }
}

Write-Host '[完成] JVM 运行时已就位' -ForegroundColor Green

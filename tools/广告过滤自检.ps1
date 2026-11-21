<#
.SYNOPSIS
  KimBoxPC 广告过滤自检（合成播放列表 + 全站点真实源）

.DESCRIPTION
  需要 KimBoxPC 正在运行（默认 127.0.0.1:3980，可用 -Port 或 port.txt 指定）。
  1) 合成播放列表：45 分钟正片 + 2 段各 30s 广告，验证区间/目标点/剪辑/剪辑后首片；
  2) 全站点真实源：逐个站点取流，检查广告区间数、剪辑段数、目标点合法性、剪辑后分片减少、首片可取；
  3) 直链（非 m3u8）与取不到流的站点单独列出，不算失败。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\广告过滤自检.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\广告过滤自检.ps1 -Title "尚公主" -Port 3980 -TimeoutSec 40
#>
param(
  [string]$Title = '两京十五日',
  [int]$Port = 0,
  [int]$TimeoutSec = 30
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'ad-check.js'

if (-not (Test-Path $script)) {
  Write-Host "[错误] 缺少 $script" -ForegroundColor Red
  exit 2
}

if ($Port -le 0) {
  $Port = 3980
  $portFile = Join-Path $root 'port.txt'
  if (Test-Path $portFile) {
    $p = (Get-Content $portFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($p -match '^\d+$') { $Port = [int]$p }
  }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host '[错误] 找不到 node，请确认已安装 Node.js 并加入 PATH' -ForegroundColor Red
  exit 2
}

Write-Host "[自检] 端口 $Port / 片名 $Title / 超时 ${TimeoutSec}s" -ForegroundColor Cyan
$env:KIMBOX_PORT = [string]$Port
$env:KIMBOX_TITLE = $Title
$env:KIMBOX_TIMEOUT = [string]($TimeoutSec * 1000)

Push-Location $root
try {
  & $node $script
  $code = $LASTEXITCODE
} finally {
  Pop-Location
}

if ($code -eq 0) { Write-Host '[自检] 全部通过' -ForegroundColor Green }
elseif ($code -eq 2) { Write-Host '[自检] 未连上 KimBoxPC，请先启动程序或指定 -Port' -ForegroundColor Yellow }
else { Write-Host '[自检] 发现问题，请按上面 [FAIL] 行排查' -ForegroundColor Red }
exit $code

# 打包 KimBoxPC 安装版（Inno Setup）
# 用法：双击「制作安装包.bat」，或执行：
#   powershell -ExecutionPolicy Bypass -File tools\build-installer.ps1
#
# 产物：上一级目录 KimBoxPC_v<version>_Setup.exe（按用户安装，无需管理员权限）

$ErrorActionPreference = 'Stop'

$root  = Split-Path -Parent $PSScriptRoot
$pkgPath = Join-Path $root 'package.json'
# 显式 UTF-8 读取：PS 5.1 默认按 ANSI 解码会把中文读坏
$pkgText = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8)
$ver = ''
try { $ver = ($pkgText | ConvertFrom-Json).version } catch { }
if (-not $ver) {
    $m = [regex]::Match($pkgText, '"version"\s*:\s*"([^"]+)"')
    if ($m.Success) { $ver = $m.Groups[1].Value }
}
if (-not $ver) { Write-Host '[错误] 无法从 package.json 读取版本号' -ForegroundColor Red; exit 1 }

$iscc = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
if (-not (Test-Path $iscc)) {
    $iscc = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
}
if (-not (Test-Path $iscc)) {
    Write-Host '[错误] 未找到 Inno Setup 编译器（ISCC.exe）' -ForegroundColor Red
    Write-Host '       安装：winget install --id JRSoftware.InnoSetup -e' -ForegroundColor Yellow
    exit 1
}

$out   = Join-Path (Split-Path -Parent $root) "KimBoxPC_v${ver}_Setup.exe"
$stage = Join-Path $env:TEMP "KimBoxPC_setup_$ver"
$appDir = Join-Path $stage 'app'

Write-Host "[打包] 安装版 v$ver" -ForegroundColor Cyan

# 1) 暂存一份「可运行目录」（排除开发/隐私/调试产物）
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Path $appDir -Force | Out-Null

$xd = @('.git', 'data', 'ffmpeg', 'node_modules\.cache', 'native\build\Release\obj', 'dist') | ForEach-Object { Join-Path $root $_ }
$xf = @('*.lnk', '_e.log', '_e.err', '*.pdb', '*.iobj', '*.ipdb', '*.lib', '*.exp', '*.vcxproj', '*.vcxproj.filters', '*.sln', '_*.js', '_*.log', '_*.json')
$rcArgs = @($root, $appDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/nc', '/ns', '/np', '/XD') + $xd + @('/XF') + $xf
& robocopy @rcArgs | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host '[错误] 复制文件失败' -ForegroundColor Red; exit 1 }

# 2) 完整性自检
$must = @(
    'node_modules\electron\dist\electron.exe',
    'native\lib\libmpv-2.dll',
    'native\build\Release\mpv_native.node',
    'public\index.html',
    'icon.ico',
    'jvm\companion-service.jar',
    'jvm\bcprov-jdk18on-1.78.1.jar',
    'jvm\lib-unidbg',
    'runtime\jre\bin\java.exe'
)
foreach ($m in $must) {
    if (-not (Test-Path (Join-Path $appDir $m))) {
        Write-Host "[错误] 缺少必要文件：$m" -ForegroundColor Red
        exit 1
    }
}

# 3) 生成 Inno Setup 脚本
$iss = Join-Path $stage 'kimboxpc.iss'
$issText = @"
; 由 tools\build-installer.ps1 自动生成
#define AppName "KimBoxPC"
#define AppVersion "$ver"
#define AppPublisher "KimBoxPC"
#define AppExe "node_modules\electron\dist\electron.exe"

[Setup]
AppId={{D8B1C0E2-4F3A-4C7E-9A21-6B5E7D3F1A08}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={localappdata}\Programs\KimBoxPC
DefaultGroupName=KimBoxPC
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=$([IO.Path]::GetDirectoryName($out))
OutputBaseFilename=$([IO.Path]::GetFileNameWithoutExtension($out))
SetupIconFile=$appDir\icon.ico
UninstallDisplayIcon={app}\icon.ico
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableDirPage=no
UsePreviousAppDir=yes
CloseApplications=no
RestartApplications=no
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
Source: "$appDir\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\KimBoxPC"; Filename: "{app}\{#AppExe}"; Parameters: """{app}"""; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"
Name: "{autodesktop}\KimBoxPC"; Filename: "{app}\{#AppExe}"; Parameters: """{app}"""; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"

[Run]
Filename: "{app}\{#AppExe}"; Parameters: """{app}"""; WorkingDir: "{app}"; Description: "启动 KimBoxPC"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\data\cache"
Type: files; Name: "{app}\data\.server.pid"
Type: files; Name: "{app}\data\window-state.json"
Type: dirifempty; Name: "{app}\data"
Type: dirifempty; Name: "{app}"
"@
[System.IO.File]::WriteAllText($iss, $issText, (New-Object System.Text.UTF8Encoding($true)))

# 4) 编译
Write-Host '[编译] 正在压缩生成安装包（约 3~8 分钟）...' -ForegroundColor Cyan
if (Test-Path $out) { Remove-Item -Force $out }
& $iscc $iss
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $out)) {
    Write-Host '[错误] Inno Setup 编译失败' -ForegroundColor Red
    exit 1
}

# 5) 收尾
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
$f = Get-Item $out
$sha = (Get-FileHash $out -Algorithm SHA256).Hash
Write-Host ''
Write-Host '[完成] 安装包已生成' -ForegroundColor Green
Write-Host "  文件：$($f.FullName)"
Write-Host "  大小：$([math]::Round($f.Length/1MB,1)) MB"
Write-Host "  SHA256：$sha"
Write-Host ''
Write-Host '双击安装即可：默认装到「当前用户\程序\KimBoxPC」，自动创建桌面与开始菜单快捷方式，含卸载项。'



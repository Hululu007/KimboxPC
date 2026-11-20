/**
 * 自动更新：从 GitHub Releases 检查新版本、下载安装包、重启完成覆盖。
 *
 * 设计取舍（为什么不用 electron-updater）：
 *   本项目用 Inno Setup 打包（不是 electron-builder），electron-updater 依赖
 *   latest.yml 之类的元数据，改造打包链的代价远大于自己写这一百多行。
 *
 * 两种运行形态分别处理：
 *   · 安装版（目录里有 unins000.exe）：下载 *_Setup.exe，退出后静默安装再拉起；
 *   · 便携版（解压即用）：下载 *.zip，退出后用 bat 等进程退出 → 解压覆盖 → 重新拉起。
 * 无论哪种，都**不会动 data/**（打包时已排除），配置、收藏、历史、片头片尾标记都保留。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');

const ROOT = __dirname;
const REPO = 'jacurtwong/KimboxPC';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const UPDATE_DIR = path.join(ROOT, 'data', 'updates');
const STATE_FILE = path.join(UPDATE_DIR, 'state.json');
const UA = 'KimBoxPC-Updater';
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;   // 6 小时内不重复查（GitHub 未认证 60 次/小时）

let pkg = { version: '0.0.0' };
try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch (e) {}

const st = {
  checking: false,
  lastCheck: 0,
  latest: null,        // { version, tag, notes, htmlUrl, assets: [{name,url,size}] }
  error: '',
  downloading: false,
  downloaded: null,    // { name, path, size }
  progress: 0
};

function log(msg) {
  try {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(UPDATE_DIR, 'update.log'), `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
}

function saveState() {
  try {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastCheck: st.lastCheck, latest: st.latest }, null, 2));
  } catch (e) {}
}
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s.lastCheck) st.lastCheck = s.lastCheck;
    if (s.latest) st.latest = s.latest;
  } catch (e) {}
}

/** semver 比较：返回 1 / 0 / -1 */
function cmpVersion(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split(/[.+-]/).map(x => parseInt(x, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split(/[.+-]/).map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/** 安装版 or 便携版 */
function installMode() {
  try {
    if (fs.existsSync(path.join(ROOT, 'unins000.exe'))) return 'installer';
  } catch (e) {}
  return 'portable';
}

function pickAsset(assets, mode) {
  const list = assets || [];
  if (mode === 'installer') {
    return list.find(a => /_Setup\.exe$/i.test(a.name)) || list.find(a => /\.exe$/i.test(a.name)) || null;
  }
  return list.find(a => /\.zip$/i.test(a.name)) || null;
}

async function check(force) {
  if (st.checking) return status();
  if (!force && Date.now() - st.lastCheck < CHECK_INTERVAL && st.latest) return status();
  st.checking = true;
  try {
    const r = await axios.get(API, {
      timeout: 20000,
      headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
      validateStatus: () => true
    });
    if (r.status === 404) throw new Error('仓库还没有发布任何 Release');
    if (r.status === 403) throw new Error('请求过于频繁（GitHub 限流），稍后再试');
    if (r.status !== 200) throw new Error(`GitHub 返回 ${r.status}`);
    const d = r.data || {};
    const version = String(d.tag_name || '').replace(/^v/i, '');
    st.latest = {
      version,
      tag: d.tag_name || '',
      name: d.name || '',
      notes: d.body || '',
      htmlUrl: d.html_url || '',
      publishedAt: d.published_at || '',
      assets: (d.assets || []).map(a => ({ name: a.name, url: a.browser_download_url, size: a.size }))
    };
    st.lastCheck = Date.now();
    st.error = '';
    saveState();
    log(`检查完成：current=${pkg.version} latest=${version}`);
  } catch (e) {
    st.error = e.message;
    log('检查失败：' + e.message);
  } finally {
    st.checking = false;
  }
  return status();
}

function status() {
  const mode = installMode();
  const latest = st.latest;
  const asset = latest ? pickAsset(latest.assets, mode) : null;
  const hasUpdate = !!(latest && cmpVersion(latest.version, pkg.version) > 0);
  return {
    current: pkg.version,
    mode,
    checking: st.checking,
    lastCheck: st.lastCheck,
    hasUpdate,
    latest: latest ? { version: latest.version, tag: latest.tag, notes: latest.notes, htmlUrl: latest.htmlUrl, publishedAt: latest.publishedAt } : null,
    asset: asset ? { name: asset.name, size: asset.size } : null,
    downloading: st.downloading,
    progress: st.progress,
    downloaded: st.downloaded ? { name: st.downloaded.name, size: st.downloaded.size } : null,
    error: st.error
  };
}

function assetPath(asset) {
  fs.mkdirSync(UPDATE_DIR, { recursive: true });
  return path.join(UPDATE_DIR, asset.name);
}

async function download(force) {
  const mode = installMode();
  const latest = st.latest;
  if (!latest) throw new Error('还没有检查到新版本');
  if (!force && cmpVersion(latest.version, pkg.version) <= 0) throw new Error('已经是最新版本');
  const asset = pickAsset(latest.assets, mode);
  if (!asset) throw new Error('Release 里没有找到适用于当前安装形态的包');
  if (st.downloading) return status();

  const target = assetPath(asset);
  if (st.downloaded && st.downloaded.name === asset.name && fs.existsSync(target)) return status();

  st.downloading = true;
  st.progress = 0;
  st.error = '';
  log(`开始下载 ${asset.name}（${asset.size} 字节）`);
  try {
    const r = await axios.get(asset.url, {
      responseType: 'stream',
      timeout: 60000,
      maxRedirects: 5,
      headers: { 'User-Agent': UA },
      onDownloadProgress: (e) => {
        if (e.total) st.progress = Math.min(99, Math.round(e.loaded / e.total * 100));
      }
    });
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(target + '.part');
      r.data.pipe(ws);
      r.data.on('error', reject);
      ws.on('error', reject);
      ws.on('finish', resolve);
    });
    const size = fs.statSync(target + '.part').size;
    if (asset.size && Math.abs(size - asset.size) > 1024 * 64) {
      throw new Error(`下载不完整（${size}/${asset.size} 字节）`);
    }
    try { fs.unlinkSync(target); } catch (e) {}
    fs.renameSync(target + '.part', target);
    st.progress = 100;
    st.downloaded = { name: asset.name, path: target, size };
    log(`下载完成 ${asset.name}`);
  } catch (e) {
    st.error = e.message;
    log('下载失败：' + e.message);
    try { fs.unlinkSync(target + '.part'); } catch (err) {}
  } finally {
    st.downloading = false;
  }
  return status();
}

/** 生成便携版覆盖脚本内容（单独抽出便于自检） */
function buildPortableScript(zipPath) {
  const appBat = path.join(ROOT, 'KimBoxPC-桌面版.bat');
  const pid = process.pid;
  return [
    '@echo off',
    'chcp 936 >nul',
    'title KimBoxPC 正在更新',
    'setlocal',
    `set "ROOT=${ROOT}"`,
    `set "ZIP=${zipPath}"`,
    'set "TMPDIR=%ROOT%\\data\\updates\\extract"',
    `echo 正在等待 KimBoxPC 退出...`,
    ':wait',
    `tasklist /FI "PID eq ${pid}" 2>nul | find "${pid}" >nul`,
    'if not errorlevel 1 (',
    '  timeout /t 1 /nobreak >nul',
    '  goto wait',
    ')',
    'echo 正在解压新版本...',
    'if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%" >nul 2>&1',
    'mkdir "%TMPDIR%" >nul 2>&1',
    'tar -xf "%ZIP%" -C "%TMPDIR%" >nul 2>&1',
    'if errorlevel 1 (',
    '  powershell -NoProfile -Command "Expand-Archive -LiteralPath \'%ZIP%\' -DestinationPath \'%TMPDIR%\' -Force" >nul 2>&1',
    ')',
    'set "SRC=%TMPDIR%"',
    'if exist "%TMPDIR%\\KimBoxPC\\node_modules" set "SRC=%TMPDIR%\\KimBoxPC"',
    'if not exist "%SRC%\\node_modules" (',
    '  echo 解压失败，请手动解压 "%ZIP%" 覆盖本目录。',
    '  pause',
    '  exit /b 1',
    ')',
    'echo 正在覆盖文件...',
    'robocopy "%SRC%" "%ROOT%" /E /NFL /NDL /NJH /NJS /nc /ns /np >nul',
    'rmdir /s /q "%TMPDIR%" >nul 2>&1',
    'echo 更新完成，正在启动...',
    `start "" "${appBat}"`,
    'del "%ZIP%" >nul 2>&1',
    'del "%~f0" >nul 2>&1',
    'exit /b 0'
  ].join('\r\n');
}

function applyPortable(zipPath) {
  const bat = path.join(UPDATE_DIR, 'apply-update.bat');
  fs.writeFileSync(bat, buildPortableScript(zipPath), 'utf8');
  const child = spawn('cmd.exe', ['/c', bat], { detached: true, stdio: 'ignore', cwd: UPDATE_DIR, windowsHide: true });
  child.unref();
  log('便携版更新脚本已启动');
}

/** 安装版：静默安装后重新拉起 */
function applyInstaller(exePath) {
  const appExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const cmd = `timeout /t 2 /nobreak >nul & "${exePath}" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART & start "" "${appExe}" "${ROOT}"`;
  const child = spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  log('静默安装已启动');
}

function apply() {
  const mode = installMode();
  const dl = st.downloaded;
  if (!dl || !fs.existsSync(dl.path)) throw new Error('还没有下载好更新包');
  if (mode === 'installer') {
    if (!/\.exe$/i.test(dl.path)) throw new Error('安装版需要 Setup.exe 更新包');
    applyInstaller(dl.path);
    return { ok: true, action: 'installer' };
  }
  if (!/\.zip$/i.test(dl.path)) throw new Error('便携版需要 zip 更新包');
  applyPortable(dl.path);
  return { ok: true, action: 'portable' };
}

/** 启动后延迟检查一次（不阻塞、不弹窗，交给前端决定是否提示） */
function scheduleAutoCheck(delayMs = 20000) {
  loadState();
  const t = setTimeout(() => { check(false).catch(() => {}); }, delayMs);
  if (t.unref) t.unref();
}

module.exports = { check, status, download, apply, scheduleAutoCheck, installMode, cmpVersion, buildPortableScript };

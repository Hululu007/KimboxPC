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
const crypto = require('crypto');
const axios = require('axios');

const ROOT = __dirname;
const REPO = 'jacurtwong/KimboxPC';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const UPDATE_DIR = path.join(ROOT, 'data', 'updates');
const STATE_FILE = path.join(UPDATE_DIR, 'state.json');
const UA = 'KimBoxPC-Updater';
const CHECK_INTERVAL = 15 * 60 * 1000;       // 已发现「比当前新」的版本：15 分钟内不重复查（避免频繁打 GitHub）
const CHECK_INTERVAL_IDLE = 15 * 60 * 1000;     // 缓存里没有更新的版本：同样 15 分钟重查一次

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
    fs.writeFileSync(STATE_FILE, JSON.stringify({ lastCheck: st.lastCheck, latest: st.latest, applied: st.applied || null }, null, 2));
  } catch (e) {}
}
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s.lastCheck) st.lastCheck = s.lastCheck;
    if (s.latest) st.latest = s.latest;
    if (s.applied) st.applied = s.applied;
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
  // 缓存只有在「确实发现了比当前新的版本」时才值得复用；否则按短周期重查
  if (!force && st.latest && st.lastCheck) {
    const cachedNewer = cmpVersion(st.latest.version, pkg.version) > 0;
    const windowMs = cachedNewer ? CHECK_INTERVAL : CHECK_INTERVAL_IDLE;
    if (Date.now() - st.lastCheck < windowMs) return status();
  }
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
      assets: (d.assets || []).map(a => ({ name: a.name, url: a.browser_download_url, size: a.size, digest: a.digest || '' }))
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

/** 列出 updates 目录里的安装包（*.exe / *.zip / *.part） */
function listPackages() {
  const out = [];
  try {
    for (const name of fs.readdirSync(UPDATE_DIR)) {
      if (!/\.(exe|zip|part)$/i.test(name)) continue;
      try {
        const s = fs.statSync(path.join(UPDATE_DIR, name));
        out.push({ name, size: s.size, at: s.mtimeMs });
      } catch (e) {}
    }
  } catch (e) {}
  return out;
}

/** 删除旧安装包：keepName 指定的那一个保留（正在下载/刚下好的） */
function cleanOldPackages(keepName) {
  let removed = 0;
  for (const p of listPackages()) {
    if (keepName && p.name === keepName) continue;
    if (keepName && p.name === keepName + '.part') continue;
    if (/\.part$/i.test(p.name)) continue;   // 半截文件交给下载逻辑管
    try { fs.unlinkSync(path.join(UPDATE_DIR, p.name)); removed++; } catch (e) {}
  }
  return removed;
}

/** 更新缓存信息（给管理面板显示占用） */
function cacheInfo() {
  const files = listPackages();
  return { dir: UPDATE_DIR, files, totalBytes: files.reduce((a, b) => a + b.size, 0) };
}

/** 清理全部安装包（除正在下载的半截文件外） */
function cleanCache() {
  let removed = 0, bytes = 0;
  for (const p of listPackages()) {
    if (/\.part$/i.test(p.name)) continue;
    try { fs.unlinkSync(path.join(UPDATE_DIR, p.name)); removed++; bytes += p.size; } catch (e) {}
  }
  st.downloaded = null;
  log('已清理更新缓存：删除 ' + removed + ' 个文件，释放 ' + Math.round(bytes / 1048576) + ' MB');
  return { removed, bytes };
}

/** 启动时清理：上次已经用来安装的那个包，装完就没用了 */
function cleanupOnStart() {
  loadState();
  if (st.applied && st.applied.name) {
    try {
      const f = path.join(UPDATE_DIR, st.applied.name);
      if (fs.existsSync(f)) { fs.unlinkSync(f); log('已清理上次使用的安装包: ' + st.applied.name); }
    } catch (e) {}
    st.applied = null;
    saveState();
  }
  // 顺手清掉半截下载文件
  try {
    for (const name of fs.readdirSync(UPDATE_DIR)) {
      if (/\.part$/i.test(name)) { try { fs.unlinkSync(path.join(UPDATE_DIR, name)); } catch (e) {} }
    }
  } catch (e) {}
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
  // 只保留本次要下的包，旧的先删掉（每个约 300MB，不清会越积越多）
  const removed = cleanOldPackages(asset.name);
  if (removed) log(`下载前清理了 ${removed} 个旧安装包`);
  log(`开始下载 ${asset.name}（${asset.size} 字节）`);
  try {
    const r = await axios.get(asset.url, {
      responseType: 'stream',
      timeout: 60000,
      maxRedirects: 5,
      headers: { 'User-Agent': UA }
    });
    const total = Number(r.headers['content-length']) || Number(asset.size) || 0;
    let received = 0;
    r.data.on('data', (chunk) => {
      received += chunk.length;
      if (total > 0) st.progress = Math.min(99, Math.floor(received / total * 100));
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
    // 用 GitHub 给的 digest 做完整性校验（和 xiugou-tv 的做法一致）
    if (asset.digest && /^sha256:/i.test(asset.digest)) {
      const want = asset.digest.replace(/^sha256:/i, '').toLowerCase();
      const got = await sha256File(target + '.part');
      if (got !== want) throw new Error('安装包校验失败（sha256 不一致），已删除，请重试');
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

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(file);
    rs.on('data', (d) => h.update(d));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * 安装版：直接启动 Inno 安装程序（**带界面、能看到进度**），然后退出自己。
 * 参考 xiugou-tv 的 InstallerLauncher：只传 /CLOSEAPPLICATIONS /NORESTART，
 * 不使用 /SILENT 或 /VERYSILENT——用户要能看到安装过程。
 */
function applyInstaller(exePath) {
  const child = spawn(exePath, ['/CLOSEAPPLICATIONS', '/NORESTART'], {
    detached: true, stdio: 'ignore', cwd: path.dirname(exePath)
  });
  child.unref();
  log('已启动安装程序（可见界面）: ' + path.basename(exePath));
}

/**
 * 便携版：**不自动覆盖自己**（进程正在运行、目录结构也各异）。
 * 只把下载好的 zip 所在目录打开，让用户自己解压覆盖——这也是 xiugou-tv 的做法：
 * 便携版只提示，不自动替换。
 */
function openUpdatesFolder() {
  try {
    spawn('explorer.exe', [UPDATE_DIR], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch (e) { return false; }
}

function apply() {
  const mode = installMode();
  const dl = st.downloaded;
  if (!dl || !fs.existsSync(dl.path)) throw new Error('还没有下载好更新包');
  if (mode === 'installer') {
    if (!/\.exe$/i.test(dl.path)) throw new Error('安装版需要 Setup.exe 更新包');
    applyInstaller(dl.path);
    st.applied = { name: dl.name, at: Date.now() };
    saveState();
    return { ok: true, action: 'installer', file: dl.path };
  }
  if (!/\.zip$/i.test(dl.path)) throw new Error('便携版需要 zip 更新包');
  const opened = openUpdatesFolder();
  log('便携版：已下载 ' + dl.name + '，等待用户手动覆盖');
  return { ok: true, action: 'manual', file: dl.path, folder: UPDATE_DIR, opened };
}

/** 启动后延迟检查一次（不阻塞、不弹窗，交给前端决定是否提示） */
function scheduleAutoCheck(delayMs = 8000) {
  loadState();
  // 每次启动都真的查一次（只多一个请求），避免上次缓存的旧版本号把红点压住
  const t = setTimeout(() => { check(true).catch(() => {}); }, delayMs);
  if (t.unref) t.unref();
}

/** 运行期定时复查：发现新版本后前端红点/提示才能跟上（默认 30 分钟，走缓存规则） */
function schedulePeriodicCheck(intervalMs = CHECK_INTERVAL_IDLE) {
  const timer = setInterval(() => { check(false).catch(() => {}); }, intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { check, status, download, apply, scheduleAutoCheck, schedulePeriodicCheck, installMode, cmpVersion, sha256File, cacheInfo, cleanCache, cleanupOnStart, cleanOldPackages, listPackages };

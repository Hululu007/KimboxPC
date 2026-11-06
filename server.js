const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ConfigParser = require('./configParser');
const CmsEngine = require('./cmsEngine');
const PlayerLauncher = require('./playerLauncher');
const Mpv = require('./mpvController');
const { ConfigRepo, HistoryRepo, FavoriteRepo, backup, listBackups, deleteBackup, restoreBackup } = require('./db');

const app = express();
// 监听地址（是否允许局域网访问）：环境变量 HOST > host.txt > 127.0.0.1
function readHost() {
  const pick = (v) => {
    const s = String(v || '').trim();
    if (!s) return null;
    if (/^(localhost|0\.0\.0\.0|::)$/i.test(s)) return s === '0.0.0.0' ? '0.0.0.0' : s;
    // 合法 IPv4 / 主机名
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s) || /^[A-Za-z0-9.-]+$/.test(s)) return s;
    return null;
  };
  const fromEnv = pick(process.env.HOST);
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'host.txt'), 'utf8').trim().split(/\r?\n/)[0];
    const fromFile = pick(raw);
    if (fromFile) return fromFile;
  } catch (e) {}
  return '127.0.0.1';
}
const HOST = readHost();

/** 是否对外网开放（非纯回环） */
function isLanOpen() {
  return !(HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1');
}

/** 列出本机局域网 IPv4 地址 */
function lanAddresses() {
  const out = [];
  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const ni of nets[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
      }
    }
  } catch (e) {}
  return out;
}

// 端口：环境变量 PORT > port.txt > 3980
function readPort() {
  if (process.env.PORT) {
    const n = Number(process.env.PORT);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  }
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'port.txt'), 'utf8').trim().split(/\r?\n/)[0].trim();
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  } catch (e) {}
  return 3980;
}
const PORT = readPort();
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 记录进程号，供 stop.bat 精确停止（避免残留后台进程锁住数据库）
const PID_FILE = path.join(__dirname, 'data', '.server.pid');
function writePid() {
  try {
    if (!fs.existsSync(path.dirname(PID_FILE))) fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch (e) {}
}
function clearPid() {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (e) {}
}
process.on('exit', clearPid);
process.on('SIGINT', () => { clearPid(); process.exit(0); });
process.on('SIGTERM', () => { clearPid(); process.exit(0); });
process.on('SIGHUP', () => { clearPid(); process.exit(0); });

// 由 start.bat 启动时，监控父窗口进程：窗口一关，服务自动退出，不留后台
if (process.env.TVBOX_WATCH_PARENT === '1') {
  const parentPid = process.ppid;
  const watcher = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch (e) {
      clearInterval(watcher);
      console.log('\n父窗口已关闭，服务自动停止。');
      clearPid();
      process.exit(0);
    }
  }, 3000);
  if (watcher.unref) watcher.unref();
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 当前运行状态
const state = {
  configId: null,
  url: '',
  sites: [],
  activeSite: null
};

function publicSite(s) {
  return { key: s.key, name: s.name, type: s.type, isDexSpider: !!s.isDexSpider };
}

async function applyConfig(row) {
  const parsed = await ConfigParser.load(row.url);
  state.configId = row.id;
  state.url = row.url;
  state.sites = parsed.sites || [];
  const preferred = row.default_site ? state.sites.find(s => s.key === row.default_site) : null;
  state.activeSite = preferred || state.sites.find(s => !s.isDexSpider) || state.sites[0] || null;
  ConfigRepo.touch(row.id);
  return state;
}

/* ==================== 配置源管理 ==================== */

app.get('/api/configs', (req, res) => {
  res.json({
    configs: ConfigRepo.list(),
    current: { id: state.configId, url: state.url }
  });
});

app.post('/api/configs', async (req, res) => {
  const url = String(req.body.url || '').trim();
  if (!url) return res.status(400).json({ error: '请提供配置源地址' });

  try {
    const parsed = await ConfigParser.load(url);
    let name = String(req.body.name || '').trim();
    if (!name) {
      try { name = new URL(url).hostname; } catch (e) { name = url.slice(0, 30); }
    }
    const row = ConfigRepo.add(url, `${name} · ${(parsed.sites || []).length}站`);
    await applyConfig(row);
    res.json({
      success: true,
      configs: ConfigRepo.list(),
      current: { id: row.id, url: row.url },
      siteCount: state.sites.length,
      sites: state.sites.map(publicSite),
      activeSite: state.activeSite ? state.activeSite.key : null
    });
  } catch (e) {
    res.status(500).json({ error: '配置加载失败: ' + e.message });
  }
});

app.delete('/api/configs/:id', async (req, res) => {
  const id = Number(req.params.id);
  ConfigRepo.remove(id);

  if (state.configId === id) {
    state.configId = null;
    state.url = '';
    state.sites = [];
    state.activeSite = null;
    // 若还有其它配置源，自动接管，避免界面变成空壳
    const rest = ConfigRepo.list();
    if (rest.length > 0) {
      try { await applyConfig(rest[0]); } catch (e) { console.log('切换配置源失败:', e.message); }
    }
  }

  res.json({
    success: true,
    configs: ConfigRepo.list(),
    current: { id: state.configId, url: state.url },
    sites: state.sites.map(publicSite),
    activeSite: state.activeSite ? state.activeSite.key : null
  });
});

app.post('/api/configs/:id/activate', async (req, res) => {
  const row = ConfigRepo.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '配置不存在' });
  try {
    await applyConfig(row);
    res.json({
      success: true,
      siteCount: state.sites.length,
      sites: state.sites.map(publicSite),
      activeSite: state.activeSite ? state.activeSite.key : null
    });
  } catch (e) {
    res.status(500).json({ error: '配置加载失败: ' + e.message });
  }
});

// 兼容旧接口
app.post('/api/config/load', async (req, res) => {
  const url = String(req.body.url || '').trim();
  if (!url) return res.status(400).json({ error: '请提供配置源 URL' });
  try {
    const parsed = await ConfigParser.load(url);
    const row = ConfigRepo.add(url, new URL(url).hostname + ` · ${(parsed.sites || []).length}站`);
    await applyConfig(row);
    res.json({
      success: true,
      siteCount: state.sites.length,
      sites: state.sites.map(publicSite),
      activeSite: state.activeSite ? state.activeSite.key : null
    });
  } catch (e) {
    res.status(500).json({ error: '配置加载失败: ' + e.message });
  }
});

app.get('/api/sites', (req, res) => {
  const row = state.configId ? ConfigRepo.get(state.configId) : null;
  res.json({
    sites: state.sites.map(publicSite),
    activeSite: state.activeSite ? state.activeSite.key : null,
    defaultSite: row ? row.default_site : ''
  });
});

// 设置当前配置源的默认站点
app.post('/api/site/default', (req, res) => {
  const siteKey = String((req.body && req.body.siteKey) || '');
  if (!state.configId) return res.status(400).json({ error: '尚未加载配置源' });
  if (!state.sites.some(s => s.key === siteKey)) return res.status(404).json({ error: '站点不存在' });
  ConfigRepo.setDefaultSite(state.configId, siteKey);
  state.activeSite = state.sites.find(s => s.key === siteKey);
  res.json({ success: true, defaultSite: siteKey });
});

// 清除默认站点（恢复「第一个可用站点」）
app.delete('/api/site/default', (req, res) => {
  if (!state.configId) return res.status(400).json({ error: '尚未加载配置源' });
  ConfigRepo.setDefaultSite(state.configId, '');
  res.json({ success: true });
});

app.post('/api/site/select', (req, res) => {
  const found = state.sites.find(s => s.key === req.body.siteKey);
  if (!found) return res.status(404).json({ error: '站点未找到' });
  state.activeSite = found;
  res.json({ success: true, activeSite: found.name });
});

/* ==================== 影视数据 ==================== */

function requireSite(res) {
  if (!state.activeSite) {
    res.status(400).json({ error: '未选择站点或未加载配置' });
    return false;
  }
  return true;
}

app.get('/api/home', async (req, res) => {
  if (!requireSite(res)) return;
  try {
    res.json(await CmsEngine.getHome(state.activeSite));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/category', async (req, res) => {
  if (!requireSite(res)) return;
  try {
    res.json(await CmsEngine.getCategory(state.activeSite, req.query.tid || '', req.query.pg || 1));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/detail', async (req, res) => {
  if (!requireSite(res)) return;
  try {
    // 必须先切到影片所属站点，再查详情；否则会用 id 去错误的站点查
    const siteKey = req.query.siteKey || state.activeSite.key;
    if (siteKey !== state.activeSite.key) {
      const target = state.sites.find(s => s.key === siteKey);
      if (target) {
        state.activeSite = target;
      } else {
        return res.status(404).json({ error: '该影片所属站点不存在: ' + siteKey });
      }
    }

    const detail = await CmsEngine.getDetail(state.activeSite, req.query.id);
    if (!detail) return res.json(null);

    // 附带该片在本机的播放历史，用于续播
    detail.history = HistoryRepo.get(siteKey, String(req.query.id)) || null;
    detail.siteKey = siteKey;
    detail.favorited = FavoriteRepo.has(siteKey, String(req.query.id));
    res.json(detail);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/search', async (req, res) => {
  if (!req.query.wd) return res.json({ list: [] });
  if (!requireSite(res)) return;
  try {
    res.json(await CmsEngine.search(state.activeSite, req.query.wd, req.query.pg || 1));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ==================== 跨站聚合搜索 ==================== */

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      v => { clearTimeout(t); resolve(v); },
      e => { clearTimeout(t); reject(e); }
    );
  });
}

app.get('/api/search/all', async (req, res) => {
  const wd = String(req.query.wd || '').trim();
  if (!wd) return res.json({ list: [], status: [] });

  const sites = state.sites.filter(s => !s.isDexSpider && s.searchable !== 0);
  if (sites.length === 0) return res.json({ list: [], status: [] });

  const CONCURRENCY = 8;
  const SITE_TIMEOUT = 9000;
  const collected = [];
  const status = [];
  let cursor = 0;

  async function worker() {
    while (cursor < sites.length) {
      const site = sites[cursor++];
      const t0 = Date.now();
      try {
        const r = await withTimeout(CmsEngine.search(site, wd, 1), SITE_TIMEOUT);
        const list = (r.list || []).map(v => ({
          ...v,
          siteKey: site.key,
          siteName: site.name
        }));
        collected.push(...list);
        status.push({ key: site.key, name: site.name, count: list.length, ms: Date.now() - t0 });
      } catch (e) {
        status.push({ key: site.key, name: site.name, count: 0, error: true, ms: Date.now() - t0 });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sites.length) }, worker));

  // 同名影片合并：保留第一个，记录来源数量
  const merged = new Map();
  for (const v of collected) {
    const key = String(v.vod_name || '').replace(/\s+/g, '').toLowerCase();
    if (!key) continue;
    if (!merged.has(key)) {
      merged.set(key, { ...v, sources: 1 });
    } else {
      merged.get(key).sources += 1;
    }
  }

  const list = [...merged.values()].sort((a, b) => (b.sources - a.sources));

  res.json({
    list,
    status,
    totalSites: sites.length,
    okSites: status.filter(s => !s.error && s.count > 0).length,
    failedSites: status.filter(s => s.error).length
  });
});

/* ==================== 播放地址解析（网页源 → 直链） ==================== */

const resolveCache = new Map();

function looksDirect(url) {
  return /\.(m3u8|mp4|flv|mkv|ts|webm|mp3|m4a)(\?|#|$)/i.test(url);
}

async function probeMedia(url) {
  try {
    const r = await axios.head(url, {
      timeout: 8000,
      maxRedirects: 5,
      validateStatus: (s) => s < 400,
      headers: { 'User-Agent': DESKTOP_UA }
    });
    const ct = String(r.headers['content-type'] || '').toLowerCase();
    return (
      ct.includes('mpegurl') || ct.includes('video') ||
      ct.includes('octet-stream') || ct.includes('mp2t') || ct === ''
    );
  } catch (e) {
    return false;
  }
}

async function resolveMediaUrl(rawUrl) {
  const url = String(rawUrl || '').trim();
  if (!url) throw new Error('空地址');
  if (looksDirect(url)) return { url, resolved: false, direct: true };
  if (resolveCache.has(url)) return { url: resolveCache.get(url), resolved: true, cached: true };

  let origin = '';
  try { origin = new URL(url).origin; } catch (e) {}

  const resp = await axios.get(url, {
    timeout: 12000,
    maxRedirects: 5,
    responseType: 'text',
    headers: {
      'User-Agent': DESKTOP_UA,
      'Referer': origin + '/',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });

  const html = String(resp.data || '');

  // 1) 页面里直接写着的 m3u8 / mp4 地址
  const matches = [...html.matchAll(/https?:\/\/[^'"\s<>\\)]+?\.(?:m3u8|mp4|flv)[^'"\s<>\\)]*/gi)]
    .map(m => m[0].replace(/\\\//g, '/'));

  // 2) 播页后拼接 /index.m3u8 的常见形式
  if (!matches.length) {
    matches.push(url.replace(/\/+$/, '') + '/index.m3u8');
  }

  for (const candidate of matches) {
    if (await probeMedia(candidate)) {
      resolveCache.set(url, candidate);
      if (resolveCache.size > 500) resolveCache.delete(resolveCache.keys().next().value);
      return { url: candidate, resolved: true };
    }
  }

  throw new Error('页面中未找到可播放的视频地址');
}

app.get('/api/resolve', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: '缺少 url 参数' });
  try {
    res.json(await resolveMediaUrl(url));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ==================== mpv 内核播放（IPC 控制） ==================== */

app.get('/api/mpv/status', async (req, res) => {
  const exe = Mpv.findMpv();
  let st = null;
  try { st = await Mpv.getState(); } catch (e) {}
  res.json({ available: !!exe, path: exe || '', state: st });
});

app.get('/api/mpv/state', async (req, res) => {
  try {
    res.json(await Mpv.getState());
  } catch (e) {
    res.json({ running: false, connected: false, error: e.message });
  }
});

app.post('/api/mpv/open', async (req, res) => {
  const { url, title, start } = req.body || {};
  if (!url) return res.status(400).json({ error: '缺少 url' });
  try {
    await Mpv.load(url, title || '', Number(start) || 0);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const MPV_ALLOWED = new Set(['seek', 'cycle', 'set_property', 'stop', 'quit', 'frame-step', 'frame-back-step']);
const MPV_ALLOWED_PROPS = new Set(['pause', 'volume', 'speed', 'mute', 'fullscreen', 'ontop', 'keep-open']);

app.post('/api/mpv/cmd', async (req, res) => {
  const { name, args } = req.body || {};
  if (!MPV_ALLOWED.has(name)) return res.status(400).json({ error: '不允许的命令: ' + name });
  if (name === 'set_property' && !MPV_ALLOWED_PROPS.has(String((args || [])[0]))) {
    return res.status(400).json({ error: '不允许修改的属性: ' + (args || [])[0] });
  }
  try {
    const r = await Mpv.command(name, Array.isArray(args) ? args : []);
    res.json({ success: true, data: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/mpv/stop', (req, res) => {
  Mpv.stop();
  res.json({ success: true });
});

/* ==================== 转封装兼容模式（修复声音异常） ==================== */
// 部分源的播放列表带 DISCONTINUITY（时间戳重置），Chrome 的 MSE 音频渲染会出错。
// 用 ffmpeg -c copy 重新封装成时间戳连续的 MPEG-TS 直供浏览器，可彻底规避。
// 拖动进度 = 以新位置重启 ffmpeg（约 2~3 秒）。

const { spawn } = require('child_process');

let ffmpegPath = null;
function findFfmpeg() {
  if (ffmpegPath !== null) return ffmpegPath;
  const cands = [
    // 优先使用随附的便携版（不依赖系统安装）
    path.join(__dirname, 'ffmpeg', 'ffmpeg.exe'),
    path.join(__dirname, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    path.join(__dirname, 'bin', 'ffmpeg.exe'),
    // 其次系统安装位置
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe')
  ];
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) { ffmpegPath = c; return ffmpegPath; } } catch (e) {}
  }
  ffmpegPath = 'ffmpeg';   // 依赖 PATH
  return ffmpegPath;
}

const remuxSessions = new Set();
const REMUX_MAX = 3;

app.get('/api/remux/status', (req, res) => {
  res.json({ available: !!findFfmpeg(), ffmpeg: findFfmpeg(), active: remuxSessions.size, max: REMUX_MAX });
});

app.get('/api/remux', (req, res) => {
  const url = String(req.query.url || '').trim();
  const start = Math.max(0, Number(req.query.start || 0) || 0);
  if (!url) return res.status(400).json({ error: '缺少 url' });

  // 超出并发上限时踢掉最早的一个
  while (remuxSessions.size >= REMUX_MAX) {
    const oldest = remuxSessions.values().next().value;
    try { oldest.kill('SIGKILL'); } catch (e) {}
    remuxSessions.delete(oldest);
  }

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-user_agent', DESKTOP_UA,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3',
    ...(start > 0 ? ['-ss', String(start)] : []),
    '-i', url,
    '-c', 'copy', '-fflags', '+genpts',
    '-muxdelay', '0', '-muxpreload', '0',
    '-f', 'mpegts', 'pipe:1'
  ];

  let proc;
  try {
    proc = spawn(findFfmpeg(), args, { windowsHide: true });
  } catch (e) {
    return res.status(500).json({ error: '无法启动 ffmpeg: ' + e.message });
  }

  remuxSessions.add(proc);
  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Connection', 'close');

  proc.stdout.pipe(res);

  const stop = () => {
    remuxSessions.delete(proc);
    try { proc.kill('SIGKILL'); } catch (e) {}
  };
  req.on('close', stop);
  res.on('close', stop);
  proc.on('error', () => { try { res.end(); } catch (e) {} stop(); });
  proc.on('exit', () => { remuxSessions.delete(proc); try { res.end(); } catch (e) {} });
});

/* ==================== 播放列表质量探测 ==================== */

const probeCache = new Map();

/**
 * 探测 m3u8 的封装质量：跨越 DISCONTINUITY 时时间戳会重置，
 * hls.js 需要重建时间轴，浏览器音频渲染偶发判错 → 声音变调/发闷。
 */
async function probePlaylist(url) {
  if (!/\.m3u8/i.test(url)) return null;
  if (probeCache.has(url)) return probeCache.get(url);
  let res;
  try {
    const r = await axios.get(url, {
      timeout: 12000,
      responseType: 'text',
      headers: { 'User-Agent': DESKTOP_UA }
    });
    const t = String(r.data || '');
    const infs = [...t.matchAll(/#EXTINF:([\d.]+)/g)].map(m => parseFloat(m[1]) || 0);
    res = {
      disc: (t.match(/#EXT-X-DISCONTINUITY\b/g) || []).length,
      segments: infs.length,
      duration: Math.round(infs.reduce((a, b) => a + b, 0)),
      multiAudio: (t.match(/#EXT-X-MEDIA:.*TYPE=AUDIO/g) || []).length
    };
  } catch (e) {
    res = { error: e.message };
  }
  probeCache.set(url, res);
  if (probeCache.size > 500) probeCache.delete(probeCache.keys().next().value);
  return res;
}

app.get('/api/probe', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: '缺少 url 参数' });
  res.json(await probePlaylist(url) || {});
});

/* ==================== 同片源聚合（按延迟排序） ==================== */

const sourceCache = new Map(); // name -> { at, data }
const SOURCE_CACHE_TTL = 5 * 60 * 1000;

const normName = (s) => String(s || '').replace(/[\s·・,，.。:：!！?？'"“”()（）\[\]【】]/g, '').toLowerCase();

app.get('/api/sources', async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.json({ list: [], totalSites: 0, okSites: 0 });

  const cacheKey = normName(name);
  const hit = sourceCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SOURCE_CACHE_TTL) {
    return res.json({ ...hit.data, cached: true });
  }

  const sites = state.sites.filter(s => !s.isDexSpider && s.searchable !== 0);
  if (sites.length === 0) return res.json({ list: [], totalSites: 0, okSites: 0 });

  const target = normName(name);
  const CONCURRENCY = 6;
  const TIMEOUT = 9000;
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < sites.length) {
      const site = sites[cursor++];
      const t0 = Date.now();
      try {
        const s = await withTimeout(CmsEngine.search(site, name, 1), TIMEOUT);
        const candidates = s.list || [];
        // 片名完全一致，或包含关系（去掉标点后比较）
        const match = candidates.find(v => normName(v.vod_name) === target)
          || candidates.find(v => normName(v.vod_name).includes(target) || target.includes(normName(v.vod_name)));
        if (!match) continue;

        const d = await withTimeout(CmsEngine.getDetail({ api: site.api }, match.vod_id), TIMEOUT);
        if (!d || !d.playSources || d.playSources.length === 0) continue;

        // 顺带探测这条源首集的封装质量（有 discontinuity 的源更容易出现声音异常）
        let probe = null;
        try {
          const firstUrl = d.playSources[0].episodes[0].url;
          probe = await probePlaylist(firstUrl);
        } catch (e) {}

        results.push({
          siteKey: site.key,
          siteName: site.name,
          vodId: match.vod_id,
          vodName: d.vod_name || match.vod_name,
          pic: match.vod_pic || '',
          lines: d.playSources.map(p => p.sourceName),
          episodes: d.playSources.reduce((m, p) => Math.max(m, (p.episodes || []).length), 0),
          disc: probe ? probe.disc : null,
          ms: Date.now() - t0
        });
      } catch (e) {
        /* 超时或站点异常，忽略该站 */
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sites.length) }, worker));
  results.sort((a, b) => a.ms - b.ms);

  const data = { list: results, totalSites: sites.length, okSites: results.length };
  sourceCache.set(cacheKey, { at: Date.now(), data });
  if (sourceCache.size > 200) sourceCache.delete(sourceCache.keys().next().value);

  res.json(data);
});

/* ==================== 播放历史 ==================== */

app.get('/api/history', (req, res) => {
  res.json({ list: HistoryRepo.list(Number(req.query.limit || 100)) });
});

app.post('/api/history', (req, res) => {
  const b = req.body || {};
  if (!b.siteKey || !b.vodId) return res.status(400).json({ error: '缺少 siteKey / vodId' });
  HistoryRepo.save(b);
  res.json({ success: true });
});

app.delete('/api/history', (req, res) => {
  const bak = backup('before-clear-history');
  HistoryRepo.clear();
  res.json({ success: true, backup: bak.file || null });
});

app.delete('/api/history/:siteKey/:vodId', (req, res) => {
  HistoryRepo.remove(req.params.siteKey, req.params.vodId);
  res.json({ success: true });
});

/* ==================== 收藏 ==================== */

app.get('/api/favorites', (req, res) => {
  res.json({ list: FavoriteRepo.list() });
});

app.post('/api/favorites/toggle', (req, res) => {
  const b = req.body || {};
  if (!b.siteKey || !b.vodId) return res.status(400).json({ error: '缺少 siteKey / vodId' });
  const favorited = FavoriteRepo.toggle(b);
  res.json({ success: true, favorited });
});

app.delete('/api/favorites', (req, res) => {
  const bak = backup('before-clear-favorites');
  FavoriteRepo.clear();
  res.json({ success: true, backup: bak.file || null });
});

app.delete('/api/favorites/:siteKey/:vodId', (req, res) => {
  FavoriteRepo.remove(req.params.siteKey, req.params.vodId);
  res.json({ success: true });
});

/* ==================== 版本信息 ==================== */

const PKG = require('./package.json');

/** 读取 更新.md 里最新的版本号，用于校验 package.json 是否忘记同步 */
function latestChangelogVersion() {
  try {
    const md = fs.readFileSync(path.join(__dirname, '更新.md'), 'utf8');
    const m = md.match(/^##\s*\[([0-9]+\.[0-9]+\.[0-9]+)\]/m);
    return m ? m[1] : null;
  } catch (e) {
    return null;
  }
}

app.get('/api/version', (req, res) => {
  const cl = latestChangelogVersion();
  res.json({
    version: PKG.version,
    changelogVersion: cl,
    versionMismatch: !!cl && cl !== PKG.version,
    name: PKG.name,
    host: HOST,
    lanOpen: isLanOpen(),
    lanUrls: lanAddresses().map((ip) => 'http://' + ip + ':' + PORT),
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    node: process.versions.node
  });
});

/* ==================== 备份 ==================== */

app.get('/api/backups', (req, res) => {
  const list = listBackups();
  res.json({
    dir: 'data/backups',
    autoKeep: 5,
    manualCount: list.filter(b => b.manual).length,
    autoCount: list.filter(b => !b.manual).length,
    list
  });
});

// 手动备份：永不自动删除，需手动删
app.post('/api/backup', (req, res) => {
  const r = backup('manual');
  res.json({ success: !r.error, ...r });
});

app.delete('/api/backups/:name', (req, res) => {
  try {
    res.json({ success: true, ...deleteBackup(req.params.name) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/backups/:name/restore', async (req, res) => {
  try {
    const r = restoreBackup(req.params.name);
    // 库已被替换，内存里的站点状态需要重新加载
    state.configId = null;
    state.url = '';
    state.sites = [];
    state.activeSite = null;
    const saved = ConfigRepo.list();
    if (saved.length > 0) {
      try { await applyConfig(saved[0]); } catch (e) {}
    }
    res.json({ success: true, ...r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* ==================== 初始化 / 重置 ==================== */

app.post('/api/reset', (req, res) => {
  const scope = String((req.body && req.body.scope) || 'all');
  try {
    if (scope === 'all' || scope === 'favorites' || scope === 'history') backup('before-reset');
    if (scope === 'all' || scope === 'configs') {
      ConfigRepo.clear();
      state.configId = null;
      state.url = '';
      state.sites = [];
      state.activeSite = null;
    }
    if (scope === 'all' || scope === 'history') HistoryRepo.clear();
    if (scope === 'all' || scope === 'favorites') FavoriteRepo.clear();
    res.json({ success: true, scope });
  } catch (e) {
    res.status(500).json({ error: '重置失败: ' + e.message });
  }
});

/* ==================== 外部播放器 ==================== */

app.get('/api/players', (req, res) => {
  const list = PlayerLauncher.listAvailable();
  res.json({
    players: list.map(p => ({ id: p.id, name: p.name, friendly: p.friendly, hasUi: p.hasUi })),
    defaultId: list.length ? list[0].id : ''
  });
});

app.post('/api/play/external', async (req, res) => {
  const { url, title, player } = req.body || {};
  if (!url) return res.status(400).json({ error: '缺少播放 URL' });
  try {
    res.json(await PlayerLauncher.play(url, title || 'TVBox 视频', player || ''));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const server = app.listen(PORT, HOST);

server.on('listening', async () => {
  writePid();
  const bak = backup('startup');
  console.log('========================================');
  console.log('KimBoxPC 版已就绪！');
  console.log(`本地界面地址: http://127.0.0.1:${PORT}`);

  if (isLanOpen()) {
    const ips = lanAddresses();
    console.log(`监听地址: ${HOST}:${PORT}（已开放局域网访问）`);
    if (ips.length) {
      ips.forEach(ip => console.log(`局域网地址: http://${ip}:${PORT}`));
    } else {
      console.log('未检测到局域网 IP，请检查网络连接。');
    }
    console.log('提示: 其它设备访问不了时，请放行 Windows 防火墙（见 README）。');
  } else {
    console.log('监听地址: 127.0.0.1（仅本机可访问；要开放局域网请把 host.txt 改成 0.0.0.0）');
  }

  // 启动时自动恢复上次使用的配置源
  const saved = ConfigRepo.list();
  if (saved.length > 0) {
    try {
      await applyConfig(saved[0]);
      console.log(`已恢复配置源: ${saved[0].name || saved[0].url}（${state.sites.length} 个站点）`);
    } catch (e) {
      console.log('恢复配置源失败:', e.message);
    }
  } else {
    console.log('尚未添加配置源，请在界面中点击「＋ 添加」。');
  }
  if (bak && bak.file) console.log('已自动备份数据: data/backups/' + bak.file);

  const clVersion = latestChangelogVersion();
  if (clVersion && clVersion !== PKG.version) {
    console.log(`[!] 版本号不一致：package.json=${PKG.version}，更新.md=${clVersion}`);
    console.log(`    发布前请把 package.json 的 version 改成 ${clVersion}`);
  }

  console.log('========================================');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('');
    console.error(`[X] 端口 ${PORT} 已被占用，可能已经有一个实例在运行。`);
    console.error('    1) 先关掉之前的命令行窗口；或');
    console.error(`    2) 换个端口启动:  set PORT=8090  &&  node server.js`);
    console.error('');
    process.exit(1);
  }
  console.error('[X] 服务启动失败:', e.message);
  process.exit(1);
});

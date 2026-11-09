const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ConfigParser = require('./configParser');
const CmsEngine = require('./cmsEngine');
const PlayerLauncher = require('./playerLauncher');
const { ConfigRepo, HistoryRepo, FavoriteRepo, ShowMarkRepo, backup, listBackups, deleteBackup, restoreBackup } = require('./db');

const app = express();
// 仅监听本机回环（桌面版专用，不再支持局域网访问）
const HOST = '127.0.0.1';

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

// 重命名配置源（首页下拉显示的就是这个名字）
app.post('/api/configs/:id/rename', (req, res) => {
  const id = Number(req.params.id);
  const name = String((req.body && req.body.name) || '').trim();
  if (!id) return res.status(400).json({ error: '缺少 id' });
  const row = ConfigRepo.get(id);
  if (!row) return res.status(404).json({ error: '配置源不存在' });
  ConfigRepo.rename(id, name);
  res.json({ success: true, name });
});

app.get('/api/configs', (req, res) => {
  const live = state.sites ? state.sites.length : 0;
  const configs = ConfigRepo.list().map(c => {
    // 名称里可能带旧的数量后缀（添加时写死的），这里剥掉，由前端用实时数量渲染
    const base = String(c.name || '').replace(/\s*·\s*\d+\s*站\s*$/, '');
    return {
      ...c,
      name: base,
      siteCount: (c.id === state.configId) ? live : null
    };
  });
  res.json({
    configs,
    current: { id: state.configId, url: state.url },
    liveSiteCount: live
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
    const row = ConfigRepo.add(url, name);   // 数量改为前端按实时值渲染
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
    let name = '';
    try { name = new URL(url).hostname; } catch (e) { name = url.slice(0, 30); }
    const row = ConfigRepo.add(url, name);   // 同上，不再写死数量
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

/* ---------- 站点延迟探测 ----------
   并发拉每个站点的首页接口并计时，用于下拉列表标注快慢。
   结果缓存 3 分钟，避免每次打开下拉都重新压测。 */
const sitePingCache = new Map();  // key -> { ms, ok, ts }
const SITE_PING_TTL = 3 * 60 * 1000;

async function pingOneSite(site, timeoutMs = 6000) {
  const t0 = Date.now();
  try {
    const p = CmsEngine.getHome(site);
    const r = await Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
    ]);
    const ms = Date.now() - t0;
    const list = (r && r.list) || [];
    return { ms, ok: list.length > 0, count: list.length };
  } catch (e) {
    return { ms: Date.now() - t0, ok: false, error: e.message };
  }
}

app.get('/api/sites/ping', async (req, res) => {
  const force = String(req.query.force || '') === '1';
  const now = Date.now();
  const out = {};
  const todo = [];

  for (const s of state.sites) {
    if (s.isDexSpider) { out[s.key] = { ok: false, ms: 0, dex: true }; continue; }
    const hit = sitePingCache.get(s.key);
    if (!force && hit && now - hit.ts < SITE_PING_TTL) { out[s.key] = { ms: hit.ms, ok: hit.ok }; continue; }
    todo.push(s);
  }

  // 并发 5，避免一次性打满
  let cursor = 0;
  const workers = new Array(Math.min(5, Math.max(1, todo.length))).fill(0).map(async () => {
    while (cursor < todo.length) {
      const s = todo[cursor++];
      const r = await pingOneSite(s);
      out[s.key] = { ms: r.ms, ok: r.ok };
      sitePingCache.set(s.key, { ...r, ts: Date.now() });
    }
  });
  await Promise.all(workers);

  if (sitePingCache.size > 200) {
    for (const k of [...sitePingCache.keys()].slice(0, 100)) sitePingCache.delete(k);
  }
  res.json({ results: out, ts: Date.now() });
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
  if (!req.query.id) return res.status(400).json({ error: '缺少 id 参数' });
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

// 转封装是 -c copy（不编解码），线程数对 CPU 影响很小；
// 真正省 CPU 的是「限制并发」+「降低进程优先级」。
const REMUX_MAX = Math.max(1, Math.min(6, Number(process.env.REMUX_MAX) || 2));
// 0 = 不传 -threads（跟随 ffmpeg 默认）；设成 1 可再压一点占用
const REMUX_THREADS = Math.max(0, Math.min(16, Number(process.env.REMUX_THREADS) || 0));
// "idle" | "below_normal"（默认）| "normal"
const REMUX_PRIORITY = String(process.env.REMUX_PRIORITY || 'below_normal').toLowerCase();

app.get('/api/remux/status', (req, res) => {
  res.json({
    available: !!findFfmpeg(), ffmpeg: findFfmpeg(),
    active: remuxSessions.size, max: REMUX_MAX,
    threads: REMUX_THREADS || 'auto', priority: REMUX_PRIORITY
  });
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
    ...(REMUX_THREADS > 0 ? ['-threads', String(REMUX_THREADS)] : []),
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

  // 降低 ffmpeg 优先级，避免抢占播放/界面所需的 CPU
  try {
    const prioMap = {
      idle: os.constants.priority.PRIORITY_IDLE,
      below_normal: os.constants.priority.PRIORITY_BELOW_NORMAL,
      normal: os.constants.priority.PRIORITY_NORMAL
    };
    const target = prioMap[REMUX_PRIORITY];
    if (proc.pid && target !== undefined) os.setPriority(proc.pid, target);
  } catch (e) {}
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
async function probePlaylist(url, depth = 0) {
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

    // 主播放列表（master playlist）：没有 #EXTINF，需要下钻到具体码率的子列表
    if (depth < 3 && /#EXT-X-STREAM-INF/i.test(t) && !/#EXTINF/i.test(t)) {
      const lines = t.split(/\r?\n/);
      let variant = '';
      for (let i = 0; i < lines.length; i++) {
        if (!/^#EXT-X-STREAM-INF/i.test(lines[i])) continue;
        for (let j = i + 1; j < lines.length; j++) {
          const l = lines[j].trim();
          if (!l || l.startsWith('#')) continue;
          variant = l;
          break;
        }
        if (variant) break;
      }
      if (variant) {
        let abs;
        try { abs = new URL(variant, url).href; } catch (e) { abs = ''; }
        if (abs) {
          const sub = await probePlaylist(abs, depth + 1);
          if (sub && !sub.error) {
            sub.master = true;
            probeCache.set(url, sub);
            return sub;
          }
        }
      }
    }

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

/* ==================== 播放列表广告过滤 ==================== */
// 常见插播方式：主内容 | DISC | 短广告块(10~60s) | DISC | 主内容。
// 这里在开播前把「被一对 discontinuity 夹住的短块」整块剔除，
// 播放器拿到的就是干净流，不会中途被打断。

function splitByDiscontinuity(text) {
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let cur = [];
  for (const ln of lines) {
    if (/^#EXT-X-DISCONTINUITY\b/i.test(ln.trim())) {
      chunks.push(cur);
      cur = [];
    } else {
      cur.push(ln);
    }
  }
  chunks.push(cur);
  return chunks;
}

function chunkInfo(lines) {
  let dur = 0, segs = 0;
  for (const ln of lines) {
    const s = ln.trim();
    if (s.startsWith('#EXTINF')) {
      dur += parseFloat(s.split(':')[1]) || 0;
      segs++;
    }
  }
  return { dur, segs };
}


/* ---------- 广告区间分析（只算位置，不改播放列表） ----------
   开播前算出「哪一段是广告」，播放器播到该区间时跳过。
   不删任何分片，因此时间轴、密钥、相对路径都不受影响。 */
function analyzeAdRanges(text) {
  const chunks = splitByDiscontinuity(text);
  if (chunks.length < 3) return { ranges: [], totalChunks: chunks.length, duration: 0 };

  const infos = chunks.map(chunkInfo);
  const totalDur = infos.reduce((a, b) => a + b.dur, 0);

  let acc = 0;
  const starts = infos.map(info => { const s = acc; acc += info.dur; return s; });

  const picked = [];
  for (let i = 1; i < chunks.length - 1; i++) {
    const { dur, segs } = infos[i];
    if (!(segs >= 1 && segs <= 30 && dur >= 5 && dur <= 90)) continue;
    if (picked.some(p => p.idx === i - 1)) continue;            // 不与上一段相连
    const need = Math.max(180, dur * 3);
    const left = infos[i - 1], right = infos[i + 1];
    if (!(left.segs > 0 && left.dur >= need)) continue;          // 两侧都应是长正片
    if (!(right.segs > 0 && right.dur >= need)) continue;
    picked.push({ idx: i, start: starts[i], end: starts[i] + dur, dur });
  }

  const adDur = picked.reduce((a, b) => a + b.dur, 0);
  if (picked.length > 6 || adDur > totalDur * 0.05) {
    // 命中过多 → 更像是「整集被切片」而不是广告，宁可不跳
    return { ranges: [], totalChunks: chunks.length, duration: Math.round(totalDur), rejected: true };
  }

  return {
    ranges: picked.map(p => [Math.round(p.start * 100) / 100, Math.round(p.end * 100) / 100]),
    totalChunks: chunks.length,
    duration: Math.round(totalDur)
  };
}

// 解析 master 播放列表 → 取第一个变体（与 /api/probe 的逻辑保持一致）
async function fetchPlaylistMaybeMaster(url) {
  const r = await axios.get(url, { timeout: 15000, responseType: 'text', headers: { 'User-Agent': DESKTOP_UA } });
  const text = String(r.data || '');
  if (/#EXT-X-STREAM-INF/i.test(text) && !/#EXTINF/i.test(text)) {
    const lines = text.split(/\r?\n/);
    let variant = '';
    for (let i = 0; i < lines.length; i++) {
      if (!/^#EXT-X-STREAM-INF/i.test(lines[i])) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (!l || l.startsWith('#')) continue;
        variant = l; break;
      }
      if (variant) break;
    }
    if (variant) {
      let abs = '';
      try { abs = new URL(variant, url).href; } catch (e) {}
      if (abs) {
        const r2 = await axios.get(abs, { timeout: 15000, responseType: 'text', headers: { 'User-Agent': DESKTOP_UA } });
        return { text: String(r2.data || ''), finalUrl: abs };
      }
    }
  }
  return { text, finalUrl: url };
}

const adRangesCache = new Map();

app.get('/api/ads', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: '缺少 url 参数' });
  const hit = adRangesCache.get(url);
  if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return res.json(hit);
  try {
    const { text, finalUrl } = await fetchPlaylistMaybeMaster(url);
    const r = analyzeAdRanges(text);
    const out = { ...r, finalUrl, ts: Date.now() };
    adRangesCache.set(url, out);
    if (adRangesCache.size > 120) adRangesCache.delete(adRangesCache.keys().next().value);
    if (r.ranges.length) {
      console.log(`[广告] 标记 ${r.ranges.length} 段: ${r.ranges.map(x => Math.round(x[0]) + 's-' + Math.round(x[1]) + 's').join(', ')}`);
    }
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
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

/* ==================== 运行日志（排查闪退用） ==================== */
const LOG_FILE = path.join(__dirname, 'data', 'app.log');

function appendLog(line) {
  try {
    fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
    // 超过 512KB 就轮转，避免无限增长
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > 512 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    } catch (e) {}
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch (e) {}
}

app.post('/api/log', express.json(), (req, res) => {
  const msg = String((req.body && req.body.msg) || '').slice(0, 2000);
  const src = String((req.body && req.body.src) || 'renderer').slice(0, 40);
  if (msg) appendLog(`[${src}] ${msg}`);
  res.json({ ok: true });
});

app.get('/api/log', (req, res) => {
  try {
    const txt = fs.readFileSync(LOG_FILE, 'utf8');
    res.type('text/plain').send(txt.split('\n').slice(-200).join('\n'));
  } catch (e) {
    res.type('text/plain').send('(还没有日志)');
  }
});

// 主进程级异常也记下来
process.on('uncaughtException', (e) => {
  appendLog(`[main] uncaughtException: ${e && e.stack ? e.stack : e}`);
});
process.on('unhandledRejection', (e) => {
  appendLog(`[main] unhandledRejection: ${e && e.stack ? e.stack : e}`);
});

/* ==================== 片头 / 片尾标记（按片名） ==================== */

app.get('/api/marks', (req, res) => {
  const name = String(req.query.name || '').trim();
  if (name) {
    const row = ShowMarkRepo.get(name);
    return res.json({ mark: row ? { intro: row.intro, outro: row.outro, name: row.show_name } : null });
  }
  res.json({ list: ShowMarkRepo.list() });
});

app.put('/api/marks', express.json(), (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: '缺少片名' });
  const intro = Math.max(0, Math.min(900, Number(req.body.intro) || 0));
  const outro = Math.max(0, Math.min(900, Number(req.body.outro) || 0));
  const row = ShowMarkRepo.save(name, intro, outro);
  res.json({ ok: true, mark: { intro: row.intro, outro: row.outro } });
});

app.delete('/api/marks', (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.status(400).json({ error: '缺少片名' });
  ShowMarkRepo.remove(name);
  res.json({ ok: true });
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

  console.log('监听地址: 127.0.0.1（仅本机可访问）');


  // 启动时自动恢复上次使用的配置源
  const saved = ConfigRepo.list();
  if (saved.length > 0) {
    try {
      await applyConfig(saved[0]);
      // 只打印名称或主机名：不要把完整的配置源地址写进控制台/日志
      let shown = saved[0].name;
      if (!shown) { try { shown = new URL(saved[0].url).hostname; } catch (e) { shown = '(本地文件)'; } }
      console.log(`已恢复配置源: ${shown}（${state.sites.length} 个站点）`);
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

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const ConfigParser = require('./configParser');
const CmsEngine = require('./cmsEngine');
const SpiderEngine = require('./spiderEngine');
const Updater = require('./updater');
const JvmBridge = require('./jvmBridge');
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

// 虫包（TVBox spider）常给播放地址附带 Referer/Origin，否则 CDN 直接 403。
// 前端把这些头以 ?headers=<JSON> 传进来，这里统一清洗后合并到请求里。
// 只允许业务头，禁止 Host / Content-Length 之类的传输层头，长度也设上限。
const HEADER_ALLOW = ['referer', 'origin', 'user-agent', 'cookie', 'accept', 'accept-language', 'authorization', 'x-requested-with'];
function parseHeaderParam(raw) {
  if (!raw) return {};
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const key = String(k).toLowerCase();
      if (!HEADER_ALLOW.includes(key)) continue;
      const val = String(v == null ? '' : v).replace(/[\r\n]/g, ' ').slice(0, 2048);
      if (val) out[k] = val;
    }
    return out;
  } catch (e) { return {}; }
}
function requestHeaders(extra) {
  return Object.assign({ 'User-Agent': DESKTOP_UA }, parseHeaderParam(extra));
}

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
  if (typeof remuxSessions !== 'undefined' && remuxSessions && remuxSessions.size > 0) {
    for (const p of remuxSessions) {
      try { p.kill('SIGKILL'); } catch (e) {}
    }
    remuxSessions.clear();
  }
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
// 安全响应头（CSP / Trusted Types）：必须在静态资源之前注册，否则 index.html 不带这些头
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "require-trusted-types-for 'script'; trusted-types kimbox-html default;");
  // 资源白名单先 Report-Only：不拦截，违规经 securitypolicyviolation 写进 data/app.log 观察
  res.setHeader('Content-Security-Policy-Report-Only',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob: https: http:; media-src 'self' data: blob: https: http:; connect-src 'self' https: http: ws: wss:; " +
    "worker-src 'self' blob:; font-src 'self' data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';");
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const CONFIG_CACHE_DIR = path.join(__dirname, 'data', 'cache');
if (!fs.existsSync(CONFIG_CACHE_DIR)) {
  try { fs.mkdirSync(CONFIG_CACHE_DIR, { recursive: true }); } catch (e) {}
}

function saveConfigCache(id, parsed) {
  try {
    const file = path.join(CONFIG_CACHE_DIR, `config_${id}.json`);
    fs.writeFileSync(file, JSON.stringify(parsed), 'utf8');
  } catch (e) {}
}

function loadConfigCache(id) {
  try {
    const file = path.join(CONFIG_CACHE_DIR, `config_${id}.json`);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {}
  return null;
}

function removeConfigCache(id) {
  try {
    const file = path.join(CONFIG_CACHE_DIR, `config_${id}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {}
}

function clearAllConfigCache() {
  try {
    const files = fs.readdirSync(CONFIG_CACHE_DIR);
    for (const f of files) fs.unlinkSync(path.join(CONFIG_CACHE_DIR, f));
  } catch (e) {}
}

// 当前运行状态
const state = {
  configId: null,
  url: '',
  sites: [],
  spider: '',          // 根配置里的 spider jar 规格（url;md5;hash），虫包站点加载时要用
  activeSite: null,
  loading: false,
  loadError: null,
  sitesVersion: Date.now()
};

/** 选中一个「能立刻用」的站点：优先非虫包（虫包首次加载要十几秒，不该卡住首页） */
function pickDefaultSite(list, preferredKey) {
  const preferred = preferredKey ? list.find(s => s.key === preferredKey) : null;
  return preferred || list.find(s => !s.isDexSpider) || list[0] || null;
}

/** 统一搜索入口：虫包走 JVM 桥，普通 CMS 走 CmsEngine */
async function searchSite(site, wd, page) {
  if (site && site.isDexSpider) return SpiderEngine.search(site, wd, page, state.spider);
  return CmsEngine.search(site, wd, page);
}

/** 配置里有虫包站点时，提前把 JVM 服务拉起来（只起进程，不加载站点，约 1 秒） */
function warmJvmIfNeeded() {
  if (!state.sites.some(s => s.isDexSpider)) return;
  if (!JvmBridge.installed()) return;
  setImmediate(() => {
    JvmBridge.ensureStarted()
      .then(() => preloadSpiderSites())
      .catch(e => JvmBridge.log('[warm] ' + e.message));
  });
}

/* ---------- 虫包站点启动预加载 ----------
   加固站首次要「下载 jar → 解壳 → dex2jar → 实例化」，单站 10~20 秒。
   空闲时后台按 2 并发把这些站点都 load 一遍，用户点开时直接命中缓存；
   同一份 jar 只会解一次，后面的站点主要是类加载，几百毫秒级。 */
const preloadState = { total: 0, done: 0, ok: 0, failed: 0, running: false, startedAt: 0, fingerprint: '' };

function preloadSpiderSites() {
  if (!JvmBridge.installed()) return;
  const list = state.sites.filter(s => s.isDexSpider && s.searchable !== 0);
  if (!list.length) return;
  const fingerprint = list.map(s => s.key).join('|') + '#' + state.spider;
  if (preloadState.running || preloadState.fingerprint === fingerprint) return;

  Object.assign(preloadState, { total: list.length, done: 0, ok: 0, failed: 0, running: true, startedAt: Date.now(), fingerprint });
  JvmBridge.log(`[preload] 开始预加载 ${list.length} 个虫包站点`);
  (async () => {
    const queue = list.slice();
    const worker = async () => {
      while (queue.length) {
        const s = queue.shift();
        try {
          const ok = await JvmBridge.loadSite({ siteKey: s.key, api: s.api, ext: s.ext || '', jar: state.spider, timeoutMs: 240000 });
          if (ok) preloadState.ok++; else preloadState.failed++;
        } catch (e) {
          preloadState.failed++;
          JvmBridge.log(`[preload] ${s.key} 失败: ${e.message}`);
        }
        preloadState.done++;
      }
    };
    await Promise.all([worker(), worker()]);
    preloadState.running = false;
    JvmBridge.log(`[preload] 完成：成功 ${preloadState.ok}，失败 ${preloadState.failed}，耗时 ${Date.now() - preloadState.startedAt}ms`);
  })().catch(e => { preloadState.running = false; JvmBridge.log('[preload] 异常: ' + e.message); });
}

function publicSite(s) {
  return {
    key: s.key,
    name: s.name,
    type: s.type,
    isDexSpider: !!s.isDexSpider,
    spider: !!s.isDexSpider
  };
}

async function applyConfig(row) {
  state.configId = row.id;
  state.url = row.url;
  state.loading = true;
  state.loadError = null;
  state.sitesVersion = Date.now();
  // 换配置源：释放旧配置的 spider / 类加载器 / 解壳子进程（失败静默，最坏只是多占内存）
  if (state.spider) JvmBridge.resetAll().catch(() => {});

  // 1. 本地缓存秒开：优先恢复上次解析成功的站点，0ms 即可响应前端，杜绝启动竞态
  const cached = loadConfigCache(row.id);
  if (cached && Array.isArray(cached.sites) && cached.sites.length > 0) {
    state.sites = cached.sites;
    state.spider = cached.spider || state.spider;
    state.activeSite = pickDefaultSite(state.sites, row.default_site);
    state.loading = false;
    warmJvmIfNeeded();
  }

  // 2. 异步拉取/刷新远程配置
  const fetchRemote = async () => {
    try {
      const parsed = await ConfigParser.load(row.url);
      if (parsed && Array.isArray(parsed.sites) && parsed.sites.length > 0) {
        const oldFingerprint = (state.sites || []).map(s => `${s.key}:${s.api || ''}:${s.name || ''}`).join('|');
        const newFingerprint = parsed.sites.map(s => `${s.key}:${s.api || ''}:${s.name || ''}`).join('|');
        const hasChanged = oldFingerprint !== newFingerprint;

        state.sites = parsed.sites;
        state.spider = parsed.spider || '';
        const currentKey = state.activeSite ? state.activeSite.key : null;
        const stillActive = currentKey ? state.sites.find(s => s.key === currentKey) : null;
        state.activeSite = stillActive || pickDefaultSite(state.sites, row.default_site);
        saveConfigCache(row.id, parsed);
        warmJvmIfNeeded();
        state.loadError = null;

        if (hasChanged) {
          state.sitesVersion = Date.now();
          console.log(`[config] 远程配置检测到更新（共 ${parsed.sites.length} 站），已刷新本地快照并更新版本号`);
        }
      }
    } catch (e) {
      state.loadError = e.message;
      if (!state.sites || state.sites.length === 0) {
        console.error(`[config] 配置源 ${row.name || row.url} 加载失败:`, e.message);
        throw e;
      } else {
        console.log(`[config] 远程拉取失败 (${e.message})，继续沿用本地缓存 (${state.sites.length} 站)`);
      }
    } finally {
      state.loading = false;
      ConfigRepo.touch(row.id);
    }
  };

  if (!cached || !cached.sites || cached.sites.length === 0) {
    await fetchRemote();
  } else {
    // 已有缓存：后台异步更新，绝不阻塞启动响应
    fetchRemote().catch(() => {});
  }

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
    liveSiteCount: live,
    loading: !!state.loading,
    loadError: state.loadError || null
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
    saveConfigCache(row.id, parsed);
    await applyConfig(row);
    res.json({
      success: true,
      configs: ConfigRepo.list(),
      current: { id: row.id, url: row.url },
      siteCount: state.sites.length,
      sites: state.sites.map(publicSite),
      activeSite: state.activeSite ? state.activeSite.key : null,
      version: state.sitesVersion || 0
    });
  } catch (e) {
    res.status(500).json({ error: '配置加载失败: ' + e.message });
  }
});

app.delete('/api/configs/:id', async (req, res) => {
  const id = Number(req.params.id);
  removeConfigCache(id);
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
      activeSite: state.activeSite ? state.activeSite.key : null,
      version: state.sitesVersion || 0
    });
  } catch (e) {
    res.status(500).json({ error: '配置加载失败: ' + e.message });
  }
});

// 手动强制同步指定配置源（绕过本地缓存直接拉取远程，并更新本地快照）
app.post('/api/configs/:id/sync', async (req, res) => {
  const id = Number(req.params.id);
  const row = ConfigRepo.get(id);
  if (!row) return res.status(404).json({ error: '配置不存在' });

  try {
    const cached = loadConfigCache(row.id);
    const oldSites = (state.configId === id && state.sites && state.sites.length > 0)
      ? state.sites
      : ((cached && cached.sites) || []);
    const oldFingerprint = oldSites.map(s => `${s.key}:${s.api || ''}:${s.name || ''}`).join('|');

    const parsed = await ConfigParser.load(row.url);
    if (!parsed || !Array.isArray(parsed.sites) || parsed.sites.length === 0) {
      return res.status(400).json({ error: '远程配置未解析到任何有效站点' });
    }

    const newFingerprint = parsed.sites.map(s => `${s.key}:${s.api || ''}:${s.name || ''}`).join('|');
    const hasChanged = oldFingerprint !== newFingerprint;
    const oldCount = oldSites.length;
    const newCount = parsed.sites.length;
    const diffCount = newCount - oldCount;

    saveConfigCache(row.id, parsed);
    ConfigRepo.touch(row.id);

    const isCurrent = (state.configId === id);
    if (isCurrent && hasChanged) {
      state.sites = parsed.sites;
      state.spider = parsed.spider || '';
      const currentKey = state.activeSite ? state.activeSite.key : null;
      const stillActive = currentKey ? state.sites.find(s => s.key === currentKey) : null;
      state.activeSite = stillActive || pickDefaultSite(state.sites, row.default_site);
      state.loadError = null;
      state.sitesVersion = Date.now();
    }

    res.json({
      success: true,
      isCurrent,
      hasChanged,
      oldCount,
      newCount,
      diffCount,
      siteCount: newCount,
      sites: isCurrent ? state.sites.map(publicSite) : parsed.sites.map(publicSite),
      activeSite: isCurrent && state.activeSite ? state.activeSite.key : null,
      version: state.sitesVersion || 0
    });
  } catch (e) {
    res.status(500).json({ error: '同步失败: ' + e.message });
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
    saveConfigCache(row.id, parsed);
    await applyConfig(row);
    res.json({
      success: true,
      siteCount: state.sites.length,
      sites: state.sites.map(publicSite),
      activeSite: state.activeSite ? state.activeSite.key : null,
      version: state.sitesVersion || 0
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
    defaultSite: row ? row.default_site : '',
    configId: state.configId,
    loading: !!state.loading,
    error: state.loadError || null,
    version: state.sitesVersion || 0
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
    if (s.isDexSpider) {
      // 虫包站点不在 ping 里真的加载（首站要十几秒），只回报 JVM 是否就绪
      const js = JvmBridge.status();
      out[s.key] = { ok: js.installed && js.enabled, ms: 0, dex: true, jvm: js.running };
      continue;
    }
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
    res.json(state.activeSite.isDexSpider
      ? await SpiderEngine.home(state.activeSite, state.spider)
      : await CmsEngine.getHome(state.activeSite));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/category', async (req, res) => {
  if (!requireSite(res)) return;
  try {
    res.json(state.activeSite.isDexSpider
      ? await SpiderEngine.category(state.activeSite, req.query.tid || '', req.query.pg || 1, req.query.extend || '', state.spider)
      : await CmsEngine.getCategory(state.activeSite, req.query.tid || '', req.query.pg || 1));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/detail', async (req, res) => {
  if (!req.query.id) return res.status(400).json({ error: '缺少 id 参数' });
  if (!requireSite(res)) return;
  try {
    // 按请求里的站点查详情（换成另一站点的同片源时会带 siteKey），
    // **但不改全局 state.activeSite**：以前这里会顺手切站点，导致「播放时换源 → 回首页」
    // 后首页仍用旧站点的分类 tid 去查新站点，分类列表现为「共 0 部」、标签与内容错位。
    // 当前站点只由 /api/site/select 显式修改。
    const siteKey = req.query.siteKey || state.activeSite.key;
    const target = state.sites.find(s => s.key === siteKey);
    if (!target) return res.status(404).json({ error: '该影片所属站点不存在: ' + siteKey });

    const nameHint = String(req.query.name || '').trim();
    let detail = null;
    if (target.isDexSpider) {
      // 虫包：搜索 id 与详情 id 可能不是同一套命名空间（实测 AppV7 系：搜索能出结果，
      // 但详情报 video_detail decrypt empty；用分类里的 id 却正常）。
      // 详情失败时按片名回退到本站分类里找一遍，找到就用分类的 id 重新取。
      try { detail = await SpiderEngine.getDetail(target, req.query.id, state.spider); } catch (e) { detail = null; }
      if (!detail && nameHint) {
        try { detail = await SpiderEngine.resolveByTitle(target, nameHint, state.spider); } catch (e) {}
      }
    } else {
      detail = await CmsEngine.getDetail(target, req.query.id);
    }
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
    res.json(await searchSite(state.activeSite, req.query.wd, req.query.pg || 1));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ==================== JVM 站源（虫包）状态 ==================== */

app.get('/api/jvm/status', (req, res) => {
  res.json(Object.assign(JvmBridge.status(), {
    spiderSites: state.sites.filter(s => s.isDexSpider).length,
    preload: Object.assign({}, preloadState, { fingerprint: undefined })
  }));
});

app.post('/api/jvm/restart', async (req, res) => {
  try {
    JvmBridge.stop();
    await new Promise(r => setTimeout(r, 500));
    await JvmBridge.ensureStarted();
    res.json({ ok: true, status: JvmBridge.status() });
  } catch (e) {
    res.status(500).json({ error: e.message, status: JvmBridge.status() });
  }
});

/** 虫包站点起播：把 (flag, id) 换成真正的媒体地址 */
app.get('/api/spider/play', async (req, res) => {
  const siteKey = String(req.query.siteKey || '');
  const flag = String(req.query.flag || '');
  const id = String(req.query.id || '');
  if (!id) return res.status(400).json({ error: '缺少 id' });
  const site = state.sites.find(s => s.key === siteKey);
  if (!site) return res.status(404).json({ error: '站点不存在: ' + siteKey });
  if (!site.isDexSpider) return res.status(400).json({ error: '该站点不是虫包站源' });
  try {
    const r = await SpiderEngine.play(site, flag, id, state.spider);
    if (!r || !r.url) return res.status(502).json({ error: '站源未返回播放地址' });
    res.json(r);
  } catch (e) {
    res.status(502).json({ error: e.message, stage: e.stage || '' });
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

function cleanTitle(s) {
  return String(s || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .trim();
}

const normName = (s) => String(s || '')
  .replace(/[\u200B-\u200D\uFEFF]/g, '')
  .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
  .replace(/[\s·・,，.。:：!！?？'"“”()（）\[\]【】\-_]/g, '')
  .toLowerCase();

app.get('/api/search/all', async (req, res) => {
  const wd = String(req.query.wd || '').trim();
  if (!wd) return res.json({ list: [], status: [] });

  const sites = state.sites.filter(s => !s.isDexSpider && s.searchable !== 0);
  const spiderSites = JvmBridge.installed() ? state.sites.filter(s => s.isDexSpider && s.searchable !== 0) : [];
  if (sites.length === 0 && spiderSites.length === 0) return res.json({ list: [], status: [] });

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

  // 虫包站点单独跑：dex2jar/解壳吃 CPU，并发压到 2，且冷启动要 10~20 秒
  let spiderCursor = 0;
  async function spiderWorker() {
    while (spiderCursor < spiderSites.length) {
      const site = spiderSites[spiderCursor++];
      const t0 = Date.now();
      try {
        const r = await withTimeout(searchSite(site, wd, 1), 45000);
        const list = (r.list || []).map(v => ({ ...v, siteKey: site.key, siteName: site.name }));
        collected.push(...list);
        status.push({ key: site.key, name: site.name, count: list.length, ms: Date.now() - t0, spider: true });
      } catch (e) {
        status.push({ key: site.key, name: site.name, count: 0, error: true, ms: Date.now() - t0, spider: true, detail: e.message });
      }
    }
  }

  const jobs = [Promise.all(Array.from({ length: Math.min(CONCURRENCY, sites.length) }, worker))];
  if (spiderSites.length) {
    jobs.push(Promise.all(Array.from({ length: Math.min(2, spiderSites.length) }, spiderWorker)));
  }
  await Promise.all(jobs);

  // 同名影片合并：保留第一个，记录来源数量（清洗不可见零宽字符与标点，精准聚合）
  const merged = new Map();
  for (const v of collected) {
    const key = normName(v.vod_name);
    if (!key) continue;
    if (!merged.has(key)) {
      merged.set(key, { ...v, vod_name: cleanTitle(v.vod_name), sources: 1 });
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
  if (proc.stderr) proc.stderr.resume(); // 丢弃并排空 stderr，防止 64KB 管道阻塞死锁

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
async function probePlaylist(url, headers, depth = 0) {
  if (!/\.m3u8/i.test(url)) return null;
  if (probeCache.has(url)) return probeCache.get(url);
  let res;
  try {
    const r = await axios.get(url, {
      timeout: 12000,
      responseType: 'text',
      headers: requestHeaders(headers)
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
          const sub = await probePlaylist(abs, headers, depth + 1);
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

  res.json(await probePlaylist(url, parseHeaderParam(req.query.headers)) || {});
});

/* ==================== 播放列表广告过滤 ==================== */
// 常见插播方式：主内容 | DISC | 短广告块(10~60s) | DISC | 主内容。
// 这里在开播前把「被一对 discontinuity 夹住的短块」整块剔除，
// 播放器拿到的就是干净流，不会中途被打断。

/** 把列表里的分片与密钥 URI 改写成 /api/seg 代理（只在需要附加头时启用） */
function proxyUris(text, headers) {
  const enc = (u) => '/api/seg?u=' + encodeURIComponent(u) + (Object.keys(headers).length ? '&h=' + encodeURIComponent(JSON.stringify(headers)) : '');
  return text.split(/\r?\n/).map(line => {
    const s = line.trim();
    if (!s) return line;
    if (s.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (m, u) => 'URI="' + enc(u) + '"');
    }
    return /^https?:\/\//i.test(s) ? enc(s) : line;
  }).join('\n');
}

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
  const infos = chunks.map(chunkInfo);
  const totalDur = infos.reduce((a, b) => a + b.dur, 0);
  const chunkListOf = (adSet) => infos.map((x, i) => ({
    d: Math.round(x.dur * 100) / 100,
    n: x.segs,
    ad: adSet && adSet.has(i) ? 1 : 0
  }));

  // 分块不足 3 块（干净流 / 只有一个断点）不可能有「夹在正片中间」的插播，
  // 但**片长必须照常返回**——以前这里直接给 duration:0，导致这类源在面板/剪辑里片长都是 0。
  if (chunks.length < 3) {
    return {
      ranges: [],
      chunks: chunkListOf(null),
      edgeAds: 0,
      totalChunks: chunks.length,
      duration: Math.round(totalDur),
      mainDuration: Math.round(totalDur)
    };
  }

  const picked = [];
  for (let i = 1; i < chunks.length - 1; i++) {
    const { dur, segs } = infos[i];
    if (!(segs >= 1 && segs <= 30 && dur >= 5 && dur <= 90)) continue;
    if (picked.some(p => p.idx === i - 1)) continue;            // 不与上一段相连
    const need = Math.max(180, dur * 3);
    const left = infos[i - 1], right = infos[i + 1];
    if (!(left.segs > 0 && left.dur >= need)) continue;          // 两侧都应是长正片
    if (!(right.segs > 0 && right.dur >= need)) continue;
    picked.push({ idx: i, dur, segs });
  }

  const adDur = picked.reduce((a, b) => a + b.dur, 0);
  if (picked.length > 6 || adDur > totalDur * 0.05) {
    // 命中过多 → 更像是「整集被切片」而不是广告，宁可不跳
    return { ranges: [], totalChunks: chunks.length, duration: Math.round(totalDur), rejected: true };
  }

  const adIndices = new Set(picked.map(p => p.idx));

  // 正片分片在源视频中是连续编码的（PTS 从 0 连续递增，不含插播广告时长）。
  // 因此广告在播放器时间轴上的实际插入点 = 该广告前面所有正片块的时长总和。
  //
  // ⚠️ 目标点（数组第 3 项）必须落在广告块 **之后**，也就是 end 再往后一点点：
  //   - 广告块在时间轴上占满 [start, start+dur]，end 即「下一段正片第一帧」；
  //   - 若把目标点算成 start + 0.8（老写法），seek 回来位置仍在 [start, end) 内，
  //     下一次轮询又满足跳过条件 → 反复 seek 同一处，界面无限弹「已跳过广告」。
  //   - 目标点也不能越过片尾，前端会按实际 duration 再兜底一次。
  let dramaAcc = 0;
  const chunkPtsStarts = [];
  for (let i = 0; i < chunks.length; i++) {
    chunkPtsStarts[i] = dramaAcc;
    if (!adIndices.has(i)) {
      dramaAcc += infos[i].dur;
    }
  }

  const ranges = picked.map(p => {
    const start = chunkPtsStarts[p.idx];
    const end = start + p.dur;
    const target = end + 0.4;
    return [Math.round(start * 100) / 100, Math.round(end * 100) / 100, Math.round(target * 100) / 100];
  });

  // 片头 / 片尾广告：中间的插播块扫不到它们，但同一批广告素材的分片数与时长特征一致
  // （实测「神马云」「猫眼」「魔都」「ikun」的片尾块与中间广告块完全相同：6 个分片 / 17.64 秒）。
  // 只在**特征与已识别的插播广告完全一致**时才认定，避免把片尾字幕、下集预告当成广告切掉。
  const sig = (x) => `${x.segs}:${Math.round(x.dur)}`;
  const adSigs = new Set(picked.map(p => sig(infos[p.idx])));
  const isAdShape = (x) => x.segs >= 1 && x.segs <= 30 && x.dur >= 5 && x.dur <= 90;
  const edgeRanges = [];
  const adIdxAll = new Set(adIndices);   // 调试面板要用：把所有广告块（含首尾）标出来

  if (chunks.length >= 2 && adSigs.size > 0) {
    // 片头广告：第 0 块是短块，且紧随其后是长正片
    if (isAdShape(infos[0]) && adSigs.has(sig(infos[0])) && infos[1].dur >= Math.max(180, infos[0].dur * 3)) {
      edgeRanges.push([0, Math.round(infos[0].dur * 100) / 100, Math.round((infos[0].dur + 0.4) * 100) / 100]);
      adIdxAll.add(0);
    }
    // 片尾广告：最后一块是短块，且之前是长正片
    const lastIdx = chunks.length - 1;
    if (isAdShape(infos[lastIdx]) && adSigs.has(sig(infos[lastIdx]))
        && infos[lastIdx - 1].dur >= Math.max(180, infos[lastIdx].dur * 3)) {
      const start = chunkPtsStarts[lastIdx];
      // 第 4 项 = 1：标记「片尾广告」。它的目标点不能按时长累加算——
      // 片尾广告之后没有正片，且此处显示时间轴与原始 PTS 已经错位（实测差 39 秒），
      // 前端收到这个标记后直接 seek 到 duration - 0.5，让播完自动下一集接管。
      edgeRanges.push([
        Math.round(start * 100) / 100,
        Math.round((start + infos[lastIdx].dur) * 100) / 100,
        Math.round((start + infos[lastIdx].dur + 0.4) * 100) / 100,
        1
      ]);
      adIdxAll.add(lastIdx);
    }
  }

  const allRanges = ranges.concat(edgeRanges).sort((a, b) => a[0] - b[0]);

  // 供调试面板展示：每块的时长 / 分片数 / 是否判定为广告
  const chunkList = infos.map((x, i) => ({
    d: Math.round(x.dur * 100) / 100,
    n: x.segs,
    ad: adIdxAll.has(i) ? 1 : 0
  }));

  return {
    ranges: allRanges,
    chunks: chunkList,
    edgeAds: edgeRanges.length,
    totalChunks: chunks.length,
    duration: Math.round(totalDur),
    mainDuration: Math.round(dramaAcc)
  };
}

// 解析 master 播放列表 → 取第一个变体（与 /api/probe 的逻辑保持一致）
// finalUrl 优先取 axios 跟随 302 之后的真实地址，分片相对路径要基于它解析。
function axiosFinalUrl(r, fallback) {
  try {
    const u = r && r.request && r.request.res && r.request.res.responseUrl;
    if (u) return u;
  } catch (e) {}
  return fallback;
}

async function fetchPlaylistMaybeMaster(url, headers) {
  const fetchText = async (u) => {
    // 虫包给的地址常要求 Referer/Origin（瓜子缺 Referer 会被 302 到一个 20 秒广告占位列表），
    // 所以这里必须带上调用方传进来的头，而不是只给桌面 UA。
    const r = await axios.get(u, { timeout: 15000, responseType: 'text', headers: requestHeaders(headers) });
    return { text: String(r.data || ''), finalUrl: axiosFinalUrl(r, u) };
  };

  let cur = url;
  for (let depth = 0; depth < 3; depth++) {
    let got = await fetchText(cur);
    // 偶发：CDN 忙的时候会返回空壳/错误页（实测同一地址前两次拿到 0 个分片，第三次正常）。
    // 这里对「既没有分片也没有变体」的响应重试一次，避免误判成「源不可用」。
    if (!/#EXTINF/i.test(got.text) && !/#EXT-X-STREAM-INF/i.test(got.text)) {
      await new Promise(r => setTimeout(r, 500));
      try { got = await fetchText(cur); } catch (e) {}
    }
    const { text, finalUrl } = got;

    // 主播放列表：往下钻一层（有的源变体地址本身又是 master，最多钻 3 层）
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
      if (!variant) return { text, finalUrl };
      try { cur = new URL(variant, finalUrl).href; } catch (e) { return { text, finalUrl }; }
      continue;
    }
    return { text, finalUrl };
  }

  // 钻到底仍未拿到媒体列表：返回最后一次内容，由调用方判断
  const last = await fetchText(cur);
  return last;
}

const adRangesCache = new Map();

app.get('/api/ads', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: '缺少 url 参数' });
  const hit = adRangesCache.get(url);
  if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return res.json(hit);
  try {
    const { text, finalUrl } = await fetchPlaylistMaybeMaster(url, parseHeaderParam(req.query.headers));
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



/* ==================== 播放列表代理（分析与播放共用同一份 m3u8） ==================== */
// 背景：部分 CDN 每次请求都返回不同的插播广告（实测同一地址连拉 4 次得到 4 组时长序列），
// 而「先 /api/ads 分析、再由 mpv 直接拉 CDN」是两次独立请求，区间必然对不上。
// 这里由本地服务拉一次、把分片/密钥地址改写成绝对地址后缓存，把同一份文本
// 既用于 /api/ads 同样的区间计算，又通过本地 URL 交给播放器 —— 轮播就失效了。

const hlsCache = new Map();          // token -> { text, ts, url }
// mpv 拖动进度时可能重新读取播放列表，缓存要活得比一集更长；按条数上限淘汰即可
const HLS_TTL = 6 * 60 * 60 * 1000;  // 6 小时
const HLS_MAX = 200;

/** 把播放列表里的相对地址改成绝对地址（分片行 + 各种 URI="..." 标签） */
function absolutizePlaylist(text, baseUrl) {
  const toAbs = (u) => {
    if (!u) return u;
    if (/^(https?:)?\/\//i.test(u) || /^data:/i.test(u)) return u;
    try { return new URL(u, baseUrl).href; } catch (e) { return u; }
  };
  return String(text).split(/\r?\n/).map((line) => {
    const s = line.trim();
    if (!s) return '';
    if (s.startsWith('#')) {
      // #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA / #EXT-X-I-FRAME-STREAM-INF 里的 URI
      return line.replace(/URI="([^"]*)"/g, (m, u) => `URI="${toAbs(u)}"`);
    }
    return toAbs(s);
  }).join('\n');
}

function pruneHlsCache() {
  const now = Date.now();
  for (const [k, v] of hlsCache) {
    if (now - v.ts > HLS_TTL) hlsCache.delete(k);
  }
  while (hlsCache.size > HLS_MAX) hlsCache.delete(hlsCache.keys().next().value);
}

/**
 * 「剪辑」模式：把判定为广告的块从播放列表里整块删掉，重新生成一份干净列表。
 * 拼接处保留一个 #EXT-X-DISCONTINUITY，让播放器重置时间轴（实测 mpv 与 hls.js 都能无缝接）。
 * 返回被删掉的区间（**原时间轴**）与总秒数，供前端展示。
 *
 * ⚠️ 分块必须与 analyzeAdRanges() 里的 splitByDiscontinuity() 完全一致（连表头所在的行也算进第 0 块），
 * 否则 analysis.chunks 的 ad 标记会整体错位——曾因此把两块正片当广告删掉（片长从 46 分钟变 9 分钟）。
 */
function buildCutPlaylist(text, analysis) {
  const lines = String(text).split(/\r?\n/);

  // 与 analyzeAdRanges 相同的切块方式：只在 #EXT-X-DISCONTINUITY 处断开，表头留在第 0 块里
  const blocks = [];
  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^#EXT-X-DISCONTINUITY\b/i.test(lines[i].trim())) {
      blocks.push([startLine, i]);
      startLine = i + 1;
    }
  }
  blocks.push([startLine, lines.length]);

  // 保险：只删「像广告」的块，任何异常（超长块、分片过多）都不删，宁可少删也不误删正片
  const safeToCut = (c) => !!c && c.ad && Number(c.d) >= 5 && Number(c.d) <= 120 && Number(c.n) <= 40;

  // #EXT-X-ENDLIST 通常在最后一块里：如果最后一块正好是片尾广告被删掉，
  // 这个标签也会跟着消失 —— 播放器会当成直播流，从末尾开始播、时长也算错。
  const hadEndList = lines.some(l => /^#EXT-X-ENDLIST/i.test(l.trim()));

  const out = [];
  const cuts = [];
  let acc = 0, removed = 0, kept = 0;

  blocks.forEach(([a, b], idx) => {
    let dur = 0;
    for (let i = a; i < b; i++) {
      const s = lines[i].trim();
      if (s.startsWith('#EXTINF')) dur += parseFloat(s.split(':')[1]) || 0;
    }
    const start = acc;
    acc += dur;

    const chunk = (analysis.chunks || [])[idx];
    if (safeToCut(chunk)) {
      cuts.push([Math.round(start * 100) / 100, Math.round(acc * 100) / 100]);
      removed += dur;
      // 第 0 块要是被整体删掉，它的表头（#EXTM3U / 版本 / TARGETDURATION 等）仍要保留
      if (idx === 0) {
        const hdr = [];
        for (let i = a; i < b; i++) {
          if (lines[i].trim().startsWith('#EXTINF')) break;
          hdr.push(lines[i]);
        }
        out.push(...hdr);
      }
      return;
    }

    if (kept > 0) out.push('#EXT-X-DISCONTINUITY');
    // ENDLIST 统一在末尾补一次，避免重复或丢失
    out.push(...lines.slice(a, b).filter(l => !/^#EXT-X-ENDLIST/i.test(l.trim())));
    kept++;
  });

  if (hadEndList) out.push('#EXT-X-ENDLIST');

  return { text: out.join('\n') + '\n', cuts, removed: Math.round(removed * 100) / 100, kept };
}

app.get('/api/hls', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) return res.status(400).json({ error: '缺少 url 参数' });
  // mode=cut：剪辑模式（删广告块）；默认 skip：保留原列表，播放时跳过
  const useCut = String(req.query.mode || '').toLowerCase() === 'cut';
  try {
    const extraHeaders = parseHeaderParam(req.query.headers);
    let { text, finalUrl } = await fetchPlaylistMaybeMaster(url, extraHeaders);
    if (!/#EXTINF/i.test(text)) return res.status(502).json({ error: '不是有效的媒体播放列表' });

    let abs = absolutizePlaylist(text, finalUrl);
    let analysis = analyzeAdRanges(abs);

    // 部分源（实测瓜子）会间歇性把 m3u8 换成「20 秒广告占位页」并 302 到别的域名，
    // 表现就是点开只播十几秒。列表短到离谱时重取几次，挑最长的那份。
    if (Object.keys(extraHeaders).length && analysis.duration > 0 && analysis.duration < 30) {
      for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 350));
        try {
          const again = await fetchPlaylistMaybeMaster(url, extraHeaders);
          if (!/#EXTINF/i.test(again.text)) continue;
          const abs2 = absolutizePlaylist(again.text, again.finalUrl);
          const a2 = analyzeAdRanges(abs2);
          if (a2.duration > analysis.duration) { finalUrl = again.finalUrl; abs = abs2; analysis = a2; }
        } catch (e) {}
        if (analysis.duration >= 30) break;
      }
      if (analysis.duration < 30) {
        return res.status(502).json({
          error: '源返回的是广告/占位播放列表（仅 ' + Math.round(analysis.duration) + ' 秒），稍后重试或换源',
          short: true,
          source: finalUrl
        });
      }
    }
    const token = crypto.randomBytes(8).toString('hex');

    let served = abs;
    let cut = null;
    if (useCut) {
      const built = buildCutPlaylist(abs, analysis);
      if (built.cuts.length) {
        served = built.text;
        cut = { cuts: built.cuts, removed: built.removed, kept: built.kept };
      }
    }

    // 虫包地址的 CDN 多半不带 CORS 头：有附加请求头时，把分片/密钥也改写成同源代理，
    // 否则 hls.js 在浏览器里会「列表能读、分片全挂」。mpv 走代理也只是多一跳本地转发。
    if (Object.keys(extraHeaders).length) served = proxyUris(served, extraHeaders);

    pruneHlsCache();
    hlsCache.set(token, { text: served, ts: Date.now(), url: finalUrl });

    const pathPart = `/api/hls/${token}.m3u8`;
    res.json({
      token,
      path: pathPart,
      absoluteUrl: `${req.protocol}://${req.get('host')}${pathPart}`,
      mode: cut ? 'cut' : 'skip',
      cut: !!cut,
      cuts: cut ? cut.cuts : [],
      removedSeconds: cut ? cut.removed : 0,
      ranges: cut ? [] : analysis.ranges,
      chunks: analysis.chunks || [],
      edgeAds: analysis.edgeAds || 0,
      duration: cut ? Math.round((analysis.duration - cut.removed) * 100) / 100 : analysis.duration,
      sourceDuration: analysis.duration,
      totalChunks: analysis.totalChunks,
      source: finalUrl
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/**
 * 分片代理：虫包的 CDN 通常不带 CORS 头，浏览器里 hls.js 直接拉分片会被拦。
 * 把列表里的分片与密钥改写成 /api/seg?... 后，MSE 就变成同源请求了。
 * mpv 走这条路也没问题（只是多一次本地转发）。
 */
app.get('/api/seg', async (req, res) => {
  const target = String(req.query.u || '').trim();
  if (!/^https?:\/\//i.test(target)) return res.status(400).send('bad url');
  try {
    const headers = requestHeaders(req.query.h);
    const range = req.headers.range;
    if (range) headers.Range = range;
    const r = await axios.get(target, {
      timeout: 30000,
      responseType: 'stream',
      headers,
      maxRedirects: 5,
      validateStatus: () => true
    });
    res.status(r.status === 206 ? 206 : 200);
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
      if (r.headers[k]) res.setHeader(k, r.headers[k]);
    }
    r.data.pipe(res);
  } catch (e) {
    res.status(502).send('segment fetch failed');
  }
});

app.get('/api/hls/:file', (req, res) => {
  const token = String(req.params.file || '').replace(/\.m3u8$/i, '');
  const hit = hlsCache.get(token);
  if (!hit) return res.status(404).type('text/plain').send('playlist not found');
  if (Date.now() - hit.ts > HLS_TTL) {
    hlsCache.delete(token);
    return res.status(404).type('text/plain').send('playlist expired');
  }
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  res.send(hit.text);
});



/* ==================== 同片源聚合（按延迟排序） ==================== */

const sourceCache = new Map(); // name -> { at, data }
const SOURCE_CACHE_TTL = 5 * 60 * 1000;

// normName 已在上方统一声明

app.get('/api/sources', async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) return res.json({ list: [], totalSites: 0, okSites: 0 });

  const cacheKey = normName(name);
  const hit = sourceCache.get(cacheKey);
  if (hit && Date.now() - hit.at < SOURCE_CACHE_TTL) {
    return res.json({ ...hit.data, cached: true });
  }

  const sites = state.sites.filter(s => s.searchable !== 0 && (!s.isDexSpider || JvmBridge.installed()));
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
        const s = await withTimeout(searchSite(site, name, 1), site.isDexSpider ? 45000 : TIMEOUT);
        const candidates = s.list || [];
        // 片名完全一致，或包含关系（去掉标点后比较）
        const match = candidates.find(v => normName(v.vod_name) === target)
          || candidates.find(v => normName(v.vod_name).includes(target) || target.includes(normName(v.vod_name)));
        if (!match) continue;

        const d = site.isDexSpider
          ? await withTimeout(SpiderEngine.getDetail(site, match.vod_id, state.spider), 45000)
          : await withTimeout(CmsEngine.getDetail({ api: site.api }, match.vod_id), TIMEOUT);
        if (!d || !d.playSources || d.playSources.length === 0) continue;

        // 顺带探测这条源首集的封装质量（有 discontinuity 的源更容易出现声音异常）
        let probe = null;
        try {
          const firstUrl = d.playSources[0].episodes[0].url;
          if (/^https?:\/\//i.test(firstUrl)) probe = await probePlaylist(firstUrl);
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

/* ==================== 地址内容嗅探 ==================== */
// 虫包常给 http://127.0.0.1:<port>/... 这类没有后缀的地址：
// mpv/hls.js 只按后缀选解复用器，会把 HLS 当普通文件而播不了。
// 这里读回前几 KB 判断真实类型（只读一小段就断开，不会把整个直播流拉下来）。
app.get('/api/sniff', async (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ kind: 'error', error: '缺少 url' });
  let streamRef = null;
  try {
    const r = await axios.get(url, {
      timeout: 10000,
      responseType: 'stream',
      headers: requestHeaders(req.query.headers),
      maxRedirects: 5,
      validateStatus: () => true
    });
    streamRef = r.data;
    const ct = String(r.headers['content-type'] || '');
    let head = Buffer.alloc(0);
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      r.data.once('data', (chunk) => { head = Buffer.from(chunk).slice(0, 4096); finish(); });
      r.data.once('end', finish);
      r.data.once('error', finish);
      setTimeout(finish, 4000);
    });
    try { r.data.destroy(); } catch (e) {}
    const text = head.toString('utf8');
    let kind = '';
    if (text.includes('#EXTM3U')) kind = 'hls';
    else if (/mpegurl/i.test(ct)) kind = 'hls';
    else if (head.length >= 8 && head.slice(4, 8).toString('latin1') === 'ftyp') kind = 'mp4';
    else if (/^FLV/.test(head.slice(0, 3).toString('latin1'))) kind = 'flv';
    else if (/^\x1a\x45\xdf\xa3/.test(head.slice(0, 4).toString('latin1'))) kind = 'mkv';
    else if (/mp4|webm/i.test(ct)) kind = 'mp4';
    else if (/flv/i.test(ct)) kind = 'flv';
    res.json({ kind: kind || 'other', contentType: ct, status: r.status });
  } catch (e) {
    try { if (streamRef) streamRef.destroy(); } catch (err) {}
    res.json({ kind: 'error', error: e.message });
  }
});

/* ==================== 自动更新（GitHub Releases） ==================== */

app.get('/api/update/status', (req, res) => {
  try { res.json(Updater.status()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/update/check', async (req, res) => {
  try { res.json(await Updater.check(String(req.query.force || '1') !== '0')); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/update/download', async (req, res) => {
  try { res.json(await Updater.download(String(req.query.force || '') === '1')); } catch (e) { res.status(409).json({ error: e.message }); }
});

app.post('/api/update/apply', (req, res) => {
  try {
    const r = Updater.apply();
    res.json(r);
    // 便携版只是打开下载目录让用户自己覆盖，进程照常运行
    if (r.action !== 'installer') return;
    // 安装版：启动安装程序后退出自己，安装器才能替换文件
    setTimeout(() => {
      const has = process.emit('kimbox:quit');
      if (!has) return process.exit(0);
      // 兜底：万一 app.quit() 被什么挂住，4 秒后强制退出
      setTimeout(() => { try { process.exit(0); } catch (e) {} }, 4000);
    }, 1200);
  } catch (e) {
    res.status(409).json({ error: e.message });
  }
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
      clearAllConfigCache();
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

/* ==================== 缓存管理 (仅清理 %APPDATA%\KimBoxPC 临时海报与运行缓存) ==================== */

const CACHE_SUBFOLDERS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'GrShaderCache'
];

function getDirSize(dir) {
  let size = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) size += getDirSize(full);
        else size += st.size;
      } catch (e) {}
    }
  } catch (e) {}
  return size;
}

function cleanFolderContents(dir) {
  let freed = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    const files = fs.readdirSync(dir);
    for (const f of files) {
      const full = path.join(dir, f);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          freed += cleanFolderContents(full);
          try { fs.rmdirSync(full); } catch (e) {}
        } else {
          freed += st.size;
          fs.unlinkSync(full);
        }
      } catch (e) {}
    }
  } catch (e) {}
  return freed;
}

function getAppCacheInfo() {
  const appData = process.env.APPDATA;
  if (!appData) return { sizeBytes: 0, sizeMB: 0, path: '' };
  const targetDir = path.join(appData, 'kimboxpc');
  let totalBytes = 0;
  for (const sub of CACHE_SUBFOLDERS) {
    totalBytes += getDirSize(path.join(targetDir, sub));
  }
  return {
    sizeBytes: totalBytes,
    sizeMB: Math.round((totalBytes / 1024 / 1024) * 100) / 100,
    path: targetDir
  };
}

app.get('/api/cache/info', (req, res) => {
  res.json(getAppCacheInfo());
});

app.post('/api/cache/clean', (req, res) => {
  const before = getAppCacheInfo();
  let freedBytes = 0;
  const appData = process.env.APPDATA;
  if (appData) {
    const targetDir = path.join(appData, 'kimboxpc');
    for (const sub of CACHE_SUBFOLDERS) {
      freedBytes += cleanFolderContents(path.join(targetDir, sub));
    }
  }
  const after = getAppCacheInfo();
  const freedMB = Math.round(Math.max(freedBytes, before.sizeBytes - after.sizeBytes) / 1024 / 1024 * 100) / 100;
  res.json({
    ok: true,
    freedMB: freedMB > 0 ? freedMB : before.sizeMB,
    currentMB: after.sizeMB
  });
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
  const { url, title, player, startAt } = req.body || {};
  if (!url) return res.status(400).json({ error: '缺少播放 URL' });
  try {
    res.json(await PlayerLauncher.play(url, title || 'TVBox 视频', player || '', Number(startAt) || 0));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const server = app.listen(PORT, HOST);
// 启动 20 秒后后台查一次更新（不阻塞启动，失败静默）
Updater.scheduleAutoCheck(8000);

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

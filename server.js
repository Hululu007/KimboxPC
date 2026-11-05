const express = require('express');
const cors = require('cors');
const path = require('path');
const ConfigParser = require('./configParser');
const CmsEngine = require('./cmsEngine');
const PlayerLauncher = require('./playerLauncher');
const { ConfigRepo, HistoryRepo, FavoriteRepo, backup, listBackups } = require('./db');

const app = express();
const PORT = Number(process.env.PORT || 3980);

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
  state.activeSite = state.sites.find(s => !s.isDexSpider) || state.sites[0] || null;
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
  res.json({
    sites: state.sites.map(publicSite),
    activeSite: state.activeSite ? state.activeSite.key : null
  });
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

/* ==================== 备份 ==================== */

app.get('/api/backups', (req, res) => {
  res.json({ dir: 'data/backups', list: listBackups() });
});

app.post('/api/backup', (req, res) => {
  const r = backup('manual');
  res.json({ success: !r.error, ...r });
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

const server = app.listen(PORT);

server.on('listening', async () => {
  const bak = backup('startup');
  console.log('========================================');
  console.log('TVBox PC 版已就绪！');
  console.log(`本地界面地址: http://127.0.0.1:${PORT}`);

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

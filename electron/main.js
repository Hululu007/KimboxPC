const { app, BrowserWindow, ipcMain, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');

/**
 * KimBoxPC 桌面壳（Electron + libmpv 原生渲染）
 *
 * 播放链路：
 *   libmpv（原生模块，MPV_RENDER_API_TYPE_SW）
 *     → 每帧渲染到内存缓冲
 *     → IPC 送到渲染进程
 *     → canvas 显示
 *   音频由 libmpv 直接输出到声卡，不经过浏览器 MSE。
 */

const ROOT = path.join(__dirname, '..');

// 端口来源与服务端保持一致：环境变量 PORT > port.txt > 3980
function readPort() {
  const pick = (v) => {
    const n = Number(String(v || '').trim());
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
  };
  const fromEnv = pick(process.env.PORT);
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'port.txt'), 'utf8').split(/\r?\n/)[0];
    const fromFile = pick(raw);
    if (fromFile) return fromFile;
  } catch (e) {}
  return 3980;
}
const PORT = readPort();

let mainWin = null;
let native = null;          // libmpv 原生模块
let inst = null;            // mpv 实例
let renderTimer = null;     // 渲染循环
let frameCount = 0;
let renderW = 1280;
let renderH = 720;
let lastFrameAt = 0;
let lastKnownDuration = 0;
let lastKnownPosition = 0;   // 见过的最远播放位置（中途 EOF 时 time-pos 会归零）
// mpv 的原始 time-pos 在「自然播放跨过 HLS discontinuity」时会重置到 0 附近，
// 而 seek 之后又报告绝对值。为让界面进度与广告区间对得上，这里维护一个偏移量。
let timeOffset = 0;
let lastRawPos = 0;
let selfSeekUntil = 0;
let playbackStarted = false;

/* ---------- 内嵌服务端 ---------- */
// 端口上是否已有我们自己的服务在跑（上次残留的实例）
function serverAlive() {
  return new Promise((resolve) => {
    const http = require('http');
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/version', timeout: 1200 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function startServer() {
  process.env.TVBOX_EMBED = '1';
  process.env.PORT = String(PORT);   // 与服务端共用同一个端口，避免读取到不同值

  // 端口上已有可用服务 → 直接复用，避免"起不来又白屏"
  if (await serverAlive()) {
    console.log(`[shell] 端口 ${PORT} 上已有服务，直接复用`);
    return;
  }

  try {
    const srv = require(path.join(ROOT, 'server.js'));
    void srv;
  } catch (e) {
    console.error('[shell] 服务端启动失败:', e.message);
    // 端口被占用（常见于残留进程）→ 明确告诉用户，而不是白屏
    if (/EADDRINUSE/i.test(String(e.message))) {
      try {
        dialog.showErrorBox(
          'KimBoxPC 启动失败',
          `端口 ${PORT} 已被占用，通常是上次没完全退出的残留进程。\n\n` +
          '请打开任务管理器，结束所有 electron.exe 进程后重新启动。\n' +
          '（也可以把 port.txt 里的端口改成别的数字）'
        );
      } catch (err) {}
    }
  }
}

/* ---------- 原生模块 ---------- */
function loadNative() {
  if (native) return native;
  const addon = path.join(ROOT, 'native', 'build', 'Release', 'mpv_native.node');
  const dll = path.join(ROOT, 'native', 'lib', 'libmpv-2.dll');
  const libDir = path.join(ROOT, 'native', 'lib');
  if (!fs.existsSync(addon)) throw new Error('原生模块未编译: ' + addon);
  if (!fs.existsSync(dll)) throw new Error('缺少 libmpv-2.dll: ' + dll);

  // libmpv 依赖同目录下的 vulkan-1.dll 等文件；把该目录加进 DLL 搜索路径，
  // 否则在没装 Vulkan 运行时的机器上 LoadLibrary 会直接失败
  try {
    const envPath = process.env.PATH || '';
    if (!envPath.toLowerCase().includes(libDir.toLowerCase())) {
      process.env.PATH = libDir + ';' + envPath;
    }
  } catch (e) {}

  try {
    native = require(addon);
  } catch (e) {
    throw new Error('无法加载原生模块（' + e.message + '）。若是新机器，请先双击「修复运行环境.bat」');
  }

  try {
    native.init(dll);
  } catch (e) {
    throw new Error('libmpv 初始化失败：' + e.message +
      '。常见原因：1) 缺少 vulkan-1.dll（已在 native\\lib，请确认未被杀软删除）；2) 文件被 Windows 标记为「来自网络」（右键属性→解除锁定）；3) 系统缺少 VC++ 运行库。可先双击「修复运行环境.bat」');
  }
  return native;
}

/* ---------- 窗口尺寸记忆 ---------- */
const STATE_FILE = path.join(ROOT, 'data', 'window-state.json');
const DEFAULT_BOUNDS = { width: 1460, height: 920 };

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s && Number(s.width) >= 1024 && Number(s.height) >= 640) {
      return {
        width: Math.round(Number(s.width)),
        height: Math.round(Number(s.height)),
        x: Number.isFinite(s.x) ? Math.round(s.x) : undefined,
        y: Number.isFinite(s.y) ? Math.round(s.y) : undefined,
        maximized: !!s.maximized
      };
    }
  } catch (e) {}
  return { ...DEFAULT_BOUNDS, maximized: false };
}

function saveWindowState(win) {
  try {
    if (!win || win.isDestroyed() || win.isFullScreen()) return;
    const b = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    const data = {
      x: b.x, y: b.y,
      width: b.width, height: b.height,
      maximized: win.isMaximized()
    };
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {}
}

/* ---------- 窗口 ---------- */
function createMainWindow() {
  const ws = loadWindowState();
  const appIcon = path.join(ROOT, 'icon.ico');
  mainWin = new BrowserWindow({
    width: ws.width,
    height: ws.height,
    ...(fs.existsSync(appIcon) ? { icon: appIcon } : {}),
    ...(Number.isFinite(ws.x) && Number.isFinite(ws.y) ? { x: ws.x, y: ws.y } : {}),
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0b0d10',
    title: 'KimBoxPC',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  mainWin.setMenuBarVisibility(false);
  if (ws.maximized) { try { mainWin.maximize(); } catch (e) {} }

  // 加载失败时不要再静默白屏：给出明确原因和下一步
  mainWin.webContents.on('did-fail-load', (e, code, desc, url) => {
    if (code === -3) return;   // -3 = 用户主动中止，忽略
    const hint = code === -102
      ? `本地服务没有启动（端口 ${PORT} 可能被占用）\n\n请先关闭所有 KimBoxPC 窗口，或在任务管理器结束残留的 electron.exe 后重试。`
      : `无法打开界面：${desc}（${code}）\n\n地址：${url}`;
    console.error('[shell] 界面加载失败:', code, desc, url);
    try {
      dialog.showErrorBox('KimBoxPC 启动失败', hint);
    } catch (err) {}
  });

  // 尺寸/位置变化后延迟保存，避免拖动时频繁写盘
  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(mainWin), 500);
  };
  mainWin.on('resize', scheduleSave);
  mainWin.on('move', scheduleSave);
  mainWin.on('maximize', scheduleSave);
  mainWin.on('unmaximize', scheduleSave);

  mainWin.loadURL(`http://127.0.0.1:${PORT}/`);

  // 创建后立即落盘当前尺寸：文件存在后，用户可以直接编辑它指定默认大小
  setTimeout(() => saveWindowState(mainWin), 1000);
  // 全屏状态变化（含 Esc 由系统触发的情况）通知渲染进程
  mainWin.on('enter-full-screen', () => {
    if (!mainWin.isDestroyed()) mainWin.webContents.send('shell:fullscreen-changed', { fullscreen: true });
  });
  mainWin.on('leave-full-screen', () => {
    if (!mainWin.isDestroyed()) mainWin.webContents.send('shell:fullscreen-changed', { fullscreen: false });
  });

  mainWin.on('show', () => { isBossHidden = false; });
  mainWin.on('close', () => saveWindowState(mainWin));

  mainWin.on('closed', () => {
    mainWin = null;
    destroyInstance();
    app.quit();
  });
}

/* ---------- 全屏 ---------- */
ipcMain.handle('shell:fullscreen', (evt, { on }) => {
  if (!mainWin || mainWin.isDestroyed()) return { error: '窗口不可用' };
  mainWin.setFullScreen(!!on);
  return { fullscreen: mainWin.isFullScreen() };
});

ipcMain.handle('shell:isfullscreen', () => {
  return { fullscreen: !!(mainWin && !mainWin.isDestroyed() && mainWin.isFullScreen()) };
});

/* ---------- 摸鱼键 (Boss Key) 全局快速隐藏与唤醒 ---------- */
const BOSS_KEY_FILE = path.join(ROOT, 'data', 'boss-key.json');
let currentBossShortcut = 'Alt+Q';
let bossKeyEnabled = true;
let isBossHidden = false;
let wasFullscreenBeforeHide = false;

function loadBossKeyConfig() {
  try {
    if (fs.existsSync(BOSS_KEY_FILE)) {
      const s = JSON.parse(fs.readFileSync(BOSS_KEY_FILE, 'utf8'));
      if (s && typeof s.shortcut === 'string' && s.shortcut.trim()) {
        return {
          shortcut: s.shortcut.trim(),
          enabled: s.enabled !== false
        };
      }
    }
  } catch (e) {}
  return { shortcut: 'Alt+Q', enabled: true };
}

function saveBossKeyConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(BOSS_KEY_FILE), { recursive: true });
    fs.writeFileSync(BOSS_KEY_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {}
}

function pausePlaybackForBossKey() {
  try {
    if (native && inst) {
      native.setProp(inst, 'pause', true);
    }
  } catch (e) {}
  try {
    if (mainWin && !mainWin.isDestroyed() && mainWin.webContents) {
      mainWin.webContents.send('boss-key:pause');
    }
  } catch (e) {}
}

function triggerBossKey() {
  if (!mainWin || mainWin.isDestroyed()) return;

  const isVisible = mainWin.isVisible() && !mainWin.isMinimized() && !isBossHidden;

  if (isVisible) {
    // 隐藏：暂停视频与音频，记录全屏状态
    pausePlaybackForBossKey();
    wasFullscreenBeforeHide = mainWin.isFullScreen();
    isBossHidden = true;
    mainWin.hide();
    console.log('[boss-key] 窗口已快速隐藏并暂停播放');
  } else {
    // 唤醒：还原窗口并置前，保持暂停状态
    isBossHidden = false;
    if (mainWin.isMinimized()) {
      mainWin.restore();
    }
    mainWin.setAlwaysOnTop(true);
    mainWin.show();
    mainWin.focus();
    mainWin.setAlwaysOnTop(false);

    if (wasFullscreenBeforeHide && !mainWin.isFullScreen()) {
      try { mainWin.setFullScreen(true); } catch (e) {}
    }

    // 唤醒后：保持暂停，绝不自动播放！
    try {
      if (mainWin.webContents) {
        mainWin.webContents.send('boss-key:wake');
      }
    } catch (e) {}
    console.log('[boss-key] 窗口已唤醒，保持暂停状态等待手动播放');
  }
}

function registerBossKey(accelerator) {
  if (!accelerator || typeof accelerator !== 'string') return false;
  if (currentBossShortcut) {
    try { globalShortcut.unregister(currentBossShortcut); } catch (e) {}
  }
  if (!bossKeyEnabled) return true;

  try {
    const ok = globalShortcut.register(accelerator, () => {
      triggerBossKey();
    });
    if (ok) {
      currentBossShortcut = accelerator;
      console.log(`[boss-key] 全局快捷键注册成功: ${accelerator}`);
      return true;
    }
    console.warn(`[boss-key] 全局快捷键注册失败: ${accelerator}`);
    return false;
  } catch (err) {
    console.warn(`[boss-key] 快捷键注册异常:`, err.message);
    return false;
  }
}

ipcMain.handle('shell:getBossKey', () => {
  return {
    shortcut: currentBossShortcut || 'Alt+Q',
    enabled: bossKeyEnabled,
    registered: globalShortcut.isRegistered(currentBossShortcut || 'Alt+Q')
  };
});

ipcMain.handle('shell:setBossKey', (evt, { accelerator, enabled }) => {
  const newEnabled = enabled !== undefined ? !!enabled : bossKeyEnabled;
  const newKey = (accelerator && String(accelerator).trim()) || currentBossShortcut || 'Alt+Q';

  if (currentBossShortcut) {
    try { globalShortcut.unregister(currentBossShortcut); } catch (e) {}
  }

  bossKeyEnabled = newEnabled;
  if (!bossKeyEnabled) {
    currentBossShortcut = newKey;
    saveBossKeyConfig({ shortcut: currentBossShortcut, enabled: false });
    return { ok: true, shortcut: currentBossShortcut, enabled: false };
  }

  try {
    const registered = globalShortcut.register(newKey, () => {
      triggerBossKey();
    });
    if (registered) {
      currentBossShortcut = newKey;
      saveBossKeyConfig({ shortcut: currentBossShortcut, enabled: true });
      return { ok: true, shortcut: currentBossShortcut, enabled: true };
    } else {
      let rollbackOk = false;
      if (currentBossShortcut && currentBossShortcut !== newKey) {
        try {
          rollbackOk = globalShortcut.register(currentBossShortcut, () => triggerBossKey());
        } catch (e) {}
      }
      return {
        ok: false,
        error: `快捷键 "${newKey}" 注册失败（已被系统或其他软件占用），请更换`,
        shortcut: rollbackOk ? currentBossShortcut : newKey,
        enabled: bossKeyEnabled
      };
    }
  } catch (err) {
    return {
      ok: false,
      error: `快捷键格式不支持或无效: ${err.message}`,
      shortcut: currentBossShortcut,
      enabled: bossKeyEnabled
    };
  }
});

ipcMain.handle('shell:setBossKeyEnabled', (evt, { enabled }) => {
  bossKeyEnabled = !!enabled;
  if (bossKeyEnabled) {
    registerBossKey(currentBossShortcut);
  } else {
    if (currentBossShortcut) {
      try { globalShortcut.unregister(currentBossShortcut); } catch (e) {}
    }
  }
  saveBossKeyConfig({ shortcut: currentBossShortcut, enabled: bossKeyEnabled });
  return { ok: true, enabled: bossKeyEnabled, shortcut: currentBossShortcut };
});

ipcMain.handle('shell:triggerBossKey', () => {
  triggerBossKey();
  return { ok: true };
});

/* ---------- 缓存管理 (仅限 %APPDATA%\KimBoxPC 临时海报与运行缓存) ---------- */
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

ipcMain.handle('shell:getCacheInfo', () => {
  return getAppCacheInfo();
});

ipcMain.handle('shell:cleanCache', async () => {
  const before = getAppCacheInfo();
  try {
    const { session } = require('electron');
    if (session && session.defaultSession) {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearStorageData({ storages: ['cachestorage', 'shadercache'] });
    }
  } catch (e) {}

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
  return {
    ok: true,
    freedMB: freedMB > 0 ? freedMB : before.sizeMB,
    currentMB: after.sizeMB
  };
});

/* ---------- 字幕 / 音轨 ---------- */
ipcMain.handle('mpv:tracks', () => {
  if (!inst || !native) return { list: [], sid: null, aid: null };
  const g = (n) => { try { return native.getProp(inst, n); } catch (e) { return null; } };
  const count = Number(g('track-list/count') || 0);
  const list = [];
  for (let i = 0; i < count; i++) {
    list.push({
      type: g(`track-list/${i}/type`) || '',
      id: Number(g(`track-list/${i}/id`)),
      title: g(`track-list/${i}/title`) || '',
      lang: g(`track-list/${i}/lang`) || '',
      codec: g(`track-list/${i}/codec`) || '',
      external: String(g(`track-list/${i}/external`)) === 'yes' || g(`track-list/${i}/external`) === true
    });
  }
  return { list, sid: g('sid'), aid: g('aid') };
});

ipcMain.handle('mpv:setTrack', (evt, { kind, id }) => {
  try {
    if (!inst || !native) return { error: 'mpv 未启动' };
    const prop = kind === 'sub' ? 'sid' : 'aid';
    native.setProp(inst, prop, (id === 'no' || id === 0 || id === '0') ? 'no' : Number(id));
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('mpv:pickSubtitle', async () => {
  try {
    if (!inst || !native) return { error: 'mpv 未启动' };
    const r = await dialog.showOpenDialog(mainWin, {
      title: '选择字幕文件',
      properties: ['openFile'],
      filters: [{ name: '字幕', extensions: ['srt', 'ass', 'ssa', 'vtt', 'sub'] }]
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    native.command(inst, ['sub-add', r.filePaths[0], 'select']);
    return { path: r.filePaths[0] };
  } catch (e) {
    return { error: e.message };
  }
});

/* ---------- 播放控制 ---------- */
function stopRenderLoop() {
  if (renderTimer) {
    clearInterval(renderTimer);
    renderTimer = null;
  }
}

/** mpv 生命周期写进日志：偶发原生崩溃时可回溯到具体是哪一步 */
function mpvLog(msg) {
  try {
    const f = path.join(ROOT, 'data', 'app.log');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `[${new Date().toISOString()}] [mpv] ${msg}\n`, 'utf8');
  } catch (e) {}
}

function stopPlayback() {
  stopRenderLoop();
  if (!inst || !native) return;
  // 只「停播」不销毁：libmpv 在拉流/解码过程中被 destroy 偶发原生崩溃
  // （E2E 实测同一位置崩了两次，退出码 0xFFFF7003）。
  // 实例保留为空闲状态，下次 loadfile 直接复用；真正销毁放到退出时。
  try { native.setProp(inst, 'pause', true); } catch (e) {}
  try { native.command(inst, ['stop']); } catch (e) {}
  mpvLog('stop (keep instance)');
}

/** 只在进程退出/窗口关闭时真正销毁实例 */
function destroyInstance() {
  stopRenderLoop();
  if (!inst || !native) return;
  const old = inst;
  inst = null;
  try { native.destroy(old); } catch (e) {}
  mpvLog('destroy');
}

function ensureInstance(opts) {
  loadNative();
  if (inst) return inst;
  inst = native.create(opts || {
    vo: 'libmpv',
    hwdec: 'auto-safe',
    cache: 'yes',
    'audio-client-name': 'KimBoxPC',
    'keep-open': 'no',
    'cache-secs': '30'
  });
  // 渲染上下文必须在 loadfile 之前创建
  native.initRender(inst, renderW, renderH);
  mpvLog(`create ${renderW}x${renderH}`);
  return inst;
}

function startRenderLoop() {
  stopRenderLoop();
  const INTERVAL = 33; // ~30fps
  renderTimer = setInterval(() => {
    if (!inst || !native || !mainWin || mainWin.isDestroyed()) return;
    let f;
    try { f = native.render(inst); } catch (e) { return; }
    if (!f || !f.buffer || !f.buffer.length) return;

    frameCount++;
    lastFrameAt = Date.now();

    // 复制到独立 ArrayBuffer 再发送（避免外部缓冲被复用）
    const w = f.width, h = f.height;
    mainWin.webContents.send('mpv:frame', {
      data: Buffer.from(f.buffer),
      width: w,
      height: h
    });
  }, INTERVAL);
}

/* ---------- IPC ---------- */
ipcMain.handle('shell:quit', () => { setTimeout(() => app.quit(), 50); return { ok: true }; });

ipcMain.handle('shell:info', () => {
  let mpvVersion = null;
  try { loadNative(); mpvVersion = 'ok'; } catch (e) { mpvVersion = e.message; }
  return {
    electron: true,
    version: process.versions.electron,
    libmpv: mpvVersion,
    render: `${renderW}x${renderH}`
  };
});

ipcMain.handle('mpv:open', (evt, payload) => {
  try {
    const { url, title, start, width, height, cacheSecs } = payload || {};
    console.log('[mpv:open]', JSON.stringify({ start, width, height, url: String(url).slice(-40) }));
    if (!url) return { error: '缺少 url' };

    if (width && height) {
      renderW = Math.max(320, Math.min(1920, Math.round(width)));
      renderH = Math.max(180, Math.min(1080, Math.round(height)));
      // 尺寸变了不再销毁重建实例（重建 mpv 是崩溃高发点），复用实例换渲染缓冲即可
      if (inst && native) {
        try {
          if (native.resize) native.resize(inst, renderW, renderH);
          else native.initRender(inst, renderW, renderH);
        } catch (e) {}
      }
    }

    const i = ensureInstance();
    if (title) {
      try { native.setProp(i, 'force-media-title', title); } catch (e) {}
    }
    // 缓冲档位：用户可在界面上选 15 / 30 / 60 / 120 秒
    try {
      const secs = Math.max(5, Math.min(600, Number(cacheSecs) || 30));
      native.setProp(i, 'cache-secs', String(secs));
      // 按 ~6Mbps 估算内存上限，夹在 32MB ~ 512MB 之间，避免 600 秒档吃掉太多内存
      const MB = 1024 * 1024;
      const est = Math.round(secs * 0.75 * MB);
      const maxBytes = Math.max(32 * MB, Math.min(512 * MB, est));
      native.setProp(i, 'demuxer-max-bytes', String(maxBytes));
      native.setProp(i, 'demuxer-max-back-bytes', String(Math.round(maxBytes / 2)));
    } catch (e) {}

    // 虫包（TVBox spider）给的播放地址常校验 Referer/Origin，必须在 loadfile 之前设给 mpv。
    // 每次 open 都显式设置（空则清空），避免上一条流的头残留到下一条。
    try {
      const hs = (payload && payload.headers) || null;
      const fields = hs && typeof hs === 'object'
        ? Object.entries(hs).map(([k, v]) => `${k}: ${String(v).replace(/[\r\n]/g, ' ')}`).join(',')
        : '';
      native.setProp(i, 'http-header-fields', fields);
    } catch (e) {}

    // 续播定位用 start 选项（loadfile 的第 4 个参数在 IPC 里不接受字符串，会报 invalid parameter）
    const s = Math.floor(Number(start) || 0);
    if (s > 0) native.setProp(i, 'start', String(s));
    else native.setProp(i, 'start', '0');

    native.command(i, ['loadfile', url, 'replace']);
    native.setProp(i, 'pause', false);
    if (s > 0) setTimeout(() => { try { native.setProp(i, 'start', '0'); } catch (e) {} }, 3000);
    startRenderLoop();
    frameCount = 0;
    lastKnownDuration = 0;
    lastKnownPosition = 0;
    // 换文件必须清掉时间轴偏移，否则新文件的位置会被加上上一个文件的偏移（数值离谱）
    timeOffset = 0;
    lastRawPos = 0;
    selfSeekUntil = Date.now() + 3000;
    playbackStarted = true;
    return { ok: true, render: `${renderW}x${renderH}` };
  } catch (e) {
    return { error: e.message };
  }
});

// 调试面板用：读取当前解码/渲染状态（静态属性，只在面板打开时每 2 秒读一次）
ipcMain.handle('mpv:props', () => {
  try {
    if (!inst || !native) return { running: false };
    const g = (k) => { try { return native.getProp(inst, k); } catch (e) { return null; } };
    return {
      running: true,
      hwdec: g('hwdec'),
      hwdecCurrent: g('hwdec-current'),
      hwdecInterop: g('hwdec-interop'),
      vo: g('vo-configured'),
      format: g('video-format'),
      width: g('width'),
      height: g('height'),
      dropped: g('frame-drop-count'),
      cacheSecs: g('cache-secs'),
      speed: g('speed')
    };
  } catch (e) {
    return { running: false, error: e.message };
  }
});

ipcMain.handle('mpv:cmd', (evt, { name, args }) => {
  try {
    if (!inst || !native) return { error: 'mpv 未启动' };
    if (name === 'seek') {
      // seek 之后 mpv 报告的是绝对时间，偏移量清零，并给 5 秒豁免期避免误判为"时间轴重置"
      const absolute = Number(args[0]) || 0;
      timeOffset = 0;
      selfSeekUntil = Date.now() + 5000;
      lastRawPos = absolute;
      // 跳到片尾附近（片尾广告就是这样跳的）：有的源 seek 到结尾会立刻 idle 且不再上报位置，
      // lastKnownPosition 会停在广告开头，导致 ended 永远不成立 → 界面卡在 idle 不切集。
      // 这里把目标位置记进「最远位置」，让播完判定成立。
      if (lastKnownDuration > 0 && absolute >= lastKnownDuration - 3 && absolute > lastKnownPosition) {
        lastKnownPosition = absolute;
      }
      native.command(inst, ['seek', String(absolute), args[1] || 'absolute']);
    } else if (name === 'cycle') {
      native.command(inst, ['cycle', String(args[0])]);
    } else if (name === 'set_property') {
      native.setProp(inst, String(args[0]), args[1]);
    } else {
      native.command(inst, [name, ...(args || []).map(String)]);
    }
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('mpv:state', () => {
  if (!inst || !native) return { running: false, connected: false };
  const p = (n) => { try { return native.getProp(inst, n); } catch (e) { return null; } };

  const dur = Number(p('duration') || 0);
  if (dur > 0) lastKnownDuration = dur;

  const rawPosVal = p('time-pos');
  const idleNow = p('idle-active') === 'yes' || p('idle-active') === true || p('idle-active') === 1;
  const eofNow = (() => { const v = p('eof-reached'); return v === 'yes' || v === 'true' || v === 1 || v === true; })();

  // 缓冲中或加载分片时，mpv 的 time-pos 可能短暂为 null，保持上一有效状态，避免误判跳变
  if (rawPosVal === null || rawPosVal === undefined || !isFinite(Number(rawPosVal))) {
    const nearEnd = lastKnownDuration > 0 && lastKnownPosition >= lastKnownDuration - 30;
    const ended = (eofNow || idleNow) && playbackStarted && nearEnd;
    return {
      running: true,
      connected: true,
      position: lastKnownPosition,
      rawPosition: lastRawPos,
      duration: lastKnownDuration,
      paused: (() => { const v = p('pause'); return v === 'yes' || v === 'true' || v === 1 || v === true; })(),
      volume: Number(p('volume') || 0),
      muted: (() => { const v = p('mute'); return v === 'yes' || v === 'true' || v === 1 || v === true; })(),
      eof: eofNow,
      lastPosition: Math.round(lastKnownPosition),
      ended,
      idle: idleNow,
      fps: frameCount,
      title: p('media-title') || '',
      width: Number(p('width') || 0),
      height: Number(p('height') || 0),
      videoBitrate: Number(p('video-bitrate') || 0),
      cacheSpeed: Number(p('cache-speed') || 0),
      speed: Number(p('speed') || 1),
      cacheSecs: Number(p('cache-secs') || 0),
      cacheDuration: Number(p('demuxer-cache-duration') || 0)
    };
  }

  const rawPos = Number(rawPosVal);
  // 检测「时间轴跳变」：位置大幅后退或前进（例如跨过广告/不连续分片），且不是我们自己 seek 造成的
  if (Math.abs(rawPos - lastRawPos) > 15 && lastRawPos > 0 && Date.now() > selfSeekUntil) {
    // 把之前累计的绝对值接上：offset = 上一刻的绝对位置 - 新报告的原始位置
    const lastAbs = lastRawPos + timeOffset;
    timeOffset = lastAbs - rawPos;
    console.log('[mpv] 检测到时间轴跳变，更新偏移量为', Math.round(timeOffset));
  }
  lastRawPos = rawPos;
  let posNow = Math.max(0, rawPos + timeOffset);   // 换算成绝对时间
  if (lastKnownDuration > 0 && posNow > lastKnownDuration && !eofNow) {
    posNow = lastKnownDuration;
  }
  if (posNow > lastKnownPosition) lastKnownPosition = posNow;

  // 播完后 mpv 会卸载当前文件回到 idle，此时 eof-reached 已复位，只能靠「曾经播过且现在 idle」判断。
  // 但中途出现流中断/插播广告也会让 mpv 短暂 idle 或 EOF —— 必须再要求「位置确实已到结尾附近」，
  // 否则会在第 8 分钟被误判成播完而跳到下一集（表现为进度跳回 0）。
  const nearEnd = lastKnownDuration > 0 && lastKnownPosition >= lastKnownDuration - 30;
  const ended = (eofNow || idleNow) && playbackStarted && nearEnd;
  return {
    running: true,
    connected: true,
    position: posNow,
    rawPosition: rawPos,
    duration: Number(p('duration') || 0),
    paused: (() => { const v = p('pause'); return v === 'yes' || v === 'true' || v === 1 || v === true; })(),
    volume: Number(p('volume') || 0),
    muted: (() => { const v = p('mute'); return v === 'yes' || v === 'true' || v === 1 || v === true; })(),
    eof: eofNow,
    lastPosition: Math.round(lastKnownPosition),
    ended,
    idle: idleNow,
    fps: frameCount,
    title: p('media-title') || '',
    // 画面信息（供右上角信息层显示）
    width: Number(p('width') || 0),
    height: Number(p('height') || 0),
    videoBitrate: Number(p('video-bitrate') || 0),   // bit/s，未知为 0
    cacheSpeed: Number(p('cache-speed') || 0),       // byte/s，未知为 0
    speed: Number(p('speed') || 1),                  // 播放倍速
    cacheSecs: Number(p('cache-secs') || 0),         // 缓存设置（秒）
    cacheDuration: Number(p('demuxer-cache-duration') || 0)  // 当前已缓冲秒数
  };
});

ipcMain.handle('mpv:stop', () => {
  stopPlayback();
  return { ok: true };
});

ipcMain.handle('mpv:resize', (evt, { width, height }) => {
  try {
    if (!width || !height) return { error: '尺寸无效' };
    const w = Math.max(320, Math.min(1920, Math.round(width)));
    const h = Math.max(180, Math.min(1080, Math.round(height)));
    if (w === renderW && h === renderH) return { ok: true };
    renderW = w; renderH = h;
    if (inst && native) {
      // SW 渲染的尺寸是每帧参数，只需换缓冲，不能重建上下文（会拆掉视频管线）
      if (native.resize) native.resize(inst, renderW, renderH);
      else native.initRender(inst, renderW, renderH);
    }
    return { ok: true, render: `${renderW}x${renderH}` };
  } catch (e) {
    return { error: e.message };
  }
});

/* ---------- 启动 ---------- */
app.setAppUserModelId('KimBoxPC');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// 单实例锁：防止「用旧窗口占着端口、新窗口起不来」导致看起来打不开
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 已有实例在跑 → 直接退出，由已有实例把窗口提到前台
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户又双击了一次：把已有窗口还原并聚焦
    try {
      if (mainWin) {
        if (mainWin.isMinimized()) mainWin.restore();
        mainWin.show();
        mainWin.focus();
      } else {
        createMainWindow();
      }
    } catch (e) {}
  });

  // 渲染进程崩溃 / 子进程异常退出 → 写进 data/app.log，便于排查"闪退"
  function logMain(line) {
    try {
      const f = path.join(ROOT, 'data', 'app.log');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const st = (() => { try { return fs.statSync(f); } catch (e) { return null; } })();
      if (st && st.size > 512 * 1024) fs.renameSync(f, f + '.1');
      fs.appendFileSync(f, `[${new Date().toISOString()}] [main] ${line}\n`, 'utf8');
    } catch (e) {}
  }
  app.on('render-process-gone', (e, wc, details) => {
    logMain(`render-process-gone reason=${details && details.reason} exitCode=${details && details.exitCode}`);
  });
  app.on('child-process-gone', (e, details) => {
    logMain(`child-process-gone type=${details && details.type} reason=${details && details.reason}`);
  });
  process.on('uncaughtException', (e) => logMain(`uncaughtException: ${e && e.stack ? e.stack : e}`));
  process.on('before-quit', () => logMain('before-quit'));

  // 自动更新：服务端执行完覆盖后会发这个事件，由主进程退出，让更新脚本能替换文件
process.on('kimbox:quit', () => { setTimeout(() => { try { app.quit(); } catch (e) {} }, 300); });

app.whenReady().then(async () => {
    await startServer();
    setTimeout(createMainWindow, 300);

    // 加载并注册摸鱼键
    const cfg = loadBossKeyConfig();
    currentBossShortcut = cfg.shortcut;
    bossKeyEnabled = cfg.enabled;
    registerBossKey(currentBossShortcut);
  });
}

app.on('window-all-closed', () => {
  destroyInstance();
  try { globalShortcut.unregisterAll(); } catch (e) {}
  app.quit();
});

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (e) {}
});

app.on('before-quit', () => {
  destroyInstance();
  try { globalShortcut.unregisterAll(); } catch (e) {}
});


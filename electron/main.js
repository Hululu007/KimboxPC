const { app, BrowserWindow, ipcMain } = require('electron');
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

const PORT = Number(process.env.PORT || 3980);
const ROOT = path.join(__dirname, '..');

let mainWin = null;
let native = null;          // libmpv 原生模块
let inst = null;            // mpv 实例
let renderTimer = null;     // 渲染循环
let frameCount = 0;
let renderW = 1280;
let renderH = 720;
let lastFrameAt = 0;

/* ---------- 内嵌服务端 ---------- */
function startServer() {
  process.env.TVBOX_EMBED = '1';
  try {
    require(path.join(ROOT, 'server.js'));
  } catch (e) {
    console.error('[shell] 服务端启动失败:', e.message);
  }
}

/* ---------- 原生模块 ---------- */
function loadNative() {
  if (native) return native;
  const addon = path.join(ROOT, 'native', 'build', 'Release', 'mpv_native.node');
  const dll = path.join(ROOT, 'native', 'lib', 'libmpv-2.dll');
  if (!fs.existsSync(addon)) throw new Error('原生模块未编译: ' + addon);
  if (!fs.existsSync(dll)) throw new Error('缺少 libmpv-2.dll: ' + dll);
  native = require(addon);
  native.init(dll);
  return native;
}

/* ---------- 窗口 ---------- */
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1460,
    height: 920,
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
  mainWin.loadURL(`http://127.0.0.1:${PORT}/`);
  mainWin.on('closed', () => {
    mainWin = null;
    stopPlayback();
    app.quit();
  });
}

/* ---------- 播放控制 ---------- */
function stopRenderLoop() {
  if (renderTimer) {
    clearInterval(renderTimer);
    renderTimer = null;
  }
}

function stopPlayback() {
  stopRenderLoop();
  if (inst && native) {
    try { native.destroy(inst); } catch (e) {}
    inst = null;
  }
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
      data: f.buffer,
      width: w,
      height: h
    });
  }, INTERVAL);
}

/* ---------- IPC ---------- */
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
    const { url, title, start, width, height } = payload || {};
    if (!url) return { error: '缺少 url' };

    if (width && height) {
      renderW = Math.max(320, Math.min(1920, Math.round(width)));
      renderH = Math.max(180, Math.min(1080, Math.round(height)));
      // 尺寸变化需要重建渲染上下文
      if (inst) { stopPlayback(); }
    }

    const i = ensureInstance();
    if (title) {
      try { native.setProp(i, 'force-media-title', title); } catch (e) {}
    }
    const args = ['loadfile', url];
    if (Number(start) > 0) args.push('replace', `start=+${Math.floor(start)}`);
    native.command(i, args);
    native.setProp(i, 'pause', false);
    startRenderLoop();
    frameCount = 0;
    return { ok: true, render: `${renderW}x${renderH}` };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('mpv:cmd', (evt, { name, args }) => {
  try {
    if (!inst || !native) return { error: 'mpv 未启动' };
    if (name === 'seek') {
      native.command(inst, ['seek', String(args[0]), args[1] || 'absolute']);
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
  return {
    running: true,
    connected: true,
    position: Number(p('time-pos') || 0),
    duration: Number(p('duration') || 0),
    paused: (() => { const v = p('pause'); return v === 'yes' || v === 'true' || v === 1 || v === true; })(),
    idle: !!p('idle-active'),
    fps: frameCount,
    title: p('media-title') || ''
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
      native.initRender(inst, renderW, renderH);   // 重建上下文，保持播放位置
    }
    return { ok: true, render: `${renderW}x${renderH}` };
  } catch (e) {
    return { error: e.message };
  }
});

/* ---------- 启动 ---------- */
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

app.whenReady().then(() => {
  startServer();
  setTimeout(createMainWindow, 600);
});

app.on('window-all-closed', () => {
  stopPlayback();
  app.quit();
});

app.on('before-quit', () => {
  stopPlayback();
});

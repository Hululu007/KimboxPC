const { contextBridge, ipcRenderer } = require('electron');

/**
 * 暴露给网页的最小 API（contextIsolation 下唯一通道）
 * 网页检测到 window.kimbox 存在时，说明跑在 Electron 桌面壳里，
 * 播放走「libmpv 原生渲染 + canvas」，而不是浏览器 MSE。
 */
contextBridge.exposeInMainWorld('kimbox', {
  isElectron: true,
  info: () => ipcRenderer.invoke('shell:info'),
  quit: () => ipcRenderer.invoke('shell:quit'),

  // 播放控制
  open: (payload) => ipcRenderer.invoke('mpv:open', payload),
  cmd: (name, args) => ipcRenderer.invoke('mpv:cmd', { name, args }),
  state: () => ipcRenderer.invoke('mpv:state'),
  stop: () => ipcRenderer.invoke('mpv:stop'),
  resize: (width, height) => ipcRenderer.invoke('mpv:resize', { width, height }),

  // 全屏
  setFullscreen: (on) => ipcRenderer.invoke('shell:fullscreen', { on }),
  isFullscreen: () => ipcRenderer.invoke('shell:isfullscreen'),

  // 全屏状态变化（含系统 Esc 触发）
  onFullscreenChange: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('shell:fullscreen-changed', handler);
    return () => ipcRenderer.removeListener('shell:fullscreen-changed', handler);
  },

  // 摸鱼键 (Boss Key)
  getBossKey: () => ipcRenderer.invoke('shell:getBossKey'),
  setBossKey: (accelerator, enabled) => ipcRenderer.invoke('shell:setBossKey', { accelerator, enabled }),
  setBossKeyEnabled: (enabled) => ipcRenderer.invoke('shell:setBossKeyEnabled', { enabled }),
  triggerBossKey: () => ipcRenderer.invoke('shell:triggerBossKey'),
  onBossKeyPause: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('boss-key:pause', handler);
    return () => ipcRenderer.removeListener('boss-key:pause', handler);
  },
  onBossKeyWake: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('boss-key:wake', handler);
    return () => ipcRenderer.removeListener('boss-key:wake', handler);
  },

  // 缓存清理 (仅限 %APPDATA%\KimBoxPC 临时图片与运行缓存)
  getCacheInfo: () => ipcRenderer.invoke('shell:getCacheInfo'),
  cleanCache: () => ipcRenderer.invoke('shell:cleanCache'),

  // 字幕 / 音轨
  tracks: () => ipcRenderer.invoke('mpv:tracks'),
  setTrack: (kind, id) => ipcRenderer.invoke('mpv:setTrack', { kind, id }),
  pickSubtitle: () => ipcRenderer.invoke('mpv:pickSubtitle'),

  // 视频帧订阅（回调收到 { data: Buffer, width, height }）
  onFrame: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('mpv:frame', handler);
    return () => ipcRenderer.removeListener('mpv:frame', handler);
  }
});

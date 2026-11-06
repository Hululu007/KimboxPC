const { contextBridge, ipcRenderer } = require('electron');

/**
 * 暴露给网页的最小 API（contextIsolation 下唯一通道）
 * 网页检测到 window.kimbox 存在时，说明跑在 Electron 桌面壳里，
 * 播放走「libmpv 原生渲染 + canvas」，而不是浏览器 MSE。
 */
contextBridge.exposeInMainWorld('kimbox', {
  isElectron: true,
  info: () => ipcRenderer.invoke('shell:info'),

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

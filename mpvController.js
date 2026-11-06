const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

/**
 * mpv 控制器：启动常驻 mpv（--idle），通过命名管道 IPC 控制播放。
 * 这样解码全部由 mpv（ffmpeg 系）完成，规避浏览器 MSE 的音频异常问题。
 */

const PIPE = '\\\\.\\pipe\\kimbox-mpv';

function findMpv() {
  const cands = [
    path.join(__dirname, 'mpv', 'mpv.exe'),
    path.join(__dirname, 'bin', 'mpv.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'mpv.exe'),
    'C:\\Program Files\\mpv\\mpv.exe'
  ];
  for (const c of cands) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

const state = {
  proc: null,
  socket: null,
  connecting: null,
  ready: false,
  lastError: ''
};

function send(command, timeout = 2500) {
  return new Promise((resolve, reject) => {
    if (!state.socket || state.socket.destroyed) return reject(new Error('mpv 未连接'));
    const reqId = Math.floor(Math.random() * 1e9);
    let buf = '';
    let done = false;

    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg.request_id === reqId && !done) {
          done = true;
          cleanup();
          if (msg.error && msg.error !== 'success') reject(new Error(msg.error));
          else resolve(msg.data);
        }
      }
    };
    const cleanup = () => {
      state.socket.off('data', onData);
      clearTimeout(timer);
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('mpv 命令超时'));
    }, timeout);

    state.socket.on('data', onData);
    state.socket.write(JSON.stringify({ command, request_id: reqId }) + '\n');
  });
}

function connect() {
  if (state.socket && !state.socket.destroyed) return Promise.resolve();
  if (state.connecting) return state.connecting;

  state.connecting = new Promise((resolve, reject) => {
    const sock = net.connect(PIPE);
    const onErr = (e) => {
      state.connecting = null;
      try { sock.destroy(); } catch (er) {}
      reject(e);
    };
    sock.once('error', onErr);
    sock.once('connect', () => {
      sock.off('error', onErr);
      sock.on('error', () => { state.ready = false; });
      sock.on('close', () => { state.ready = false; state.socket = null; });
      state.socket = sock;
      state.ready = true;
      state.connecting = null;
      resolve();
    });
  });
  return state.connecting;
}

async function ensureRunning() {
  if (state.proc && !state.proc.killed) {
    try { await connect(); return true; } catch (e) {}
  }
  const exe = findMpv();
  if (!exe) throw new Error('未找到 mpv.exe（请放到 mpv\\mpv.exe）');

  state.proc = spawn(exe, [
    '--idle=yes',
    '--force-window=yes',
    '--keep-open=yes',
    '--no-terminal',
    '--osc=yes',
    '--input-ipc-server=' + PIPE,
    '--title=KimBoxPC',
    '--hwdec=auto-safe',
    '--cache=yes',
    '--demuxer-max-bytes=256MiB'
  ], { windowsHide: false, stdio: 'ignore' });

  state.proc.on('exit', () => {
    state.proc = null;
    state.ready = false;
    if (state.socket) { try { state.socket.destroy(); } catch (e) {} state.socket = null; }
  });

  // 等待管道可用
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 250));
    if (!state.proc) break;
    try { await connect(); return true; } catch (e) { /* 继续等 */ }
  }
  throw new Error('mpv 启动失败或 IPC 连接超时');
}

async function load(url, title, startAt = 0) {
  await ensureRunning();
  try { await send(['set_property', 'force-window', true]); } catch (e) {}
  if (title) { try { await send(['set_property', 'title', 'KimBoxPC - ' + title]); } catch (e) {} }

  const opts = {};
  if (Number(startAt) > 0) opts['start'] = '+' + Math.floor(startAt);

  await send(['loadfile', url, 'replace', Object.keys(opts).length ? opts : undefined].filter(v => v !== undefined));
  try { await send(['set_property', 'pause', false]); } catch (e) {}
  return { ok: true };
}

async function getState() {
  if (!state.ready) return { running: !!(state.proc && !state.proc.killed), connected: false };
  const read = async (prop) => {
    try { return await send(['get_property', prop], 1200); } catch (e) { return null; }
  };
  const [pos, dur, paused, title, idle, path] = await Promise.all([
    read('time-pos'), read('duration'), read('pause'),
    read('media-title'), read('idle-active'), read('path')
  ]);
  return {
    running: true,
    connected: true,
    position: pos === null ? 0 : pos,
    duration: dur === null ? 0 : dur,
    paused: !!paused,
    idle: !!idle,
    title: title || '',
    file: path || ''
  };
}

async function command(name, args = []) {
  await ensureRunning();
  return send([name, ...args]);
}

function stop() {
  if (state.socket) { try { state.socket.destroy(); } catch (e) {} state.socket = null; }
  if (state.proc) { try { state.proc.kill(); } catch (e) {} state.proc = null; }
  state.ready = false;
}

module.exports = { findMpv, ensureRunning, load, getState, command, stop, PIPE };

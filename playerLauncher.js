const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const LOCAL = process.env.LOCALAPPDATA || '';
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

/**
 * 外部播放器候选列表，按优先级排序：
 * 优先「带完整界面」的播放器，ffplay 放最后（它没有控制条，只能键盘操作）
 */
const CANDIDATES = [
  {
    id: 'potplayer',
    name: 'PotPlayer',
    friendly: 'PotPlayer（完整界面）',
    hasUi: true,
    exeName: 'PotPlayerMini64',
    paths: [
      `${PF}\\DAUM\\PotPlayer\\PotPlayerMini64.exe`,
      `${PF86}\\DAUM\\PotPlayer\\PotPlayerMini.exe`,
      `${PF}\\DAUM\\PotPlayer\\PotPlayerMini.exe`
    ],
    build: (exe, url, title, startAt) => {
      const args = [url];
      if (startAt && startAt > 0) args.push(`/seek=${Math.floor(startAt)}`);
      return { cmd: exe, args };
    }
  },
  {
    id: 'vlc',
    name: 'VLC',
    friendly: 'VLC（完整界面）',
    hasUi: true,
    exeName: 'vlc',
    paths: [
      `${PF}\\VideoLAN\\VLC\\vlc.exe`,
      `${PF86}\\VideoLAN\\VLC\\vlc.exe`
    ],
    build: (exe, url, title, startAt) => {
      const args = ['--started-from-file', url];
      if (startAt && startAt > 0) args.push(`--start-time=${Math.floor(startAt)}`);
      return { cmd: exe, args };
    }
  },
  {
    id: 'mpv',
    name: 'mpv',
    friendly: 'mpv（鼠标移动显示控制条）',
    hasUi: true,
    exeName: 'mpv',
    paths: [
      `${LOCAL}\\Microsoft\\WinGet\\Links\\mpv.exe`,
      `${PF}\\mpv\\mpv.exe`,
      `${PF86}\\mpv\\mpv.exe`
    ],
    build: (exe, url, title, startAt) => {
      const args = ['--force-window=yes', '--osc=yes', `--title=${title}`];
      if (startAt && startAt > 0) args.push(`--start=${Math.floor(startAt)}`);
      args.push(url);
      return { cmd: exe, args };
    }
  },
  {
    id: 'mpc-hc',
    name: 'MPC-HC',
    friendly: 'MPC-HC（完整界面）',
    hasUi: true,
    exeName: 'mpc-hc64',
    paths: [
      `${PF}\\MPC-HC\\mpc-hc64.exe`,
      `${PF86}\\MPC-HC\\mpc-hc.exe`
    ],
    build: (exe, url, title, startAt) => {
      const args = [url];
      if (startAt && startAt > 0) args.push('/start', `${Math.floor(startAt * 1000)}`);
      return { cmd: exe, args };
    }
  },
  {
    id: 'ffplay',
    name: 'ffplay',
    friendly: 'ffplay（无界面，键盘控制）',
    hasUi: false,
    exeName: 'ffplay',
    paths: [
      `${LOCAL}\\Microsoft\\WinGet\\Links\\ffplay.exe`
    ],
    build: (exe, url, title, startAt) => {
      const args = ['-window_title', `KimBoxPC - ${title}`, '-autoexit'];
      if (startAt && startAt > 0) args.push('-ss', String(Math.floor(startAt)));
      args.push(url);
      return { cmd: exe, args };
    }
  }
];

function findInPath(exeName) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of ['.exe', '.bat', '.cmd', '']) {
      const full = path.join(dir, exeName + ext);
      // 必须确认是文件：PATH 里若有同名目录（例如叫 mpv 的文件夹），existsSync 也会为真，启动时才失败
      try { if (fs.statSync(full).isFile()) return full; } catch (e) {}
    }
  }
  return null;
}

function resolveExe(c) {
  for (const p of c.paths || []) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) {}
  }
  if (c.exeName) return findInPath(c.exeName);
  return null;
}

/** 返回已安装的播放器列表（按优先级） */
function listAvailable() {
  const out = [];
  for (const c of CANDIDATES) {
    const exe = resolveExe(c);
    if (exe) out.push({ id: c.id, name: c.name, friendly: c.friendly, hasUi: c.hasUi, exe });
  }
  return out;
}

function launch(entry, url, title, startAt) {
  return new Promise((resolve, reject) => {
    const { cmd, args } = entry.data.build(entry.exe, url, title, startAt);
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    let settled = false;

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    child.on('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve({ player: entry.name, hasUi: entry.data.hasUi });
    });
  });
}

/**
 * 播放：playerId 为空则自动选择（优先带界面的）
 */
async function play(mediaUrl, title = 'TVBox 视频', playerId = '', startAt = 0) {
  const available = listAvailable();
  if (available.length === 0) {
    throw new Error('没有找到可用的外部播放器（可以装 PotPlayer / VLC / mpv）');
  }

  // 排好序：只在这个播放器上尝试；留空则按优先级依次尝试
  let queue;
  if (playerId) {
    const idx = available.findIndex(p => p.id === playerId);
    if (idx === -1) throw new Error(`未安装播放器: ${playerId}`);
    queue = [available[idx], ...available.slice(0, idx), ...available.slice(idx + 1)];
  } else {
    queue = available;
  }

  const errors = [];
  for (const p of queue) {
    const data = CANDIDATES.find(c => c.id === p.id);
    try {
      const r = await launch({ exe: p.exe, name: p.name, data }, mediaUrl, title, startAt);
      return { success: true, ...r };
    } catch (e) {
      errors.push(`${p.name}: ${e.message}`);
    }
  }
  throw new Error('启动播放器失败 -> ' + errors.join(' | '));
}

module.exports = { play, listAvailable, CANDIDATES };

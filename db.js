const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'tvbox.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

let db = null;

function openDb() {
  db = new DatabaseSync(DB_PATH);
  db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS config (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    url          TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL DEFAULT 0,
    default_site TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS history (
    site_key   TEXT NOT NULL,
    vod_id     TEXT NOT NULL,
    vod_name   TEXT,
    vod_pic    TEXT,
    source     TEXT,
    ep_name    TEXT,
    ep_index   INTEGER NOT NULL DEFAULT 0,
    ep_url     TEXT,
    position   REAL NOT NULL DEFAULT 0,
    duration   REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (site_key, vod_id)
  );


  -- 按片名记住「片头 / 片尾」长度：做一次，该片所有集数通用
  CREATE TABLE IF NOT EXISTS show_mark (
    show_key   TEXT PRIMARY KEY,
    show_name  TEXT,
    intro      REAL NOT NULL DEFAULT 0,
    outro      REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS favorite (
    site_key   TEXT NOT NULL,
    vod_id     TEXT NOT NULL,
    vod_name   TEXT,
    vod_pic    TEXT,
    remarks    TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (site_key, vod_id)
  );

  CREATE INDEX IF NOT EXISTS idx_history_time ON history(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_favorite_time ON favorite(created_at DESC);
  `);
}

// 旧库迁移：补齐后加的列
function migrate() {
  try {
    const cols = db.prepare('PRAGMA table_info(config)').all().map(c => c.name);
    if (!cols.includes('default_site')) {
      db.exec("ALTER TABLE config ADD COLUMN default_site TEXT NOT NULL DEFAULT ''");
    }
  } catch (e) {}
}

openDb();
migrate();
// 清理已废弃的分集进度表（此前短暂使用过）
try { db.exec('DROP TABLE IF EXISTS episode_history'); } catch (e) {}

const now = () => Date.now();

/* ---------- 配置源 ---------- */
const ConfigRepo = {
  list() {
    return db.prepare('SELECT * FROM config ORDER BY last_used_at DESC, id ASC').all();
  },
  get(id) {
    return db.prepare('SELECT * FROM config WHERE id = ?').get(id);
  },
  getByUrl(url) {
    return db.prepare('SELECT * FROM config WHERE url = ?').get(url);
  },
  add(url, name) {
    const exist = this.getByUrl(url);
    if (exist) return exist;
    const info = db.prepare('INSERT INTO config (url, name, created_at, last_used_at) VALUES (?, ?, ?, ?)')
      .run(url, name || '', now(), 0);
    return this.get(Number(info.lastInsertRowid));
  },
  touch(id) {
    db.prepare('UPDATE config SET last_used_at = ? WHERE id = ?').run(now(), id);
  },
  rename(id, name) {
    db.prepare('UPDATE config SET name = ? WHERE id = ?').run(name, id);
    return this.get(id);
  },
  remove(id) {
    db.prepare('DELETE FROM config WHERE id = ?').run(id);
  },
  setDefaultSite(id, siteKey) {
    db.prepare('UPDATE config SET default_site = ? WHERE id = ?').run(siteKey || '', id);
    return this.get(id);
  },
  clear() {
    db.prepare('DELETE FROM config').run();
  }
};

/* ---------- 播放历史 ---------- */
const HistoryRepo = {
  list(limit = 100) {
    return db.prepare('SELECT * FROM history ORDER BY updated_at DESC LIMIT ?').all(limit);
  },
  get(siteKey, vodId) {
    return db.prepare('SELECT * FROM history WHERE site_key = ? AND vod_id = ?').get(siteKey, vodId);
  },
  save(h) {
    db.prepare(`
      INSERT INTO history (site_key, vod_id, vod_name, vod_pic, source, ep_name, ep_index, ep_url, position, duration, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(site_key, vod_id) DO UPDATE SET
        vod_name = excluded.vod_name,
        vod_pic  = excluded.vod_pic,
        source   = excluded.source,
        ep_name  = excluded.ep_name,
        ep_index = excluded.ep_index,
        ep_url   = excluded.ep_url,
        position = excluded.position,
        duration = excluded.duration,
        updated_at = excluded.updated_at
    `).run(
      h.siteKey, String(h.vodId), h.vodName || '', h.vodPic || '',
      h.source || '', h.epName || '', Number(h.epIndex || 0), h.epUrl || '',
      Number(h.position || 0), Number(h.duration || 0), now()
    );
  },
  remove(siteKey, vodId) {
    db.prepare('DELETE FROM history WHERE site_key = ? AND vod_id = ?').run(siteKey, vodId);
  },
  clear() {
    db.prepare('DELETE FROM history').run();

  }
};

/* ---------- 收藏 ---------- */
/* ---------- 片头 / 片尾标记（按片名） ---------- */
const ShowMarkRepo = {
  key(name) {
    return String(name || '')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/[\s·・,，.。:：!！?？'"“”()（）\[\]【】\-—_]/g, '')
      .toLowerCase();
  },
  get(name) {
    const k = this.key(name);
    if (!k) return null;
    const row = db.prepare('SELECT * FROM show_mark WHERE show_key = ?').get(k);
    return row || null;
  },
  save(name, intro, outro) {
    const k = this.key(name);
    if (!k) return null;
    const now = Date.now();
    const exist = db.prepare('SELECT * FROM show_mark WHERE show_key = ?').get(k);
    if (exist) {
      db.prepare('UPDATE show_mark SET intro = ?, outro = ?, show_name = ?, updated_at = ? WHERE show_key = ?')
        .run(intro, outro, name, now, k);
    } else {
      db.prepare('INSERT INTO show_mark (show_key, show_name, intro, outro, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(k, name, intro, outro, now);
    }
    return this.get(name);
  },
  remove(name) {
    const k = this.key(name);
    if (!k) return false;
    db.prepare('DELETE FROM show_mark WHERE show_key = ?').run(k);
    return true;
  },
  list() {
    return db.prepare('SELECT * FROM show_mark ORDER BY updated_at DESC').all();
  }
};

const FavoriteRepo = {
  list() {
    return db.prepare('SELECT * FROM favorite ORDER BY created_at DESC').all();
  },
  has(siteKey, vodId) {
    return !!db.prepare('SELECT 1 FROM favorite WHERE site_key = ? AND vod_id = ?').get(siteKey, vodId);
  },
  add(f) {
    db.prepare('INSERT OR REPLACE INTO favorite (site_key, vod_id, vod_name, vod_pic, remarks, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.siteKey, String(f.vodId), f.vodName || '', f.vodPic || '', f.remarks || '', now());
  },
  remove(siteKey, vodId) {
    db.prepare('DELETE FROM favorite WHERE site_key = ? AND vod_id = ?').run(siteKey, vodId);
  },
  toggle(f) {
    if (this.has(f.siteKey, f.vodId)) {
      this.remove(f.siteKey, f.vodId);
      return false;
    }
    this.add(f);
    return true;
  },
  clear() {
    db.prepare('DELETE FROM favorite').run();
  }
};


/* ---------- 备份 ---------- */

const AUTO_KEEP = 5;   // 自动备份只保留最新 5 份

function countAll() {
  const c = db.prepare('SELECT COUNT(*) c FROM config').get().c;
  const f = db.prepare('SELECT COUNT(*) c FROM favorite').get().c;
  const h = db.prepare('SELECT COUNT(*) c FROM history').get().c;
  return { config: c, favorite: f, history: h };
}

function stamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** 只清理「自动备份」，手动备份永不自动删除（按修改时间排序，不能按文件名） */
function pruneAuto() {
  try {
    const autos = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.endsWith('.db') && !f.startsWith('tvbox-manual-'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);      // 旧 → 新

    while (autos.length > AUTO_KEEP) {
      const victim = autos.shift().name;
      try { fs.unlinkSync(path.join(BACKUP_DIR, victim)); } catch (e) {}
    }
  } catch (e) {}
}

/**
 * 备份数据库（VACUUM INTO，生成一致性快照）
 * @param {string} label  手动备份传 'manual'，其余均视为自动备份
 */
function backup(label = 'auto') {
  invalidateBackupsCache();
  try {
    const stats = countAll();
    if (stats.config + stats.favorite + stats.history === 0) {
      return { skipped: true, reason: 'empty' };
    }
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const isManual = label === 'manual';
    const file = path.join(BACKUP_DIR, `tvbox-${isManual ? 'manual' : 'auto-' + label}-${stamp()}.db`);

    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    if (!isManual) pruneAuto();

    return { file: path.basename(file), stats, manual: isManual };
  } catch (e) {
    return { error: e.message };
  }
}

let backupsCache = { at: 0, list: [] };
function invalidateBackupsCache() { backupsCache.at = 0; }
function listBackups() {
  // 备份目录只在本程序内变化：2 秒 TTL，避免状态面板轮询时反复 readdir+stat
  if (Date.now() - backupsCache.at < 2000) return backupsCache.list;
  if (!fs.existsSync(BACKUP_DIR)) return [];
  const list = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.db'))
    .map(f => {
      const full = path.join(BACKUP_DIR, f);
      const st = fs.statSync(full);
      return {
        name: f,
        size: st.size,
        time: st.mtime.toISOString(),
        mtime: st.mtimeMs,
        manual: f.startsWith('tvbox-manual-')
      };
    })
    .sort((a, b) => b.mtime - a.mtime)      // 新的在前
    .map(({ mtime, ...rest }) => rest);
  backupsCache = { at: Date.now(), list };
  return list;
}

/** 校验备份文件名，防目录穿越 */
function safeBackupPath(name) {
  if (!/^tvbox-[A-Za-z0-9._-]+\.db$/.test(name)) throw new Error('非法的备份文件名');
  const full = path.join(BACKUP_DIR, name);
  if (path.dirname(full) !== BACKUP_DIR) throw new Error('非法的备份路径');
  if (!fs.existsSync(full)) throw new Error('备份文件不存在: ' + name);
  return full;
}

function deleteBackup(name) {
  invalidateBackupsCache();
  const full = safeBackupPath(name);
  fs.unlinkSync(full);
  return { deleted: name };
}

/**
 * 从备份还原：关闭连接 → 覆盖主库 → 清理 WAL → 重新打开
 * 调用方需要在还原前先做一次安全备份
 */
function restoreBackup(name) {
  invalidateBackupsCache();
  const full = safeBackupPath(name);

  // 先做一次「还原前」自动备份，防止还原错了还能回退
  try { backup('before-restore'); } catch (e) {}

  // 关闭连接并把 WAL 落盘，避免拷贝到半截数据
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
  try { db.close(); } catch (e) {}
  db = null;

  for (const suffix of ['-wal', '-shm']) {
    const f = DB_PATH + suffix;
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
  }
  fs.copyFileSync(full, DB_PATH);

  openDb();
  migrate();
  return { restored: name, stats: countAll() };
}

module.exports = {
  db, ConfigRepo, HistoryRepo, FavoriteRepo,
  ShowMarkRepo,
  backup, listBackups, deleteBackup, restoreBackup, countAll
};

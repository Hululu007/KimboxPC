const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'tvbox.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS config (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    url          TEXT NOT NULL UNIQUE,
    name         TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL DEFAULT 0
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

const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function countAll() {
  const c = db.prepare('SELECT COUNT(*) c FROM config').get().c;
  const f = db.prepare('SELECT COUNT(*) c FROM favorite').get().c;
  const h = db.prepare('SELECT COUNT(*) c FROM history').get().c;
  return { config: c, favorite: f, history: h };
}

/**
 * 备份数据库（VACUUM INTO，生成一致性快照）
 * 空库不备份；最多保留 20 份
 */
function backup(label = 'auto') {
  try {
    const stats = countAll();
    if (stats.config + stats.favorite + stats.history === 0) {
      return { skipped: true, reason: 'empty' };
    }
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const file = path.join(BACKUP_DIR, `tvbox-${label}-${ts}.db`);

    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);

    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.db')).sort();
    while (files.length > 20) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, files.shift())); } catch (e) {}
    }
    return { file: path.basename(file), stats };
  } catch (e) {
    return { error: e.message };
  }
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.db'))
    .sort()
    .reverse()
    .map(f => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, size: st.size, time: st.mtime.toISOString() };
    });
}

module.exports = { db, ConfigRepo, HistoryRepo, FavoriteRepo, backup, listBackups };

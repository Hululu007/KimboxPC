# TVBox PC 版 (轻量复刻版)

基于 **FongMi / TVBox** 核心协议理念打造的 Windows PC 桌面端影音播放客户端。

> 版本变更记录见 [更新.md](更新.md)。

已剔除在 PC 端冗余的特性（弹幕、DLNA 投屏、局域网同步、复杂后台下载），专注于：**多配置源管理 ➔ 快速搜索与浏览 ➔ 线路选集 ➔ 本地高清播放 ➔ 收藏与续播**。

---

## 🎯 核心特性

- **多配置源**：可保存任意多个 TVBox / FongMi 配置地址，随时切换；启动时自动恢复上次使用的源。
- **协议兼容**：支持标准 JSON、带 `**` 分隔的 Base64、加密配置解析。
- **采集引擎**：兼容苹果 CMS 等通用采集接口，支持分类浏览、关键词搜索、多线路切换、选集、无限滚动分页。
- **跨站聚合搜索**：搜索框左侧可切换「本站 / 全站」，全站模式并发查询所有可用站点（27 站约 3~6 秒），同名影片自动去重并标注来源数与所属站点；点开任意结果会自动切到该站点。
- **收藏与历史（SQLite）**：收藏、播放进度、续播全部落库，重开即接上次进度。
- **双模播放**：
  - 内置 HLS.js，网页内直接播放 `.m3u8`（自带播放/进度/音量/倍速/全屏控制条）；
  - 一键外调本地播放器：自动检测并按优先级选用 **PotPlayer → VLC → mpv → MPC-HC → ffplay**，优先选带界面的；播放器可在按钮左侧下拉框切换，选择会被记住。

> ⚠️ ffplay 是命令行播放器，**没有控制条**，只能键盘操作：`空格` 暂停、`←/→` 快退快进、`f` 全屏、`q` 退出。所以它排在候选最后，仅在没装其它播放器时兜底。
- **剧场式播放页**：视频铺满，控制条贴画面下方（播放 / 进度 / 音量 / 倍速 / 全屏），选集面板可折叠，全屏下控制条自动隐藏。

---

## 📦 运行需要什么

| 项目 | 是否必需 | 说明 |
|---|---|---|
| **Node.js 22.5+**（推荐 24） | ✅ 必需 | 唯一需要手动安装的东西，[nodejs.org](https://nodejs.org) 下载 LTS 版即可；内置 `node:sqlite` 依赖 22.5 以上 |
| npm 依赖（express / axios / cors） | ⚪ 自动 | 首次双击 `start.bat` 会自动 `npm install`（需联网一次），之后离线可跑 |
| hls.js | ⚪ 已内置 | 已放在 `public/vendor/hls.min.js`，不再依赖 CDN |
| ffplay / mpv / PotPlayer / VLC | 🔵 可选 | 只有点「用 PC 播放器播放」时才需要；没有也不影响网页内播放 |
| Python / Java / Android SDK | ❌ 不需要 | 本项目纯 Node 实现 |

**也就是说：装好 Node.js 之后，双击 `start.bat` 就能跑。**

`start.bat` 启动时会自动检查：Node 是否存在 → 版本是否 ≥ 22.5 → `node:sqlite` 是否可用 → `node_modules` 是否存在（缺失则自动安装）。任何一步失败都会给出中文提示，不会一闪而过。

也可以命令行启动：

```bash
npm install        # 仅首次
npm start          # 或 node server.js
set PORT=8080 && node server.js   # 自定义端口（默认 3980）
```

> 想把整个目录拷到别的电脑：连 `node_modules` 一起复制就不用再联网安装（约 5.7 MB），只要那台机器有 Node.js。

---

## 🚀 启动与使用

1. 双击运行 **`start.bat`**。
2. 浏览器自动打开 `http://127.0.0.1:3980`。
3. 点顶部 **「＋ 添加」** 粘贴配置源地址（如 `https://ok.4247701.xyz/my.json`），之后可在下拉框随时切换。
4. 顶部标签栏：**首页推荐 / ⭐收藏 / 🕘历史 / 各分类**。

### 停止服务

- **关掉 `start.bat` 的黑色窗口** = 停止服务（服务会监控父窗口，3 秒内自动退出）；
- 或者双击 **`stop.bat`**，按 `data/.server.pid` 精确结束进程；
- 停止后 `data/tvbox.db` 才会解锁，**压缩备份前必须先停服务**。

> 若 `start.bat` 提示「已有一个服务在后台运行」，选 `Y` 可以直接结束旧进程并重启。

---

## 🗄️ 数据存储

采用 **SQLite**（Node 内置 `node:sqlite`，无需安装任何原生模块），数据库文件：

```
data/tvbox.db        主库（配置源、收藏、历史）
data/tvbox.db-wal    预写日志
data/tvbox.db-shm    共享内存索引
data/backups/        自动备份（最多 20 份）
```

### 自动备份

以下时机会自动生成 `data/backups/tvbox-<原因>-<时间>.db` 快照：

| 时机 | 文件名标记 |
|---|---|
| 每次启动（库非空时） | `startup` |
| 清空收藏前 | `before-clear-favorites` |
| 清空历史前 | `before-clear-history` |
| 执行「初始化」前 | `before-reset` |
| 手动 `POST /api/backup` | `manual` |

**误删后的恢复方法**（停服操作）：

```powershell
cd D:\Projects\tvbox-pc
Get-Process node | Stop-Process          # 1. 停止服务
copy data\backups\tvbox-before-clear-favorites-20261105-234043.db data\tvbox.db  # 2. 覆盖
Remove-Item data\tvbox.db-wal, data\tvbox.db-shm -ErrorAction SilentlyContinue     # 3. 清掉 WAL
node server.js                            # 4. 重新启动
```

### 表结构

| 表 | 主键 | 用途 |
|---|---|---|
| `config` | `id` | 配置源地址、名称、最后使用时间 |
| `favorite` | `(site_key, vod_id)` | 收藏，按站点去重 |
| `history` | `(site_key, vod_id)` | 播放进度，同一部片重复播放自动 upsert |

> 备份/迁移只需复制 `data/` 目录；清空观看记录可在界面上删除单条，或停服后删除 `data/tvbox.db*`。

---

## 🔌 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/configs` | 配置源列表 |
| POST | `/api/configs` | 添加配置源 `{url}` |
| POST | `/api/configs/:id/activate` | 切换配置源 |
| DELETE | `/api/configs/:id` | 删除配置源 |
| GET | `/api/home` `/api/category` `/api/detail` `/api/search` | 影视数据 |
| GET/POST/DELETE | `/api/history` | 播放历史 |
| GET/POST | `/api/favorites`、`/api/favorites/toggle` | 收藏 |
| POST | `/api/play/external` | 唤起本地播放器 |

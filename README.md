# KimBoxPC 版 (轻量复刻版)

基于 **FongMi / TVBox** 核心协议理念打造的 Windows PC 桌面端影音播放客户端。

> 版本变更记录见 [更新.md](更新.md)。

**当前版本：v1.5.0**（显示在界面右上角，来源为 `package.json` 的 `version` 字段）

> 发版约定：每次改动都在 `更新.md` 顶部新增条目，并同步修改 `package.json` 的 `version`；
> 界面右上角的版本号与 `GET /api/version` 会自动跟随，无需改前端。

已剔除在 PC 端冗余的特性（弹幕、DLNA 投屏、局域网同步、复杂后台下载），专注于：**多配置源管理 ➔ 快速搜索与浏览 ➔ 线路选集 ➔ 本地高清播放 ➔ 收藏与续播**。

---

> **`ffmpeg/` 是刻意保留的备用件，请勿删除。**
> 它承担两个用途：① 浏览器版的「兼容模式」（服务端转封装，修复时间戳重置导致的音频异常）；
> ② mpv 内核出问题时的兜底方案。桌面版主用 mpv 时用不到它，但删掉会失去兜底能力。
## 启动方式

**只有一种：桌面版**（生产环境）。

| 入口 | 说明 |
|---|---|
| `KimBoxPC 桌面版.lnk` | 首选，带自定义图标，不弹黑框 |
| `KimBoxPC-桌面版.bat` | 同一程序的命令行入口，排查问题时用 |

- 界面窗口 = Electron 独立窗口（Electron 内置 Node 24，无需另装 Node.js）
- 播放内核 = **libmpv 原生渲染**（画面经内存缓冲送到页面 `<canvas>`，不是独立播放器窗口）
- 音频由 libmpv 直接输出，**完全绕开浏览器 MSE**，不会出现变调/发闷
- 依赖：`node_modules/electron`、`native/lib/libmpv-2.dll`、`native/build/Release/mpv_native.node`
- 重新编译原生模块（Electron 升级后需要，**不需要装 Node.js**）：

```bat
tools\编译原生模块.bat
```

> 原理：设置 `ELECTRON_RUN_AS_NODE=1` 后用 `electron.exe` 直接跑 `node-gyp`，
> 因此无需另装 Node.js（仍需 Visual Studio C++ 生成工具与 Python 提供编译器）。

- 启动器会在原生模块缺失时自动用同样方式编译

## 🎯 核心特性

- **多配置源**：可保存任意多个 TVBox / FongMi 配置地址，随时切换；启动时自动恢复上次使用的源。
- **协议兼容**：支持标准 JSON、带 `**` 分隔的 Base64、加密配置解析。
- **采集引擎**：兼容苹果 CMS 等通用采集接口，支持分类浏览、关键词搜索、多线路切换、选集、无限滚动分页。
- **跨站聚合搜索**：搜索框左侧可切换「本站 / 全站」，全站模式并发查询所有可用站点（27 站约 3~6 秒），同名影片自动去重并标注来源数与所属站点；点开任意结果会自动切到该站点。
- **收藏与历史（SQLite）**：收藏、播放进度、续播全部落库，重开即接上次进度。
- **播放引擎**：桌面版用 mpv 内核（声音最稳、秒拖）/ 浏览器（备用）；浏览器版固定用内置引擎（含服务端转封装）；两者都可一键外调 PC 播放器
- **双模播放**：
  - 内置 HLS.js，网页内直接播放 `.m3u8`（自带播放/进度/音量/倍速/全屏控制条）；
  - 一键外调本地播放器：自动检测并按优先级选用 **PotPlayer → VLC → mpv → MPC-HC → ffplay**，优先选带界面的；播放器可在按钮左侧下拉框切换，选择会被记住。

> ⚠️ ffplay 是命令行播放器，**没有控制条**，只能键盘操作：`空格` 暂停、`←/→` 快退快进、`f` 全屏、`q` 退出。所以它排在候选最后，仅在没装其它播放器时兜底。
- **剧场式播放页**：视频铺满，控制条贴画面下方（播放 / 进度 / 音量 / 倍速 / 全屏），选集面板可折叠，全屏下控制条自动隐藏。

---

## 📦 运行需要什么

**桌面版是免安装的**：把整个目录拷到任意 Windows 电脑，双击 `KimBoxPC 桌面版.lnk` 即可，
**不需要装 Node.js**（Electron 内置 Node 24.22.2）。

| 项目 | 是否必需 | 说明 |
|---|---|---|
| **Electron 运行库** | ✅ 必需 | `node_modules\electron\`（约 358 MB），已随项目提供 |
| **libmpv 原生模块** | ✅ 必需 | `native\lib\libmpv-2.dll` + `native\build\Release\mpv_native.node`（约 116 MB） |
| **随附 ffmpeg** | ⚪ 备用 | `ffmpeg\ffmpeg.exe`（约 100 MB）；「兼容模式」转封装用，缺失时回退系统 ffmpeg |
| Node.js（系统安装） | ❌ 不需要 | 编译原生模块也走 Electron 内置 Node（`tools/编译原生模块.bat`） |
| hls.js / mpegts.js | ⚪ 已内置 | 放在 `public/vendor/`，不依赖 CDN |
| PotPlayer / VLC / mpv | 🔵 可选 | 只有点「用 PC 播放器播放」时才需要；没有也不影响应用内播放 |
| Python / Java / Android SDK | ❌ 不需要 | 本项目纯 Node + 原生模块实现 |

---


---

## 🎒 便携部署

整个目录就是绿色版，**复制到任何位置都能直接用**（已实测含空格与中文的路径，如 `D:\我的 工具\tvbox-pc`）：

- 必须一起带走：`node_modules/`（含 electron）、`native/`（libmpv + 原生模块）、`public/`、所有 `.js`、`electron/`、`icon.ico`、`KimBoxPC-桌面版.bat`
- 备用件：`ffmpeg/`（兼容模式转封装用，约 100 MB）
- 可选：`data/`（配置源、收藏、观看记录——想保留就从旧目录拷过来）
- 不需要：`.git/`
- 目标机器**无需安装 Node.js**（Electron 内置 Node 24），也无需管理员权限

复制后双击 `KimBoxPC-桌面版.bat`（或重建的快捷方式）即可，`data/` 会在新位置自动重建。

> 换机器后快捷方式里的绝对路径会失效，双击 **`创建快捷方式.bat`** 重建一次即可。

---

## 🚀 启动与使用

1. 双击 **`KimBoxPC 桌面版.lnk`**（或 `KimBoxPC-桌面版.bat`）。
2. 应用窗口打开，界面即主页面。
3. 点顶部 **「＋ 添加」** 粘贴配置源地址，之后可在下拉框随时切换。
4. 顶部标签栏：**首页推荐 / ⭐收藏 / 🕘历史 / 各分类**。
5. 播放页默认用 **mpv 内核**；遇到问题可在面板里切「浏览器（备用）」。

### 退出

- 关闭应用窗口即退出（mpv 进程会一并结束）。
- 若异常残留，在任务管理器结束 `electron.exe` / `mpv.exe` 即可。

### 换端口（端口冲突时）

编辑项目根目录的 **`port.txt`**，改成一个没被占用的数字即可，例如：

```
8099
```

然后重新打开应用即可（桌面版会读取 `port.txt`，界面地址随之改变）。

优先级：**环境变量 `PORT` > `port.txt` > 默认 3980**。

> 只有一行数字，别加引号或空格；内容非法时会自动回退到 3980 并提示。

---

## 🗄️ 数据存储

采用 **SQLite**（Node 内置 `node:sqlite`，无需安装任何原生模块），数据库文件：

```
data/tvbox.db        主库（配置源、收藏、历史）
data/tvbox.db-wal    预写日志
data/tvbox.db-shm    共享内存索引
data/backups/        自动备份（最多 20 份）
```

### 备份与还原

数据库位于 `data/tvbox.db`，所有备份放在 `data/backups/`。

**自动备份**（保留最新 **5** 份，超出自动清理）：

| 时机 | 文件名 |
|---|---|
| 每次启动（库非空） | `tvbox-auto-startup-<时间>.db` |
| 清空收藏前 | `tvbox-auto-before-clear-favorites-<时间>.db` |
| 清空历史前 | `tvbox-auto-before-clear-history-<时间>.db` |
| 执行「初始化」前 | `tvbox-auto-before-reset-<时间>.db` |
| 每次还原前 | `tvbox-auto-before-restore-<时间>.db` |

**手动备份**（`tvbox-manual-<时间>.db`）：**永不自动删除**，需要自己删。

界面操作：顶栏 **「备份」** 按钮 → 面板里可以

- **＋ 新建备份**：立即生成一份手动备份
- **还原**：用该备份覆盖当前数据（还原前会自动再存一份，防还原错）
- **删除**：删掉指定备份文件

还原走的是「关闭连接 → 覆盖主库 → 清除 WAL → 重新打开」，不需要重启服务，页面刷新后即为还原后的数据。

**命令行方式**（服务未启动时）：

```powershell
cd D:\Projects\tvbox-pc
Get-Process node | Stop-Process
copy data\backups\tvbox-manual-20261106-225903.db data\tvbox.db
Remove-Item data\tvbox.db-wal, data\tvbox.db-shm -ErrorAction SilentlyContinue
node server.js
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

### 兼容模式（转封装）的资源占用

转封装用 `ffmpeg -c copy`，**不重新编码**，所以 CPU 占用天然很低。
如果仍想进一步压低，可用环境变量调节（启动前设置，或写进系统环境变量）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `REMUX_MAX` | `2` | 同时最多几路转封装（1~6）。同一时间只会播一个流，拖进度时会短暂出现第二路 |
| `REMUX_PRIORITY` | `below_normal` | ffmpeg 进程优先级：`idle` / `below_normal` / `normal` |
| `REMUX_THREADS` | `auto` | 传给 ffmpeg 的 `-threads`。**对 `-c copy` 基本无影响**（没有编解码线程可分配） |

当前生效的配置可在 `GET /api/remux/status` 查看：

```json
{ "active": 1, "max": 2, "threads": "auto", "priority": "below_normal" }
```

### 提示「libmpv-2.dll 加载失败」怎么办

按顺序排查：

1. **解除网络锁定**：右键 zip → 属性 → 勾选「解除锁定」再解压
2. **跑体检脚本**：双击 `修复运行环境.bat`
3. **装 VC++ 运行库**（若体检提示缺少；**安装包已随包提供**在 	ools\VC_redist.x64.exe，
   体检脚本会直接调用它，无需联网）：

   - x64：https://aka.ms/vs/17/release/vc_redist.x64.exe （24.4 MB，微软官方）
   - x86：https://aka.ms/vs/17/release/vc_redist.x86.exe
   - 官方说明：https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist

4. 仍失败：确认杀软没有删除 `native\lib\vulkan-1.dll`
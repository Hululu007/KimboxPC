# AGENTS.md

KimBoxPC 是一个 **Windows 专用的 TVBox / FongMi 协议桌面播放客户端**：Electron 外壳 + 本机 Express 服务 + libmpv 原生渲染模块 + 单文件前端。

面向单人本机使用，**没有多用户、没有云端、没有构建流水线**。改动要能直接双击 `.bat` 跑起来。

> **硬性纪律：每次改动都必须 git commit。** 任何代码、文档或版本号变更完成后立即提交（哪怕只有一行、哪怕还没验证完），保证任何时刻都能回滚。禁止把多处不相关改动攒成一个大提交，也禁止改完不提交就交付。

---

## 1. 运行与构建

| 场景 | 命令 |
| :--- | :--- |
| 只跑后端 + 浏览器调试 | `npm start`（=`node server.js`，打开 http://127.0.0.1:3980/） |
| 跑完整桌面版 | `npm run app`（=`electron .`，会内嵌启动同一个 server.js） |
| 用户实际启动方式 | 双击 `KimBoxPC-桌面版.bat`（或桌面快捷方式） |
| 重新编译原生模块 | 双击 `tools\编译原生模块.bat`（**不要**用 `npm run build:native` 直接跑，需 `ELECTRON_RUN_AS_NODE=1` 用 Electron 自带的 node） |
| 打包便携版 zip | 双击 `打包发布.bat` → `tools\打包发布.ps1`，输出到**上级目录** `KimBoxPC_v<version>.zip` |
| 修环境（VC++ / 文件解锁 / 校验 dll） | 双击 `修复运行环境.bat` |

要求：Node ≥ 22.5（用到 `node:sqlite`）、Windows x64、VC++ 2015-2022 运行库。项目无 npm `build`、无 lint、无测试框架。

**端口**：`process.env.PORT` > `port.txt` > `3980`。`server.js` 与 `electron/main.js` **各自实现了一份 `readPort()`**，改规则必须两边同步。服务只监听 `127.0.0.1`，不支持局域网访问。

---

## 2. 架构

```
KimBoxPC-桌面版.bat
└─ electron.exe  →  electron/main.js（Electron 主进程）
   ├─ require('./server.js')            同进程内嵌 Express（127.0.0.1:3980）
   │  ├─ configParser.js                TVBox/FongMi 配置解析（base64 / ** 加密 / 站点归一化）
   │  ├─ cmsEngine.js                   CMS 采集站（苹果CMS ac=list|videolist|detail）请求与字段清洗
   │  ├─ db.js                          node:sqlite（DatabaseSync）仓储 + 备份/还原
   │  └─ playerLauncher.js              探测并拉起 PotPlayer / VLC / mpv / MPC-HC / ffplay
   ├─ native/build/Release/mpv_native.node   libmpv 渲染桥（N-API，动态 LoadLibrary libmpv-2.dll）
   └─ BrowserWindow → http://127.0.0.1:3980/
      └─ public/index.html              整个前端（HTML + CSS + JS 单文件，~4900 行）
         └─ window.kimbox（electron/preload.js 暴露的唯一 IPC 通道）
```

- **前端没有任何打包步骤**：`public/index.html` 是手写单文件，CSS 与 JS 都内联在 `<script>` 里，配 `public/vendor/hls.min.js`、`public/vendor/mpegts.js`。改完刷新窗口即可，不需要 build。
- **播放链路**：libmpv（`MPV_RENDER_API_TYPE_SW`）→ 内存帧 → IPC `mpv:frame` → `<canvas>`；音频由 mpv 直连声卡，**不经过浏览器 MSE**。约 30fps（33ms 间隔）推帧。
- **双内核**：默认 `mpv` 内核；`ffmpeg (兼容)` 内核走 `/api/remux`（`ffmpeg -c copy` 转 MPEG-TS 直出给 hls/mpegts.js），用来规避 HLS `DISCONTINUITY` 时间戳重置导致的音频变调。
- **播放列表代理**（`/api/hls`）：开启广告拦截时，前端不再把 CDN 地址直接交给播放器，而是让本地服务拉一次 m3u8、把分片与 `URI="..."` 改写成绝对地址后缓存，再用 `/api/hls/<token>.m3u8` 喂给播放器 —— 这样「分析用的列表」和「播放用的列表」是同一份字节。原因：部分 CDN 每次请求插播的广告位置都不同（实测同一地址连拉 4 次得到 4 组时长序列），先分析后播放会错位。代理失败才退回直连 + `/api/ads`。
- **运行状态是模块级单例**：`server.js` 顶部的 `state`（configId / url / sites / activeSite / sitesVersion）。单进程单用户假设贯穿全局，不要引入需要多实例并发的写法。

### 数据落盘

```
data/                     全目录被 .gitignore，是用户真实数据
├─ tvbox.db               config / history / favorite / show_mark（WAL）
├─ backups/               tvbox-auto-*.db（只留最新 5 份）、tvbox-manual-*.db（永不自动删）
├─ cache/config_<id>.json 配置源本地快照（0ms 冷启动 + 远程热更新）
├─ boss-key.json          摸鱼键配置
├─ window-state.json      窗口尺寸/位置
├─ app.log                主进程+渲染进程日志（>512KB 轮转成 app.log.1）
└─ .server.pid            进程号（退出时清理）
```

备份一律用 `VACUUM INTO`（`db.js: backup()`）；还原前会先自动备份一次；文件名必须匹配 `^tvbox-[A-Za-z0-9._-]+\.db$` 防目录穿越。

---

## 3. 关键机制（改之前先读）

- **配置源 0ms 秒开 + 热同步**（`server.js` `applyConfig()`）：先用 `data/cache/config_<id>.json` 立刻填充 `state.sites`，再后台拉远程；指纹（`key:api:name` 拼接）变化才 `state.sitesVersion = Date.now()`。`/api/configs/:id/sync` 是强制同步。切换站点时**优先保持当前活跃站点**（`stillActive`），不要退回第一站。
- **跨站聚合搜索**（`/api/search/all`、`/api/sources`）：固定并发（8 / 6）+ 单站 9s 超时，片名用 `normName()`（去零宽字符、控制字符、标点、小写）后合并同名，保留首个并按来源数排序。前端用自增序列号丢弃过期响应。
- **广告跳过**（`server.js analyzeAdRanges()` + 前端 `maybeSkipAd()`）：不改播放列表，只算区间。把 m3u8 按 `#EXT-X-DISCONTINUITY` 切块，挑「夹在两侧长正片之间、5~90 秒、1~30 片」的短块；命中数 >6 或广告总时长 >5% 就整体放弃（更可能是整集切片）。区间按**正片 PTS 累计**（广告段不计入）计算，返回 `[start, end, target]`，**`target` 必须是 `end + 0.4`（广告块之后），绝不能落在 `[start, end)` 内**——否则 seek 回来还在广告里，每轮轮询都重新命中，界面会无限弹「已跳过广告」。首尾块另按「与已识别广告相同的分片数 + 时长」特征匹配，仅当特征一致才认定（避免误切片尾字幕）；片尾广告的区间带第 4 项标记 `1`，前端对它直接跳 `duration - 0.5`（此处显示时间轴与 PTS 已错位，按时长累加算出的目标点会被 mpv 忽略）。前端另有单段锁 `adSkipLocked` 兜底。**这个 PTS 假设是整个算法的地基**，改切块或计时逻辑前先想清楚时间轴。
- **mpv 时间轴偏移**（`electron/main.js` `mpv:state`）：mpv 的原始 `time-pos` 跨 `DISCONTINUITY` 会回零，而 UI 需要绝对秒数，所以维护 `timeOffset`（跳变 >15s 且不在自 seek 豁免期内才更新）。另用 `lastKnownPosition` 记忆最远位置，`ended` 必须同时满足「eof/idle」+「位置接近结尾 30s 内」，否则中途插播会被误判为播完而跳下一集。
- **安全边界**：配置源 URL、`ext`、m3u8 内容都来自第三方。所有网络请求带桌面 UA、有超时；`innerHTML` 写入前必须 `escapeHtml()`；备份/还原路径必须过校验；日志里**不要打印完整配置源地址**（已有先例：只打 `name` 或 hostname）。

---

## 4. 代码约定

- **语言**：界面文案、注释、提交信息、更新日志全部用中文；标识符用英文。变量/函数用 camelCase，DOM id 用 camelCase，CSS 类用 kebab-case。
- **前端**：单文件、无框架、事件绑在内联 `onclick` 或 `addEventListener`。新增一块 UI 时，沿用文件里已有的分区注释格式（`/* ==================== 标题 ==================== */`）并追加到对应区域。localStorage 键统一前缀 `tvbox_`（`tvbox_engine`、`tvbox_adfilter`、`tvbox_cache`、`tvbox_bosskey` 等）。
- **后端**：Express 路由集中在 `server.js`，按 `/* ==================== 标题 ==================== */` 分段；数据访问只经 `db.js` 的 `*Repo`，不要在路由里直接写 SQL。新增表要同时改 `openDb()` 的建表语句和 `migrate()`（旧库用 `ALTER TABLE` 补列，保持向后兼容）。
- **错误处理风格**：本项目的容错大量使用 `try/catch` 静默兜底（`catch (e) {}`），对外用 `res.status(4xx/5xx).json({ error })` 把原因带回前端，由 `showToast()` 展示。
- **注释**：解释「为什么」（尤其是竞态、时序、协议怪癖），不要复述代码。
- **提交（强制）**：每完成一处改动就单独 `git commit`，不要把多个不相关改动攒成一个提交，也不要改完不提交。信息用 `fix:` / `feat:` / `docs:` / `style:` 前缀 + 中文摘要，正文写清「根因 / 改动点 / 怎么验证」，方便事后 `git log` 定位与回滚。回滚优先 `git revert <hash>`（保留历史）；只回退某个文件用 `git checkout <hash> -- <file>`。`data/`、`*.lnk`、`native/build|lib`、`tools/*.exe` 一律不入库。

---

## 5. 陷阱

1. **编码**：所有 `.bat` 是 **GBK/CP936**（`chcp 936`），用 UTF-8 工具改写会把中文变乱码；`.js` / `.md` / `.html` 是 UTF-8。`tools\打包发布.ps1` 里特意用 `[System.IO.File]::ReadAllText(..., UTF8)` 读 `package.json`，别改回 `Get-Content`（PS 5.1 会按 GBK 解码）。
2. **版本号两处必须同步**：`package.json` 的 `version` 与 `更新.md` 里最新的 `## [x.y.z]`。不一致时 `/api/version` 返回 `versionMismatch: true`，启动日志也会告警。发版流程 = 改版本号 → 写 `更新.md` → 打包。
3. **重复实现**：缓存清理逻辑（`CACHE_SUBFOLDERS` / `getAppCacheInfo` / `cleanFolderContents`）在 `server.js` 和 `electron/main.js` 各有一份，改一份要同步另一份。
4. **原生模块 ABI**：`mpv_native.node` 必须针对 Electron 45 的 ABI 编译（`--target=45.2.3 --dist-url=https://electronjs.org/headers`），换 Electron 版本必须重编。加载前会把 `native\lib` 塞进 `PATH`，否则 `vulkan-1.dll` 找不到。
5. **仓库不完整可跑**：`.gitignore` 排除了 `data/`、`node_modules/`、`native/lib/`、`native/build/`、`ffmpeg/`、`tools/*.exe`。干净 clone 后缺 `libmpv-2.dll`、已编译的 `.node` 和 Electron 运行时，必须本机补齐后才能启动。
6. **不要碰用户数据**：`data/tvbox.db*` 是用户真实配置、收藏与历史；测试时改用临时 `PORT` 另起实例，或先调 `/api/backup` 手动备份。
7. **单实例锁**：`electron/main.js` 用 `requestSingleInstanceLock()`，重复双击只是聚焦旧窗口；端口被占时 `server.js` 直接 `exit 1` 并提示改 `port.txt`（残留 `electron.exe` 是常见原因）。
8. **`public/index.html` 体量很大**：改动用 `grep`/定向 `read` 定位，不要整文件重写。

---

## 6. 验证方式

没有自动化测试，按改动面手工回归：

```powershell
# 1) 后端基本健康（另开一个 PORT 避免撞上正在运行的实例）
$env:PORT=3988; node server.js
Invoke-RestMethod http://127.0.0.1:3988/api/version     # version / changelogVersion / versionMismatch
Invoke-RestMethod http://127.0.0.1:3988/api/configs
Invoke-RestMethod http://127.0.0.1:3988/api/sites
Invoke-RestMethod http://127.0.0.1:3988/api/backups
Invoke-RestMethod http://127.0.0.1:3988/api/remux/status

# 2) 完整桌面链路
npm run app    # 首页加载 → 搜索 → 详情 → mpv 播放/拖动 → 切集 → 广告跳过 → 摸鱼键 → 退出无残留
```

- 播放相关改动：必须用真实片源试 **mpv 内核** 与 **ffmpeg 兼容内核**，并覆盖「拖动进度」「切线路」「播完自动下一集」「中途广告插播不误判为结束」。
- 排查闪退看 `data/app.log`；服务端日志在控制台，渲染进程日志经 `POST /api/log` 落到同一个文件。
- UI 改动在 Electron 窗口里确认（`window.kimbox` 存在），同时确认浏览器直连 `npm start` 时降级路径不报错。

---

## 7. 改动地图

| 想改什么 | 去哪里 |
| :--- | :--- |
| 新增后端接口 / 业务逻辑 | `server.js`（按注释分区归位） |
| 表结构 / 查询 / 备份还原 | `db.js` |
| 配置源字段解析与站点归一化 | `configParser.js` |
| CMS 采集站请求、字段清洗、线路拆分 | `cmsEngine.js` |
| 任何界面、交互、播放控制条、OSD | `public/index.html` |
| Electron 窗口、IPC、摸鱼键、帧推送 | `electron/main.js`、`electron/preload.js` |
| libmpv 渲染 / 解码参数 | `native/src/mpv_native.cpp`（改后需重编） |
| 外部播放器探测与拉起 | `playerLauncher.js` |
| 打包 / 环境修复 / 快捷方式 | `tools\*.ps1`、根目录 `.bat` |

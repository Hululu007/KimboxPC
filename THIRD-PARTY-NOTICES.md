# 致谢与第三方组件声明

KimBoxPC 站在很多开源项目的肩膀上。这里尽量完整地列出**随包分发的二进制**、**构建时使用的工具**、以及**协议/设计上的参考**，并注明各自的许可。若有遗漏或标注错误，欢迎提 Issue 指正。

> 本项目自身源码见本仓库；第三方组件的完整源码请到下列各自仓库/官网获取。

---

## 一、运行时与 Web 框架

| 组件 | 用途 | 许可 | 来源 |
| :-- | :-- | :-- | :-- |
| [Electron](https://github.com/electron/electron) 45 | 桌面外壳（Chromium + Node.js） | MIT | 随包 `node_modules/electron` |
| [Node.js](https://github.com/nodejs/node) | 本地服务运行时 | MIT | 由 Electron 内置 |
| [Express](https://github.com/expressjs/express) 5 | 本地 HTTP 服务（127.0.0.1:3980） | MIT | npm |
| [axios](https://github.com/axios/axios) | 服务端 HTTP 请求 | MIT | npm |
| [cors](https://github.com/expressjs/cors) | 本地接口跨域 | MIT | npm |

## 二、播放内核与多媒体

| 组件 | 用途 | 许可 | 来源 |
| :-- | :-- | :-- | :-- |
| [mpv](https://github.com/mpv-player/mpv) / libmpv **v0.42.0** | 默认播放内核（`native\lib\libmpv-2.dll`，软件渲染到 canvas） | GPLv2+（libmpv 亦可 LGPLv2.1+，取决于构建） | 随包 |
| [FFmpeg](https://ffmpeg.org/) **9.0.2**（gyan.dev essentials build，`--enable-gpl --enable-version3`） | 兼容内核转封装（`ffmpeg\ffmpeg.exe`） | **GPLv3**（该构建启用了 GPL/version3） | 随包 |
| [Vulkan-Loader](https://github.com/KhronosGroup/Vulkan-Loader) | libmpv 的 Vulkan 依赖（`native\lib\vulkan-1.dll`） | Apache-2.0 | 随包 |
| [hls.js](https://github.com/video-dev/hls.js) | 网页内核（MSE）播放 HLS | Apache-2.0 | `public\vendor\hls.min.js` |
| [mpegts.js](https://github.com/xqq/mpegts.js) | 兼容内核播放 ffmpeg 转出的 MPEG-TS | Apache-2.0 | `public\vendor\mpegts.js` |

## 三、虫包站源（JVM 解析层）

虫包（TVBox `type:3` dex 站源）的支持来自 **xiugou-tv** 的 JVM 运行时，本项目**未修改其代码**，只作为独立进程调用：

| 组件 | 用途 | 许可 | 来源 |
| :-- | :-- | :-- | :-- |
| [xiugou-tv](https://github.com/KuekHaoYang/xiugou-tv) | android-bridge、加固壳解包、HTTP RPC 服务（`jvm\companion-service.jar`） | **GPLv3** | 上游 v1.12.5 构建产物 |
| [OpenJDK](https://openjdk.org/) 21（jlink 裁剪） | 运行上述 JVM 服务（`runtime\jre`） | GPLv2 + Classpath Exception | 随包 |
| [dex2jar](https://github.com/pxb1988/dex2jar) 2.4.31 | 把 dex 虫包转成 JVM 可加载的 class | Apache-2.0 | 已打包进 companion-service.jar |
| [Bouncy Castle](https://www.bouncycastle.org/) 1.78.1 | 对齐 Android 的加解密语义（AES/CBC/PKCS7 等） | Bouncy Castle License（MIT 风格） | `jvm\bcprov-jdk18on-1.78.1.jar` |
| [unidbg](https://github.com/zhkl0228/unidbg) 0.9.9 | ARM 模拟，执行加固壳的 `.so` 完成解密 | Apache-2.0 | `jvm\lib-unidbg` |
| [unicorn](https://github.com/unicorn-engine/unicorn) / [keystone](https://github.com/keystone-engine/keystone) / [capstone](https://github.com/capstone-engine/capstone) | unidbg 依赖的 CPU 模拟/汇编/反汇编引擎 | GPLv2 / GPLv2 / BSD | 随 unidbg 依赖 |
| [OkHttp](https://github.com/square/okhttp) / [Okio](https://github.com/square/okio) | 站源网络请求（含 HTTP 日志钩子） | Apache-2.0 | 已打包进 jar |
| [Gson](https://github.com/google/gson) / [fastjson](https://github.com/alibaba/fastjson) | JSON 序列化 | Apache-2.0 | 已打包进 jar |
| [jsoup](https://jsoup.org/) | HTML 解析（网页类站源） | MIT | 已打包进 jar |
| [ICU4J](https://github.com/unicode-org/icu) | 字符集/编码处理 | Unicode License | 已打包进 jar |
| [NanoHTTPD](https://github.com/NanoHttpd/nanohttpd) | 进程内 HTTP 服务 | BSD-3-Clause | 已打包进 jar |
| [GraalVM Polyglot / Truffle](https://github.com/oracle/graal) | 运行站源里的 JS 片段 | UPL-1.0 | 已打包进 jar |
| [JNA](https://github.com/java-native-access/jna) / [apk-parser](https://github.com/hsiafan/apk-parser) / [slf4j](https://www.slf4j.org/) | 原生调用 / APK 解析 / 日志 | Apache-2.0 / Apache-2.0 / MIT | 随 unidbg 依赖 |

> 以上 JVM 侧组件均由上游 xiugou-tv 统一打包，本项目只做进程管理与协议适配（`jvmBridge.js`、`spiderEngine.js`）。

## 四、协议与设计参考

- **[TVBox](https://github.com/q215613905/TVBoxOS) / [FongMi](https://github.com/FongMi/TV)**：配置源格式、站点类型（`type` 0/1/3）、`homeContent`/`categoryContent`/`detailContent`/`playerContent`/`searchContent` 接口规范与 `spider` jar 机制，本项目均按该协议实现。
- **[CatVodSpider](https://github.com/FongMi/TV)（`com.github.catvod`）**：虫包依赖的父类与工具契约。
- **广告识别思路**：按 `#EXT-X-DISCONTINUITY` 切块、按正片 PTS 累计计算区间，为本项目自研（`server.js analyzeAdRanges()`），实现中参考了社区对 TVBox 广告插播的讨论。

## 五、打包与开发工具（不随源码分发）

| 工具 | 用途 | 许可 |
| :-- | :-- | :-- |
| [Inno Setup](https://jrsoftware.org/isinfo.php) 6 | 生成安装版 `*_Setup.exe` | Inno Setup License（免费，可商用） |
| [Microsoft Visual C++ Redistributable](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist) | 运行库（`tools\VC_redist.x64.exe`） | Microsoft 可再分发组件 |
| [7-Zip](https://www.7-zip.org/) | 开发期解包/核对（不随包） | LGPL-2.1+ |

## 六、内容与数据

- 影视海报、剧集信息、播放地址均来自**用户自行配置的第三方接口**，本项目不存储、不托管任何影视内容；相关版权归原权利人所有。
- 图标与其他素材如涉及第三方版权，请告知，我们会替换或补充署名。

---

## 关于 GPL 合规

随包分发的 **FFmpeg 二进制（GPLv3）** 与 **xiugou-tv 的 JVM 运行时（GPLv3）** 属于 GPL 组件：

- 本项目**未修改**这两个组件的源码（xiugou-tv 为原样构建产物；FFmpeg 为 gyan.dev 官方构建）；
- 如需再分发本项目的安装包/便携包，请一并提供上述组件的**源码获取方式**：
  - FFmpeg：<https://ffmpeg.org/download.html>（以及构建脚本 <https://www.gyan.dev/ffmpeg/builds/>）
  - xiugou-tv：<https://github.com/KuekHaoYang/xiugou-tv>（v1.12.5，commit `f8858b5`）
- 本项目自身代码以本仓库公开形式提供，便于满足 GPL 的源码可获取要求。

---

再次感谢上述项目的作者与维护者。如果这个列表漏掉了你，或署名/许可写错了，请提 Issue，我们会尽快更正。

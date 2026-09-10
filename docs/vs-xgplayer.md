# live-sdk vs 西瓜播放器（xgplayer）对比分析

> 对比对象：`bytedance/xgplayer` @ v3.0.26（main 分支，2026-09 抓取）
> 分析维度：技术选型 / API 设计 / 工程架构
> 数据来源：xgplayer 仓库源码（shallow clone，含 `packages/*/src`）、GitHub Issues、本项目 spec（`../../docs/live-sdk-spec.md`）

**本文档定位：帮助你在两者之间做选型。** 因此只讲「差异是什么、意味着什么」，不做「谁更好」的评判——两者不是同一物种，选型应由你的业务场景决定。

## 一句话结论

| | live-sdk | xgplayer |
|---|---|---|
| **定位** | 垂直：H5 **直播**播放器 SDK，headless 内核 + 插件化 | 平台：通用 Web 播放器**全家桶**，VOD/Live/音乐/字幕/弹幕/投屏全覆盖 |
| **体量** | 24 个 `.ts`，**2561 行** | 16 个包，核心包 `xgplayer` 单包 **21371 行**，全仓 **~5.5 万行** |
| **优势** | 架构干净、状态契约显式、职责边界清晰、可读性强 | 能力全面、久经字节亿级 DAU 打磨、协议/容器/编解码/端适配覆盖面极广 |
| **代价** | 能力域窄（无点播/DRM/弹幕/字幕/FLV/DASH）、端适配深度浅 | 耦合重、体积大、headless 不彻底（UI 与播放器实体强绑定）、状态模型隐式 |

**一句话选型**：

- **只需要 H5 直播、想要干净可控的内核、要自绘 UI 或跨端复用** → 选 **live-sdk**。
- **需要直播 + 点播 + 回放 + 弹幕/字幕/投屏，或要覆盖 FLV/DASH/端适配全家桶** → 选 **xgplayer**。

> 具体哪些能力是 live-sdk 的**主动边界收缩**，见 [README 能力边界](../README.md#能力边界non-goals)。

---

## 1. 技术选型对比

### 1.1 总览

| 维度 | live-sdk | xgplayer | 评价 |
|---|---|---|---|
| **协议** | 仅 **HLS**（单协议） | HLS / **FLV** / DASH / MP4（渐进式）/ WebSocket-MP4，均有独立内核包 | xgplayer 覆盖广；live-sdk 以「单协议做深」换架构简洁 |
| **容器** | **fMP4**（CMAF），走 LL-HLS `EXT-X-PART` | 自研 demux/remux（TS/fMP4/FLV 全支持） | xgplayer 自研 `xgplayer-transmuxer`（8633 行）——代价是维护面巨大 |
| **播放内核** | **hls.js**（npm 锁版本，业界成熟库） | **自研**（hls/flv/dash 三套内核 + 共享 `streaming-shared`） | 两条路线：借力成熟库 vs 自研可控。自研换来 LL-HLS 精细调优能力，也带来大量内核级 issue |
| **UI 架构** | **Headless**：内核不创建可见 DOM，只暴露「状态/命令/事件」三契约 | **UI 内建**：`Player extends MediaProxy`，控件以插件形式挂在播放器实体上 | live-sdk 更适合自绘/多端复用；xgplayer UI 开箱即用但难剥离 |
| **状态模型** | **显式状态机**：`idle→loading→ready→playing→paused→stalled→error→ended`，表驱动 | **状态常量 + class 名**：`INITIAL/READY/ATTACHING/ATTACHED/NOTALLOW/RUNNING/ENDED/DESTROYED`，靠 `addClass/removeClass` 驱动 | live-sdk 的状态可枚举、可断言；xgplayer 的状态与 DOM class 耦合 |
| **点播支持** | ❌ **不支持**（Non-Goal，仅 HLS 点播流） | ✅ 一等公民（`isLive=false`、`seek`、`replay`、`playNext`、渐进式 MP4） | **用户明确举例的技术选型差异**，详见 §1.2 |
| **倍速** | ❌ **不提供**（`playbackRate` 已从契约移除） | ✅ 倍速面板 + 直播下用「动态倍速纠偏」对齐延迟 | 两者语义**完全不同**：xgplayer 的直播倍速是**内部纠偏手段**（微调以追平 live edge），不是给用户的操作；live-sdk 不给用户暴露倍速，纠偏交给 hls.js 的 `targetLatency` |
| **DRM** | ❌ 划出边界（`client='absent'`） | ⚠️ `ErrorTypes.drm` 预留，另有 `xgplayer-shaka` 包承接 | 两者都非强项，但 xgplayer 有扩展位 |
| **低延迟** | LL-HLS（fMP4）+ `targetLatency`/`maxLatency` 透传 hls.js | 自研 LL-HLS（`useLowLatency`、`targetLatency`、`mseLowLatency`、`preferMMS`）+ gap jump + 动态倍速纠偏 | xgplayer 更细（自研可控）；live-sdk 依赖 hls.js 实现 |
| **端回退** | `NativeKernel`（Safari 原生 HLS） | MSE→native 自动降级、MMS（iOS ManagedMediaSource）、AirPlay/Cast（`xgplayer-cast`） | xgplayer 端适配深度远超 live-sdk |
| **解码** | 交给浏览器 | 软/硬解切换（`softDecode`）、H.265 软解回退、G.711 音频补齐 | 自研内核才能做到；live-sdk 受限于浏览器能力 |
| **语言/构建** | **TypeScript** + Vite + esbuild | **JavaScript**（JSDoc 类型）+ 自研 `libd` 构建（rollup/babel） | live-sdk 类型即文档；xgplayer ESLint/Biome + JSDoc |

### 1.2 「不支持点播」是技术选型差异——但不是缺陷

用户特别点出「例如不支持点播模式」。需要精确区分：

| | 结论 |
|---|---|
| **事实** | live-sdk spec §1.3 明确将「渐进式点播文件（普通 `.mp4`）」列为 Non-Goal；点播场景**仅**支持 HLS 点播流（`isLive=false` 语义） |
| **性质** | 这是**主动的边界收缩**，不是能力缺失的 bug |
| **根源** | ① 定位为「直播 SDK」；② 选型 hls.js 单引擎，不做渐进式 MP4 的 range 请求/分片加载；③ fMP4 容器与「完整 MP4 文件」是两回事（spec 已澄清） |
| **后果** | ✅ 架构更瘦、状态机更简（无 seek/replay/playNext 的 VOD 分支）；⚠️ 若业务需要「直播 + 回放 + 点播短视频」一体，必须再挂一个 VOD 内核或换库 |
| **xgplayer 反证** | xgplayer 的 `xgplayer-mp4` / `xgplayer-mp4-new` / `xgplayer-mp4-loader`（合计 ~3600 行）专为渐进式 MP4，且**恰是 issue 重灾区**（#1910/#1911/#1872/#1830：大文件 OOM、引入后无法播放、拖拽报错）——说明 VOD 不是「顺手支持」的，是实打实的复杂度成本 |

> **建议**：把「不支持点播」在 spec 中从「Non-Goal」升级为「**技术选型的显式代价**」，并给出扩展路径（挂 `DashKernel`/VOD 内核 or 换 mpegts.js）。理由：Non-Goal 读起来像「暂时不做」，而真相是「与 headless 单内核架构存在张力」。

### 1.3 选型差异导致的 issue 类型对照

| issue 主题 | xgplayer 是否遇到 | live-sdk 是否可能遇到 | 说明 |
|---|---|---|---|
| 自研 demux 解析异常（HEVC/异常流） | ✅ 高频（#1897 H265 只播最后片段、#1845 mkv 音轨） | ❌ 不太可能 | hls.js 承担了 demux，风险外包给成熟库 |
| MSE 生命周期管理（object URL 泄漏） | ✅ #1945（unbind 早于 sourceopen 时 URL 未 revoke） | ⚠️ **可能**（已修复） | hls.js 内部管理，但 `destroy()`/`switchURL()` 的 blob 源释放需自查 |
| 渐进式 MP4 大文件 OOM | ✅ #1910 #1911 | ❌ 不适用（不支持点播） | 选型差异 → 风险天然规避 |
| 软/硬解与编解码兼容 | ✅ #1865 H265 无硬解无法播、#1854 G711 无声 | ⚠️ 依赖浏览器，无自解能力 | live-sdk 无解码栈，能力上限即浏览器上限 |
| LL-HLS 精细调优 | ✅ 自研可控（`mseLowLatency` 等） | ⚠️ 受 hls.js 配置面约束 | 选型差异：可控性 vs 稳定性 |

---

## 2. API 设计对比

### 2.1 初始化与调用风格

| | live-sdk | xgplayer |
|---|---|---|
| **初始化** | `createPlayer({ container, url, kernel, preset, hlsConfig })` —— 工厂函数，显式注入内核 | `new Player({ id, url, ... })` —— 类构造，内核由 `presets`/`ignores` 隐式决定 |
| **内核选择** | 显式：`kernel: HlsKernel`，缺省 sniffer 自动选 | 隐式：靠引入哪个插件包（`xgplayer-hls` / `xgplayer-flv`）自动注册 |
| **UI** | 完全外置（`live-sdk/ui` 独立包），可不用 | 内建，`preset` 决定挂哪些控件 |
| **命令** | `play(config?)` / `pause()` / `seek(t)` / `switchURL(url)` / `switchQuality(id)` / `mute()` / `report()` | `play()` / `pause()` / `seek()` / `switchUrl()` / `switchDefinition()` / `retry()` / `replay()` / `destroy()` |
| **状态查询** | `getState()` 返回快照对象（`playing` 等语义字段） | 直接读实例属性（`player.paused` / `player.currentTime`），状态散落 |
| **事件** | 统一点分号常量，`on/off/once`，含语义化事件（`first_frame`/`stalled`/`recovered`/`retry`） | 常量导出（`Events.PLAY` 等），**大量底层 media 事件直接透传**（`waiting`/`seeking`/`canplay`…） |
| **插件** | `registerPlugin/unregisterPlugin` + `BasePlugin` 生命周期 | `BasePlugin` + `Plugin` + `presets` + `ignores`，生态更成熟 |
| **Hooks** | `useHooks(name, fn)` | `useHooks` / `usePluginHooks` / `runHooks`（粒度更细，但 #1773 报过 hook 报错） |
| **扩展配置** | `hlsConfig` 透传（escape hatch） | 直接展开进 options，配置项数百个（文档不全，#1867 抱怨过） |

### 2.2 优势对照

| 维度 | live-sdk 更优 | xgplayer 更优 |
|---|---|---|
| **API 一致性** | ✅ 命令/状态/事件三契约统一，`getState()` 单一真源 | ❌ 状态散落实例属性，部分靠 DOM class |
| **语义清晰度** | ✅ `playIntent` 等业务语义显式建模 | ⚠️ 语义隐含在 `paused`/`ended` 属性 |
| **上手成本** | ✅ 配置项少、文档聚焦 | ⚠️ 配置项极多，文档滞后于源码 |
| **生态/示例** | ❌ 无 | ✅ 官方文档站、大量 fixtures demo、多语言 i18n（15 种语言） |
| **能力完备** | ❌ 无弹幕/字幕/投屏/截图/画中画等 | ✅ 全都有现成插件 |
| **二次开发** | ✅ headless，易对接自绘 UI / RN / 小程序 | ⚠️ UI 内建，深度定制需绕开内建控件 |

### 2.3 关键 API 设计差异：状态呈现（与本次重连 bug 直接相关）

| | live-sdk | xgplayer |
|---|---|---|
| **状态载体** | `getState().playing` 语义快照 + `SessionState` 状态机 | 读 `media.paused` 等原生属性 + 状态 class |
| **断流重连时按钮语义** | **显式建模 `playIntent`**：重连中 `playing` 保持 true，用户暂停被尊重 | 无此概念；靠 `mediaPlay()` 在 `CANPLAY` 后重播（`retry()` 实现见源码），按钮态与真实缓冲态易错位 |
| **风险** | 需自己维护意图与媒体态的同步（已通过 43 项 smoke 覆盖） | #1837 实测「播放/暂停反复切换」——正是重连期状态呈现失控的典型症状 |

> xgplayer `retry()` 实现：
> ```js
> retry () {
>   this.removeClass(STATE_CLASS.ERROR); this.addClass(STATE_CLASS.LOADING)
>   runHooks(this, 'retry', () => {
>     const cur = this.currentTime
>     const { url } = this.config
>     this.src = !Util.isMSE(this.media) ? this.preProcessUrl(url).url : url
>     !this.config.isLive && (this.currentTime = cur)
>     this.once(Events.CANPLAY, () => { this.mediaPlay() })   // ← 只等 CANPLAY，不还原「意图」
>   })
> }
> ```
> 无 `playIntent` 概念：重试成功后**无条件** `mediaPlay()`——若用户重连期间按了暂停，会被强行续播（与 live-sdk 修复前的隐患同源，但方向相反）。

---


## 3. 工程架构对比

### 3.1 仓库与包结构

| | live-sdk | xgplayer |
|---|---|---|
| **仓库形态** | 单包（`live-sdk/`），内部按 `src/{core,kernel,ui,adapters,plugins,reporter,env,utils}` 分层 | **Yarn workspaces monorepo**，`packages/*` 16 个独立发布包 |
| **包数量** | 1 个 npm 包（多入口：`.` / `./ui` / `./react` / `./vue`） | 16 个包，独立版本、独立发布 |
| **分层** | core / kernel / ui / adapters / themes(规划) / utils | core(`xgplayer`) / 各协议内核 / `streaming-shared` / `transmuxer` / 功能插件包 |
| **构建** | Vite + esbuild + tsc（声明文件），ESM + UMD | 自研 `libd` CLI（rollup + babel + dts-bundle-generator），ESM + UMD + legacy |
| **类型** | 原生 TypeScript | JavaScript + JSDoc（`tsconfig` 仅做检查） |
| **Lint** | ESLint + Prettier | Biome + husky + lint-staged |
| **单测** | Vitest（规划）+ Playwright E2E（规划）；当前 `verify/` 手写 smoke（43 项） | **Jest**（jsdom），55 个 `.spec.js`，覆盖 hls/flv/dash/transmuxer/cast/subtitles |
| **发布** | 语义化版本，内部 npm + CDN | 语义化版本，npm 公开发布，含 prerelease 流程 |
| **体积** | 极简（2561 行） | 核心包单包即 21371 行，全仓 ~5.5 万行 |

### 3.2 架构优劣

| 维度 | live-sdk | xgplayer |
|---|---|---|
| **职责边界** | ✅ 三契约（状态/命令/事件）清晰，headless 彻底 | ⚠️ UI 与播放器实体耦合（`Player extends MediaProxy`，控件即插件） |
| **可测试性** | ✅ 状态机可单测全路径；verify 契约化 | ✅ 有 Jest 体系，但状态散落、媒体依赖 mock 重 |
| **可扩展性** | ✅ 内核可插拔（协议无关），插件化 | ✅ 插件生态成熟（弹幕/字幕/投屏/音乐…） |
| **维护面** | ✅ 小（2561 行） | ⚠️ 大（5.5 万行 + 16 包），issue 积压（大量 Stale） |
| **生态成熟度** | ❌ 从零起盘 | ✅ 字节亿级 DAU 验证，文档站 + fixtures demo |
| **端适配深度** | ⚠️ 仅 Web + Safari 回退 | ✅ iOS/Android WebView/大屏/TV/微信/投屏全覆盖 |
| **可观测性** | ✅ 内建 `Reporter`（Console/Sentry）+ `RetryDiagnostic` + `getStats()` | ⚠️ 有 `stats`/`logger`/`fpsDetect` 插件，但无统一上报契约 |

### 3.3 xgplayer 的工程债（对 live-sdk 的警示）

| 现象 | 证据 | live-sdk 应避免 |
|---|---|---|
| **issue 积压 + Stale 化** | 大量 issue 被标 `Stale`/`need info` 后关闭（#1873/#1865/#1849/#1820…） | 建立明确的「问题响应 SLA」，避免「无人跟进型关闭」 |
| **文档滞后源码** | #1867：`mobile` 插件有 `miniYPer`/`closedbClick` 等配置项但文档没有 | 文档与源码同仓、CI 校验配置项导出 |
| **配置项爆炸** | 数百个 options，`ignores`/`presets` 组合复杂 | 保持配置面收敛，用 `hlsConfig` escape hatch 而非无限加参数 |
| **包间耦合/循环** | #1813：注销 flv 插件后注册 hls 无效（内核注册状态管理问题） | 内核用显式注入（`kernel: HlsKernel`），而非全局注册表 |
| **自研栈维护成本** | `transmuxer` 8633 行、三套内核并行 | live-sdk 借力 hls.js 是把这层成本外包，需持续跟踪上游版本（#1861 chromium140 需升 hls.js） |

---

